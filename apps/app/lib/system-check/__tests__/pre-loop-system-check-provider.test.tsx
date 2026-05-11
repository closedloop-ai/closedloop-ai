import { ComputePreference } from "@repo/api/src/types/compute-target";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeTargetKeys } from "@/hooks/queries/use-compute-targets";
import { healthCheckOptions } from "@/lib/engineer/queries/health-check";
import { PLUGIN_AUTO_UPDATE_FEATURE_FLAG_KEY } from "../plugin-auto-update";
import { getPreLoopTargetKey, PreLoopCommand } from "../pre-loop-health-check";
import {
  PreLoopSystemCheckProvider,
  usePreLoopSystemCheckGate,
} from "../pre-loop-system-check-provider";

const mockCapture = vi.hoisted(() => vi.fn());
const mockWarning = vi.hoisted(() => vi.fn());
const mockUseComputePreference = vi.hoisted(() => vi.fn());
const mockUseComputeTargets = vi.hoisted(() => vi.fn());
const mockUseLatestElectronRelease = vi.hoisted(() => vi.fn());
const mockApiGet = vi.hoisted(() => vi.fn());
const mockHealthCheckDialogRender = vi.hoisted(() => vi.fn());
const mockUseFeatureFlag = vi.hoisted(() => vi.fn());
const mockUseUser = vi.hoisted(() => vi.fn());
const EXPECTED_MCP_URL = vi.hoisted(() => "https://mcp.closedloop.ai/mcp");

vi.mock("@repo/analytics/client", () => ({
  useAnalytics: () => ({
    capture: mockCapture,
    identify: vi.fn(),
    reset: vi.fn(),
  }),
  useFeatureFlag: (key: string) => mockUseFeatureFlag(key),
}));

vi.mock("@repo/auth/client", () => ({
  useUser: () => mockUseUser(),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    warning: mockWarning,
  },
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_MCP_SERVER_URL: EXPECTED_MCP_URL,
    NEXT_PUBLIC_POSTHOG_KEY: "test-posthog-key",
  },
}));

vi.mock("@/hooks/queries/use-compute-preference", () => ({
  useComputePreference: (...args: unknown[]) =>
    mockUseComputePreference(...args),
}));

vi.mock("@/hooks/queries/use-compute-targets", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/queries/use-compute-targets")
    >();
  return {
    ...actual,
    useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
  };
});

vi.mock("@/hooks/queries/use-electron-release", () => ({
  useLatestElectronRelease: (...args: unknown[]) =>
    mockUseLatestElectronRelease(...args),
}));

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => ({
    get: mockApiGet,
  }),
}));

vi.mock("@/components/engineer/HealthCheckDialog", () => ({
  HealthCheckDialog: ({
    initialData,
    latestVersionOverride,
    onCancel,
    onRecheckUnavailable,
    onResolvedAfterRecheck,
    targetKey,
  }: {
    initialData?: unknown;
    latestVersionOverride?: string | null;
    onCancel: () => void;
    onRecheckUnavailable: (reason: string) => void;
    onResolvedAfterRecheck: () => void;
    targetKey?: string;
  }) => {
    mockHealthCheckDialogRender({
      initialData,
      latestVersionOverride,
      targetKey,
    });
    return (
      <div data-testid="blocking-dialog">
        <button onClick={onCancel} type="button">
          Cancel
        </button>
        <button onClick={onResolvedAfterRecheck} type="button">
          Resolved
        </button>
        <button onClick={() => onRecheckUnavailable("offline")} type="button">
          Recheck Unavailable
        </button>
      </div>
    );
  },
}));

const healthyResult = {
  checks: [{ id: "git", label: "Git", required: true, passed: true }],
  allRequiredPassed: true,
};

const failingResult = {
  checks: [{ id: "cli", label: "CLI", required: true, passed: false }],
  allRequiredPassed: false,
};

