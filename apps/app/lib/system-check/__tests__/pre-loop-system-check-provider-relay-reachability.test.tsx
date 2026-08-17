import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRE_LOOP_CLOUD_FALLBACK_FEATURE_FLAG_KEY } from "../cloud-fallback";
import {
  HealthCheckFailureKind,
  HealthCheckTimeoutError,
} from "../health-check-failure";
import {
  applyDefaultProviderMocks,
  createFeatureFlagMocker,
  createQueryClient,
  failingResult,
  healthyResult,
  renderGate,
} from "./fixtures/pre-loop-provider-harness";

const mockCapture = vi.hoisted(() => vi.fn());
const mockError = vi.hoisted(() => vi.fn());
const mockWarning = vi.hoisted(() => vi.fn());
const mockInfo = vi.hoisted(() => vi.fn());
const mockUseFeatureFlag = vi.hoisted(() => vi.fn());
const mockUseComputePreference = vi.hoisted(() => vi.fn());
const mockUseComputeTargets = vi.hoisted(() => vi.fn());
const mockUseLatestElectronRelease = vi.hoisted(() => vi.fn());
const mockApiGet = vi.hoisted(() => vi.fn());
const mockHealthCheckDialogRender = vi.hoisted(() => vi.fn());
const mockUseUser = vi.hoisted(() => vi.fn());

vi.mock("@repo/analytics/client", () => ({
  useAnalytics: () => ({
    capture: mockCapture,
    identify: vi.fn(),
    reset: vi.fn(),
  }),
  useFeatureFlag: (key: string) => mockUseFeatureFlag(key),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) =>
    mockUseFeatureFlag(key)?.enabled === true,
}));

vi.mock("@repo/auth/client", () => ({
  useUser: () => mockUseUser(),
}));

// The provider resolves the Settings deep-link for the Cloud block (ISS-5172)
// through these two hooks, so every render in this file needs them stubbed.
vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "org-test",
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: mockError,
    warning: mockWarning,
    info: mockInfo,
  },
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_MCP_SERVER_URL: "https://mcp.closedloop.ai/mcp",
    NEXT_PUBLIC_POSTHOG_KEY: "test-posthog-key",
  },
}));

