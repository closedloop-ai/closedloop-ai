import { ComputePreference } from "@repo/api/src/types/compute-target";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { healthCheckOptions } from "@/lib/engineer/queries/health-check";
import { PreLoopCommand } from "../pre-loop-health-check";
import {
  PreLoopSystemCheckProvider,
  usePreLoopSystemCheckGate,
} from "../pre-loop-system-check-provider";

const mockCapture = vi.hoisted(() => vi.fn());
const mockWarning = vi.hoisted(() => vi.fn());
const mockUseComputePreference = vi.hoisted(() => vi.fn());
const mockUseComputeTargets = vi.hoisted(() => vi.fn());
const mockUseLatestElectronRelease = vi.hoisted(() => vi.fn());
const EXPECTED_MCP_URL = vi.hoisted(() => "https://mcp.closedloop.ai/mcp");

vi.mock("@repo/analytics/client", () => ({
  useAnalytics: () => ({
    capture: mockCapture,
    identify: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock("@repo/auth/client", () => ({
  useUser: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    warning: mockWarning,
  },
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_MCP_SERVER_URL: EXPECTED_MCP_URL,
  },
}));

vi.mock("@/hooks/queries/use-compute-preference", () => ({
  useComputePreference: (...args: unknown[]) =>
    mockUseComputePreference(...args),
}));

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
}));

vi.mock("@/hooks/queries/use-electron-release", () => ({
  useLatestElectronRelease: (...args: unknown[]) =>
    mockUseLatestElectronRelease(...args),
}));

vi.mock("@/components/engineer/HealthCheckDialog", () => ({
  HealthCheckDialog: ({
    onCancel,
    onRecheckUnavailable,
    onResolvedAfterRecheck,
  }: {
    onCancel: () => void;
    onRecheckUnavailable: (reason: string) => void;
    onResolvedAfterRecheck: () => void;
  }) => (
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
  ),
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
let targets = [
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

function GateHarness({ execute }: { execute: () => void }) {
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
              },
              execute
            )
            .catch(() => undefined);
        }}
        type="button"
      >
        Run
      </button>
      <div data-testid="state">{stateLabel}</div>
    </>
  );
}

function renderGate({
  queryClient,
  execute,
}: {
  queryClient: QueryClient;
  execute: () => void;
}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <PreLoopSystemCheckProvider>
        <GateHarness execute={execute} />
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
    preference = {
      preferredComputeMode: ComputePreference.Local,
      computeTargetId: "target-1",
    };
    targets = targets.map((target) => ({ ...target }));
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
    vi.stubGlobal("fetch", vi.fn());
  });

  it("executes immediately for a fresh healthy cached result", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    queryClient.setQueryData(
      healthCheckOptions("compute-target:target-1", EXPECTED_MCP_URL, {
        relayTargetId: "target-1",
        latestVersion: "1.0.0",
      }).queryKey,
      healthyResult
    );

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith(
      "pre_loop_command_attempted",
      expect.objectContaining({ loopCommand: "execute_plan" })
    );
  });

  it("opens the blocking dialog while the health check request is still running", async () => {
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

    await screen.findByTestId("blocking-dialog");
    expect(screen.getByTestId("state")).toHaveTextContent("checking");
    expect(execute).not.toHaveBeenCalled();

    resolveFetch?.(Response.json(healthyResult));
    await waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  it("blocks on required failures until the dialog reports them resolved", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    queryClient.setQueryData(
      healthCheckOptions("compute-target:target-1", EXPECTED_MCP_URL, {
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
      healthCheckOptions("compute-target:target-1", EXPECTED_MCP_URL, {
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
      healthCheckOptions("compute-target:target-1", EXPECTED_MCP_URL, {
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
      healthCheckOptions("compute-target:target-1", EXPECTED_MCP_URL, {
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
  });

  it("cancels a pending dialog when the selected target changes", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();
    queryClient.setQueryData(
      healthCheckOptions("compute-target:target-1", EXPECTED_MCP_URL, {
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