let preference = {
  preferredComputeMode: ComputePreference.Local,
  computeTargetId: "target-1",
};
const defaultTargets = [
  {
    id: "target-1",
    machineName: "Laptop",
    ownerName: null,
    isOnline: true,
    lastSeenAt: new Date("2026-05-04T15:00:00Z"),
    createdAt: new Date("2026-05-04T15:00:00Z"),
    updatedAt: new Date("2026-05-04T15:00:00Z"),
  },
  {
    id: "target-2",
    machineName: "Desktop",
    ownerName: null,
    isOnline: true,
    lastSeenAt: new Date("2026-05-04T15:01:00Z"),
    createdAt: new Date("2026-05-04T15:00:00Z"),
    updatedAt: new Date("2026-05-04T15:00:00Z"),
  },
];
let targets = defaultTargets.map((target) => ({ ...target }));

function GateHarness({
  execute,
  computeTargetId,
}: {
  execute: () => void;
  computeTargetId?: string;
}) {
  const gate = usePreLoopSystemCheckGate();
  let stateLabel = "idle";
  if (gate.isChecking) {
    stateLabel = "checking";
  } else if (gate.isDialogOpen) {
    stateLabel = "dialog";
  }

  return (
    <>
      <button
        disabled={gate.isChecking || gate.isDialogOpen}
        onClick={() => {
          gate
            .runWithPreLoopSystemCheck(
              {
                command: PreLoopCommand.ExecutePlan,
                documentId: "plan-1",
                documentType: "implementation_plan",
                ownerKey: "owner-1",
                computeTargetId,
              },
              execute
            )
            .catch(() => undefined);
        }}
        type="button"
      >
        Run
      </button>
      <button
        onClick={() => gate.cancelPendingPreLoopAttempt("owner-1")}
        type="button"
      >
        Cancel Owner
      </button>
      <div data-testid="state">{stateLabel}</div>
      <div data-testid="is-checking">{String(gate.isChecking)}</div>
      <div data-testid="is-dialog-open">{String(gate.isDialogOpen)}</div>
    </>
  );
}

function renderGate({
  queryClient,
  execute,
  computeTargetId,
}: {
  queryClient: QueryClient;
  execute: () => void;
  computeTargetId?: string;
}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <PreLoopSystemCheckProvider>
        <GateHarness computeTargetId={computeTargetId} execute={execute} />
      </PreLoopSystemCheckProvider>
    </QueryClientProvider>
  );
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