vi.mock("@repo/app/compute/hooks/use-compute-preference", () => ({
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

vi.mock("@repo/app/desktop/hooks/use-electron-release", () => ({
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
    onRunOnCloud,
    targetKey,
  }: {
    initialData?: unknown;
    latestVersionOverride?: string | null;
    onCancel: () => void;
    onRecheckUnavailable: (reason: string) => void;
    onResolvedAfterRecheck: () => void;
    onRunOnCloud?: () => void;
    targetKey?: string;
  }) => {
    mockHealthCheckDialogRender({
      initialData,
      latestVersionOverride,
      targetKey,
      hasRunOnCloud: Boolean(onRunOnCloud),
    });
    return (
      <div data-testid="blocking-dialog">
        <button onClick={onCancel} type="button">
          Cancel
        </button>
        {onRunOnCloud ? (
          <button onClick={onRunOnCloud} type="button">
            Run on Cloud
          </button>
        ) : null}
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

const mockEnabledFeatureFlags = createFeatureFlagMocker(mockUseFeatureFlag);

/**
 * ISS-5169 / ISS-5170 / ISS-5171 regressions.
 *
 * Each test in this block fails against the pre-fix provider:
 *  - the gate latched forever after an unexpected throw (a "frozen app"),
 *  - an unreachable relay target hard-blocked instead of degrading to Cloud,
 *  - a relay timeout and a failing check produced the same opaque copy.
 */
describe("PreLoopSystemCheckProvider — relay reachability (ISS-5169/5170/5171)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyDefaultProviderMocks({
      mockUseUser,
      mockUseFeatureFlag,
      mockUseComputePreference,
      mockUseComputeTargets,
      mockUseLatestElectronRelease,
      mockApiGet,
    });
    mockEnabledFeatureFlags();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("hands the gate back after an unreachable check so the app is not wedged (ISS-5170)", async () => {
    // The blocking modal is mounted app-wide, and while an attempt is pending
    // `runWithPreLoopSystemCheck` answers every other command with
    // `duplicate_ignored` — silently. A check that can never succeed therefore
    // reads as the whole app freezing, not as one failed command. Dismissing
    // the dialog must fully release the gate.
    const queryClient = createQueryClient();
    const execute = vi.fn();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HealthCheckTimeoutError(HealthCheckFailureKind.RelayTimeout, 20_000)
    );

    renderGate({ queryClient, execute, computeTargetId: "target-1" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByTestId("blocking-dialog");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Both latches must clear: the dialog disappears AND isChecking is false.
    await waitFor(() => {
      expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("is-checking")).toHaveTextContent("false");
    expect(screen.getByTestId("is-dialog-open")).toHaveTextContent("false");

    // The next command is accepted, not swallowed as a duplicate.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => healthyResult,
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith({ computeTargetId: "target-1" });
    });
  });

  it("falls back to Cloud when the relay target times out, instead of blocking (ISS-5171)", async () => {
    mockEnabledFeatureFlags(PRE_LOOP_CLOUD_FALLBACK_FEATURE_FLAG_KEY);
    const queryClient = createQueryClient();
    const execute = vi.fn();

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HealthCheckTimeoutError(HealthCheckFailureKind.RelayTimeout, 20_000)
    );

    renderGate({ queryClient, execute, computeTargetId: "target-1" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    // The command runs — on Cloud (computeTargetId null), not on the target
    // that could not be reached.
    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith({ computeTargetId: null });
    });
    expect(screen.queryByTestId("blocking-dialog")).not.toBeInTheDocument();
    // The operator is told which target was chosen and why, in one
    // self-contained sentence — the toast auto-dismisses, so it carries no
    // separate description that repeats the title.
    expect(mockInfo).toHaveBeenCalledWith(
      "Couldn't reach Laptop, so this ran on Cloud."
    );
    expect(mockCapture).toHaveBeenCalledWith(
      "pre_loop_system_check_cloud_fallback",
      expect.objectContaining({ computeTargetId: "target-1" })
    );
  });

  it("keeps the hard block when the flag is off, so the fallback is closed by default", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HealthCheckTimeoutError(HealthCheckFailureKind.RelayTimeout, 20_000)
    );

    renderGate({ queryClient, execute, computeTargetId: "target-1" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(screen.getByTestId("blocking-dialog")).toBeInTheDocument();
    });
    expect(execute).not.toHaveBeenCalled();
    // No Cloud escape hatch is offered while the flag is off.
    expect(
      screen.queryByRole("button", { name: "Run on Cloud" })
    ).not.toBeInTheDocument();
  });

  it("still blocks on a target that answered with failing checks (ISS-5171 scope)", async () => {
    mockEnabledFeatureFlags(PRE_LOOP_CLOUD_FALLBACK_FEATURE_FLAG_KEY);
    const queryClient = createQueryClient();
    const execute = vi.fn();

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => failingResult,
    });

    renderGate({ queryClient, execute, computeTargetId: "target-1" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    // A reachable target with real failing checks keeps its remediation dialog;
    // only *unreachable* targets degrade to Cloud.
    await waitFor(() => {
      expect(screen.getByTestId("blocking-dialog")).toBeInTheDocument();
    });
    expect(execute).not.toHaveBeenCalled();
    expect(mockInfo).not.toHaveBeenCalled();
  });

  it("offers Run on Cloud from the blocking dialog as a path forward (ISS-5170)", async () => {
    mockEnabledFeatureFlags(PRE_LOOP_CLOUD_FALLBACK_FEATURE_FLAG_KEY);
    const queryClient = createQueryClient();
    const execute = vi.fn();

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => failingResult,
    });

    renderGate({ queryClient, execute, computeTargetId: "target-1" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(screen.getByTestId("blocking-dialog")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Run on Cloud" }));

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith({ computeTargetId: null });
    });
    // And the gate is handed back — not left latched behind a closed dialog.
    await waitFor(() => {
      expect(screen.getByTestId("is-checking")).toHaveTextContent("false");
    });
  });

  it("reports a relay timeout differently from an unhealthy target (ISS-5169)", async () => {
    const queryClient = createQueryClient();
    const execute = vi.fn();

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new HealthCheckTimeoutError(HealthCheckFailureKind.RelayTimeout, 20_000)
    );

    renderGate({ queryClient, execute, computeTargetId: "target-1" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(mockCapture).toHaveBeenCalledWith(
        "pre_loop_system_check_unavailable",
        expect.objectContaining({
          reason: expect.stringContaining(HealthCheckFailureKind.RelayTimeout),
        })
      );
    });

    // The dialog says "could not reach", not a flat "Unavailable".
    const lastRender =
      mockHealthCheckDialogRender.mock.calls.at(-1)?.[0]?.initialData;
    const remediation = lastRender?.checks?.[0]?.remediation;
    expect(lastRender?.checks?.[0]?.error).not.toBe("Unavailable");
    expect(remediation).toContain("Couldn't reach it");
    expect(remediation).toContain("The command was not started.");
    // The classified reason code rides the analytics event asserted above, not
    // the operator-facing remediation.
    expect(remediation).not.toContain(HealthCheckFailureKind.RelayTimeout);
  });
});
