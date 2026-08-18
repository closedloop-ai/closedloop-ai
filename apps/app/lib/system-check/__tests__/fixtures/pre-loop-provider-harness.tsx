import {
  CheckSeverity,
  ComputePreference,
  type ComputePreferenceResponse,
} from "@repo/api/src/types/compute-target";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { PreLoopCommand } from "../../pre-loop-health-check";
import {
  PreLoopSystemCheckProvider,
  usePreLoopSystemCheckGate,
} from "../../pre-loop-system-check-provider";

/**
 * Shared harness for the `PreLoopSystemCheckProvider` suites.
 *
 * The provider's tests split by responsibility across sibling files (gating and
 * caching, explicit compute selection, relay reachability), and every one of
 * them needs the same gate harness, query client, compute fixtures, and default
 * hook mocks. Those live here so the suites cannot drift apart — the `vi.mock`
 * calls themselves stay per-file, because Vitest scopes them to the test file.
 */

export const healthyResult = {
  checks: [{ id: "git", label: "Git", required: true, passed: true }],
  allRequiredPassed: true,
};

export const failingResult = {
  checks: [{ id: "cli", label: "CLI", required: true, passed: false }],
  allRequiredPassed: false,
};

/**
 * The ISS-5811 shape: the only non-green REQUIRED rows are ones the gateway
 * could not DETERMINE, which ISS-5369 marks `unknown`/`blocked` rather than
 * asserting a fault it has no evidence for.
 *
 * Deliberately NOT a variant of `healthyResult`: `passed` is `false` and
 * `allRequiredPassed` is `false`, exactly as the gateway sends them, so a gate
 * that reads `passed` alone still blocks on this fixture and the suite goes red.
 */
export const undeterminableResult = {
  checks: [
    { id: "git", label: "Git", required: true, passed: true },
    {
      id: "plugin-code",
      label: "Symphony Plugin",
      required: true,
      passed: false,
      severity: CheckSeverity.Unknown,
      version: "1.14.7",
      error: "Could not verify enabled state",
      repair: { repairable: false },
    },
    {
      id: "plugin-judges",
      label: "Judges Plugin",
      required: true,
      passed: false,
      severity: CheckSeverity.Blocked,
      blockedBy: "claude-cli",
      error: "Not checked, Claude CLI unavailable",
      repair: { repairable: false },
    },
  ],
  allRequiredPassed: false,
};

export const defaultTargets = [
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

/**
 * Mutable compute fixtures the provider hooks read through.
 *
 * Tests mutate these between renders (a target goes offline, the preference
 * flips to Cloud), so they are a shared holder rather than module-level `let`
 * bindings that could not cross the file boundary.
 */
export const computeState: {
  preference: ComputePreferenceResponse;
  targets: typeof defaultTargets;
} = {
  preference: {
    preferredComputeMode: ComputePreference.Local,
    computeTargetId: "target-1",
  },
  targets: defaultTargets.map((target) => ({ ...target })),
};

export type ProviderHarnessMocks = {
  mockUseUser: ReturnType<typeof vi.fn>;
  mockUseFeatureFlag: ReturnType<typeof vi.fn>;
  mockUseComputePreference: ReturnType<typeof vi.fn>;
  mockUseComputeTargets: ReturnType<typeof vi.fn>;
  mockUseLatestElectronRelease: ReturnType<typeof vi.fn>;
  mockApiGet: ReturnType<typeof vi.fn>;
};

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

export function GateHarness({
  execute,
  computeTargetId,
}: {
  execute: (context?: unknown) => void;
  computeTargetId?: string | null;
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

/**
 * The full mounted tree. Exported separately from `renderGate` because several
 * tests drive a `rerender(...)` to prove the provider reacts to a changed
 * selection, and they must re-mount the identical tree.
 */
export function PreLoopGateTree({
  queryClient,
  execute,
  computeTargetId,
}: {
  queryClient: QueryClient;
  execute: (context?: unknown) => void;
  computeTargetId?: string | null;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <PreLoopSystemCheckProvider>
        <GateHarness computeTargetId={computeTargetId} execute={execute} />
      </PreLoopSystemCheckProvider>
    </QueryClientProvider>
  );
}

export function renderGate({
  queryClient,
  execute,
  computeTargetId,
}: {
  queryClient: QueryClient;
  execute: (context?: unknown) => void;
  computeTargetId?: string | null;
}): ReturnType<typeof render> {
  return render(
    <PreLoopGateTree
      computeTargetId={computeTargetId}
      execute={execute}
      queryClient={queryClient}
    />
  );
}

/**
 * Builds the suite's `mockEnabledFeatureFlags(...keys)` helper. Everything not
 * named is reported disabled, so a test that forgets to enable the flag it
 * depends on fails rather than inheriting an ambient `true`.
 */
export function createFeatureFlagMocker(
  mockUseFeatureFlag: ReturnType<typeof vi.fn>
) {
  return (...enabledKeys: string[]) => {
    const enabledKeySet = new Set(enabledKeys);
    mockUseFeatureFlag.mockImplementation((key: string) => ({
      enabled: enabledKeySet.has(key),
    }));
  };
}

/**
 * Resets the compute fixtures and points every provider hook mock at them.
 * Callers still layer their own per-test overrides on top.
 */
export function applyDefaultProviderMocks(mocks: ProviderHarnessMocks) {
  mocks.mockUseUser.mockReturnValue({ user: { id: "user-1" } });
  computeState.preference = {
    preferredComputeMode: ComputePreference.Local,
    computeTargetId: "target-1",
  };
  computeState.targets = defaultTargets.map((target) => ({ ...target }));
  mocks.mockUseComputePreference.mockImplementation(() => ({
    data: computeState.preference,
    refetch: vi
      .fn()
      .mockResolvedValue({ data: computeState.preference, error: null }),
  }));
  mocks.mockUseComputeTargets.mockImplementation(() => ({
    data: computeState.targets,
    refetch: vi
      .fn()
      .mockResolvedValue({ data: computeState.targets, error: null }),
  }));
  mocks.mockUseLatestElectronRelease.mockReturnValue({
    data: { version: "1.0.0" },
    refetch: vi.fn().mockResolvedValue({
      data: { version: "1.0.0" },
      error: null,
    }),
  });
  mocks.mockApiGet.mockResolvedValue(null);
}