describe("PreLoopSystemCheckProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUser.mockReturnValue({ user: { id: "user-1" } });
    preference = {
      preferredComputeMode: ComputePreference.Local,
      computeTargetId: "target-1",
    };
    targets = defaultTargets.map((target) => ({ ...target }));
    mockUseComputePreference.mockImplementation(() => ({
      data: preference,
      refetch: vi.fn().mockResolvedValue({ data: preference, error: null }),
    }));
    mockUseComputeTargets.mockImplementation(() => ({
      data: targets,
      refetch: vi.fn().mockResolvedValue({ data: targets, error: null }),
    }));
    mockUseLatestElectronRelease.mockReturnValue({
      data: { version: "1.0.0" },
      refetch: vi.fn().mockResolvedValue({
        data: { version: "1.0.0" },
        error: null,
      }),
    });
    mockUseFeatureFlag.mockReturnValue({ enabled: false });
    mockApiGet.mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn());
  });

  it("executes immediately for a fresh healthy cached result", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    queryClient.setQueryData(
      healthCheckOptions(getPreLoopTargetKey("target-1"), EXPECTED_MCP_URL, {
        relayTargetId: "target-1",
        latestVersion: "1.0.0",
      }).queryKey,
      healthyResult
    );

    renderGate({ queryClient, execute, computeTargetId: "target-1" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
    expect(mockHealthCheckDialogRender).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith(
      "pre_loop_command_attempted",
      expect.objectContaining({ loopCommand: "execute_plan" })
    );
  });

  it("uses a fresh passing cache without re-running health check when latest release is cached", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    const refetchLatest = vi.fn();
    mockUseLatestElectronRelease.mockReturnValue({
      data: { version: "1.0.0" },
      refetch: refetchLatest,
    });
    queryClient.setQueryData(
      healthCheckOptions(getPreLoopTargetKey("target-1"), EXPECTED_MCP_URL, {
        relayTargetId: "target-1",
        latestVersion: "1.0.0",
      }).queryKey,
      healthyResult
    );

    renderGate({ queryClient, execute, computeTargetId: "target-1" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
    expect(mockHealthCheckDialogRender).not.toHaveBeenCalled();
    expect(refetchLatest).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("opens the blocking dialog from a fresh failing cache without re-running health check", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    const refetchLatest = vi.fn();
    mockUseLatestElectronRelease.mockReturnValue({
      data: { version: "1.0.0" },
      refetch: refetchLatest,
    });
    queryClient.setQueryData(
      healthCheckOptions(getPreLoopTargetKey("target-1"), EXPECTED_MCP_URL, {
        relayTargetId: "target-1",
        latestVersion: "1.0.0",
      }).queryKey,
      failingResult
    );

    renderGate({ queryClient, execute, computeTargetId: "target-1" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await screen.findByTestId("blocking-dialog");
    expect(execute).not.toHaveBeenCalled();
    expect(refetchLatest).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockHealthCheckDialogRender).toHaveBeenCalledWith(
      expect.objectContaining({
        initialData: failingResult,
        latestVersionOverride: "1.0.0",
        targetKey: getPreLoopTargetKey("target-1"),
      })
    );
  });

  it("uses a fresh persisted passing snapshot without re-running health check", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    mockApiGet.mockResolvedValue({
      id: "snapshot-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      checkedAt: new Date().toISOString(),
      expectedMcpUrl: EXPECTED_MCP_URL,
      latestVersion: "1.0.0",
      result: healthyResult,
      allRequiredPassed: true,
      requiredFailureIds: [],
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    renderGate({ queryClient, execute, computeTargetId: "target-1" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
    expect(mockApiGet).toHaveBeenCalledWith(
      "/compute-targets/target-1/health-check"
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not refetch a persisted snapshot when a null snapshot is cached", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    queryClient.setQueryData(
      computeTargetKeys.healthCheckMode("target-1", false),
      null
    );
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json(healthyResult));

    renderGate({ queryClient, execute, computeTargetId: "target-1" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
    expect(mockApiGet).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("uses the production plugin auto-update flag key before sending auto-update health checks", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    mockUseFeatureFlag.mockImplementation((key: string) => ({
      enabled: key === PLUGIN_AUTO_UPDATE_FEATURE_FLAG_KEY,
    }));
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json(healthyResult));

    renderGate({ queryClient, execute, computeTargetId: "target-1" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
    expect(mockUseFeatureFlag).toHaveBeenCalledWith(
      PLUGIN_AUTO_UPDATE_FEATURE_FLAG_KEY
    );
    const [requestUrl] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    expect(String(requestUrl)).toContain("pluginAutoUpdate=1");
  });

  it("does not allow an offline target to pass from a persisted snapshot", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    targets = targets.map((target) =>
      target.id === "target-1" ? { ...target, isOnline: false } : target
    );
    mockUseComputeTargets.mockImplementation(() => ({
      data: targets,
      refetch: vi.fn().mockResolvedValue({ data: targets, error: null }),
    }));
    mockApiGet.mockResolvedValue({
      id: "snapshot-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      checkedAt: new Date().toISOString(),
      expectedMcpUrl: EXPECTED_MCP_URL,
      latestVersion: "1.0.0",
      result: healthyResult,
      allRequiredPassed: true,
      requiredFailureIds: [],
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    renderGate({ queryClient, execute, computeTargetId: "target-1" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(mockWarning).toHaveBeenCalledWith(
        "System check unavailable",
        expect.any(Object)
      );
    });
    expect(execute).not.toHaveBeenCalled();
    expect(mockApiGet).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("cancels an uncached attempt while latest release resolution is pending", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    let resolveLatest:
      | ((result: { data: { version: string }; error: null }) => void)
      | undefined;
    const refetchLatest = vi.fn(
      () =>
        new Promise<{ data: { version: string }; error: null }>((resolve) => {
          resolveLatest = resolve;
        })
    );
    mockUseLatestElectronRelease.mockReturnValue({
      data: undefined,
      refetch: refetchLatest,
    });
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json(healthyResult));

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(refetchLatest).toHaveBeenCalledOnce();
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel Owner" }));
    expect(mockCapture).toHaveBeenCalledWith(
      "pre_loop_system_check_cancelled",
      expect.objectContaining({ reason: "owner_cancelled" })
    );

    act(() => {
      resolveLatest?.({ data: { version: "1.0.0" }, error: null });
    });
    await act(async () => {});

    expect(execute).not.toHaveBeenCalled();
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
  });

  it("cancels before a Cloud preference skip can execute the command", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    const cloudPreference = {
      preferredComputeMode: ComputePreference.Cloud,
      computeTargetId: undefined,
    };
    let resolvePreference:
      | ((result: { data: typeof cloudPreference; error: null }) => void)
      | undefined;
    const refetchPreference = vi.fn(
      () =>
        new Promise<{ data: typeof cloudPreference; error: null }>(
          (resolve) => {
            resolvePreference = resolve;
          }
        )
    );
    mockUseComputePreference.mockImplementation(() => ({
      data: undefined,
      refetch: refetchPreference,
    }));

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(refetchPreference).toHaveBeenCalledOnce();
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel Owner" }));

    act(() => {
      resolvePreference?.({ data: cloudPreference, error: null });
    });
    await act(async () => {});

    expect(mockCapture).toHaveBeenCalledWith(
      "pre_loop_system_check_cancelled",
      expect.objectContaining({ reason: "owner_cancelled" })
    );
    expect(execute).not.toHaveBeenCalled();
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
  });

  it("does not use a fresh passing cache from a different compute target", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    let resolveLatest:
      | ((result: { data: { version: string }; error: null }) => void)
      | undefined;
    const refetchLatest = vi.fn(
      () =>
        new Promise<{ data: { version: string }; error: null }>((resolve) => {
          resolveLatest = resolve;
        })
    );
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.mocked(globalThis.fetch).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    mockUseLatestElectronRelease.mockReturnValue({
      data: undefined,
      refetch: refetchLatest,
    });
    queryClient.setQueryData(
      healthCheckOptions(getPreLoopTargetKey("target-2"), EXPECTED_MCP_URL, {
        relayTargetId: "target-2",
        latestVersion: "1.0.0",
      }).queryKey,
      healthyResult
    );

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(refetchLatest).toHaveBeenCalledOnce();
    });
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();

    act(() => {
      resolveLatest?.({ data: { version: "1.0.0" }, error: null });
    });
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();

    act(() => {
      resolveFetch?.(Response.json(healthyResult));
    });
    await waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  it("keeps the blocking dialog hidden while an uncached health check passes", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.mocked(globalThis.fetch).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });
    expect(screen.getByTestId("state")).toHaveTextContent("checking");
    expect(execute).not.toHaveBeenCalled();
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
    expect(mockHealthCheckDialogRender).not.toHaveBeenCalled();

    act(() => {
      resolveFetch?.(Response.json(healthyResult));
    });
    await waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
  });

  it("opens the blocking dialog after an uncached health check returns required failures", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.mocked(globalThis.fetch).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });
    expect(screen.getByTestId("state")).toHaveTextContent("checking");
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
    expect(execute).not.toHaveBeenCalled();

    act(() => {
      resolveFetch?.(Response.json(failingResult));
    });
    await waitFor(() => {
      expect(screen.getByTestId("state")).toHaveTextContent("dialog");
    });
    expect(screen.getByTestId("blocking-dialog")).toBeInTheDocument();
    expect(execute).not.toHaveBeenCalled();
    expect(mockHealthCheckDialogRender).toHaveBeenCalledWith(
      expect.objectContaining({
        initialData: failingResult,
        targetKey: getPreLoopTargetKey("target-1"),
      })
    );
  });

  it("cancels an in-flight silent check and does not execute after the health check resolves", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.mocked(globalThis.fetch).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });
    expect(screen.getByTestId("state")).toHaveTextContent("checking");
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel Owner" }));
    await waitFor(() => {
      expect(screen.getByTestId("is-checking")).toHaveTextContent("false");
    });
    expect(screen.getByTestId("is-dialog-open")).toHaveTextContent("false");
    expect(execute).not.toHaveBeenCalled();

    act(() => {
      resolveFetch?.(Response.json(healthyResult));
    });
    await act(async () => {});

    expect(execute).not.toHaveBeenCalled();
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
  });

  it("cancels an in-flight silent check when the selected target changes", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.mocked(globalThis.fetch).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    const { rerender } = renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();

    preference = {
      preferredComputeMode: ComputePreference.Local,
      computeTargetId: "target-2",
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <PreLoopSystemCheckProvider>
          <GateHarness execute={execute} />
        </PreLoopSystemCheckProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(mockCapture).toHaveBeenCalledWith(
        "pre_loop_system_check_cancelled",
        expect.objectContaining({ reason: "target_changed" })
      );
    });
    expect(screen.getByTestId("is-checking")).toHaveTextContent("false");

    act(() => {
      resolveFetch?.(Response.json(healthyResult));
    });
    await act(async () => {});

    expect(execute).not.toHaveBeenCalled();
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
  });

  it("does not let a cancelled in-flight result clear checking for a newer attempt", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    const resolveFetches: Array<(response: Response) => void> = [];
    vi.mocked(globalThis.fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetches.push(resolve);
        })
    );

    const { rerender } = renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel Owner" }));
    await waitFor(() => {
      expect(screen.getByTestId("is-checking")).toHaveTextContent("false");
    });
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();

    preference = {
      preferredComputeMode: ComputePreference.Local,
      computeTargetId: "target-2",
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <PreLoopSystemCheckProvider>
          <GateHarness execute={execute} />
        </PreLoopSystemCheckProvider>
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("is-checking")).toHaveTextContent("true");

    act(() => {
      resolveFetches[0]?.(Response.json(healthyResult));
    });
    await act(async () => {});

    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByTestId("is-checking")).toHaveTextContent("true");

    act(() => {
      resolveFetches[1]?.(Response.json(healthyResult));
    });
    await waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  it("does not execute when the provider unmounts before an uncached attempt completes", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    let resolveLatest:
      | ((result: { data: { version: string }; error: null }) => void)
      | undefined;
    const refetchLatest = vi.fn(
      () =>
        new Promise<{ data: { version: string }; error: null }>((resolve) => {
          resolveLatest = resolve;
        })
    );
    mockUseLatestElectronRelease.mockReturnValue({
      data: undefined,
      refetch: refetchLatest,
    });
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json(healthyResult));

    const { unmount } = renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(refetchLatest).toHaveBeenCalledOnce();
    });
    unmount();

    act(() => {
      resolveLatest?.({ data: { version: "1.0.0" }, error: null });
    });
    await act(async () => {});

    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when the authenticated user is not available", () => {
    mockUseUser.mockReturnValue({ user: undefined });
    const queryClient = createQueryClient();
    const execute = vi.fn();

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(execute).not.toHaveBeenCalled();
    expect(mockWarning).toHaveBeenCalledWith(
      "System check unavailable",
      expect.objectContaining({
        description: expect.stringContaining("verify your session"),
      })
    );
    const [, options] = mockWarning.mock.calls[0];
    expect(options.description).not.toContain("compute target");
    expect(mockHealthCheckDialogRender).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("blocks on required failures until the dialog reports them resolved", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    queryClient.setQueryData(
      healthCheckOptions(getPreLoopTargetKey("target-1"), EXPECTED_MCP_URL, {
        relayTargetId: "target-1",
        latestVersion: "1.0.0",
      }).queryKey,
      failingResult
    );

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await screen.findByTestId("blocking-dialog");
    expect(execute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
    await waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
    expect(mockCapture).toHaveBeenCalledWith(
      "pre_loop_system_check_resolved",
      expect.objectContaining({
        recheckAttempts: 0,
      })
    );
  });

  it("blocks the same required failure again after cancellation", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    queryClient.setQueryData(
      healthCheckOptions(getPreLoopTargetKey("target-1"), EXPECTED_MCP_URL, {
        relayTargetId: "target-1",
        latestVersion: "1.0.0",
      }).queryKey,
      failingResult
    );

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByTestId("blocking-dialog");
    expect(execute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByTestId("blocking-dialog");
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancel drops the pending command without executing it", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    queryClient.setQueryData(
      healthCheckOptions(getPreLoopTargetKey("target-1"), EXPECTED_MCP_URL, {
        relayTargetId: "target-1",
        latestVersion: "1.0.0",
      }).queryKey,
      failingResult
    );

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByTestId("blocking-dialog");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
    });
    expect(execute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByTestId("blocking-dialog");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps blocking when a re-check is unavailable after a required failure", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    queryClient.setQueryData(
      healthCheckOptions(getPreLoopTargetKey("target-1"), EXPECTED_MCP_URL, {
        relayTargetId: "target-1",
        latestVersion: "1.0.0",
      }).queryKey,
      failingResult
    );

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByTestId("blocking-dialog");

    fireEvent.click(
      screen.getByRole("button", { name: "Recheck Unavailable" })
    );

    expect(screen.getByTestId("blocking-dialog")).toBeInTheDocument();
    expect(execute).not.toHaveBeenCalled();
    expect(mockWarning).toHaveBeenCalledWith(
      "System check unavailable",
      expect.objectContaining({
        description: expect.stringContaining("Fix the failing checks"),
      })
    );
    expect(mockCapture).toHaveBeenCalledWith(
      "pre_loop_system_check_unavailable",
      expect.objectContaining({
        reason: "recheck:offline",
        recheckAttempts: 1,
      })
    );
  });

  it("does not execute when the initial health check request is unavailable", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("offline"));

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(mockWarning).toHaveBeenCalledWith(
        "System check unavailable",
        expect.objectContaining({
          description: expect.stringContaining("was not started"),
        })
      );
    });
    expect(execute).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith(
      "pre_loop_system_check_unavailable",
      expect.objectContaining({ reason: expect.stringContaining("offline") })
    );
    expect(screen.getByTestId("blocking-dialog")).toBeInTheDocument();
    expect(mockHealthCheckDialogRender).toHaveBeenCalledWith(
      expect.objectContaining({
        initialData: expect.objectContaining({ allRequiredPassed: false }),
        latestVersionOverride: "1.0.0",
        targetKey: getPreLoopTargetKey("target-1"),
      })
    );
  });

  it("cancels a pending dialog when the selected target changes", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    queryClient.setQueryData(
      healthCheckOptions(getPreLoopTargetKey("target-1"), EXPECTED_MCP_URL, {
        relayTargetId: "target-1",
        latestVersion: "1.0.0",
      }).queryKey,
      failingResult
    );

    const { rerender } = renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByTestId("blocking-dialog");

    preference = {
      preferredComputeMode: ComputePreference.Local,
      computeTargetId: "target-2",
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <PreLoopSystemCheckProvider>
          <GateHarness execute={execute} />
        </PreLoopSystemCheckProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
    });
    expect(execute).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith(
      "pre_loop_system_check_cancelled",
      expect.objectContaining({ reason: "target_changed" })
    );
  });
});
