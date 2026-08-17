import {
  HealthCheckRepairAction,
  HealthCheckRepairStepStatus,
} from "@repo/api/src/types/compute-target";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWrapper,
  RE_REPAIR_BUTTON,
  RE_RUN_ON_CLOUD_BUTTON,
} from "./fixtures/health-check-dialog-fixtures";

/**
 * The pre-loop dialog's footer, on the distinction ISS-5435 made reachable:
 * once the synthesized `<provider>-mcp` rows became repairable, "Repair is on
 * offer" stopped implying "Repair can unblock this user". A separate file
 * because `HealthCheckDialog.test.tsx` is on the file-size grandfather list and
 * is shrink-only.
 */

const mockQueryFn = vi.fn();

const mockUseFeatureFlagEnabled = vi.hoisted(() =>
  vi.fn((_key: string) => true)
);
const mockRepairHealthCheck = vi.hoisted(() => vi.fn());

vi.mock(
  "@/lib/engineer/queries/health-check-repair",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/engineer/queries/health-check-repair")
      >();
    return { ...actual, repairHealthCheck: mockRepairHealthCheck };
  }
);

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => mockUseFeatureFlagEnabled(key),
}));

vi.mock("@/lib/engineer/queries/health-check", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/engineer/queries/health-check")
    >();
  return {
    ...actual,
    healthCheckOptions: () => ({
      queryKey: ["health-check"],
      queryFn: mockQueryFn,
      staleTime: 30_000,
    }),
  };
});

vi.mock("@/components/system-check/system-check-results", () => ({
  SystemCheckResults: () => <div data-testid="system-check-results" />,
}));

vi.mock("@/components/engineer/PathAutocomplete", () => ({
  PathAutocomplete: (props: {
    value: string;
    onChange: (v: string) => void;
    [key: string]: unknown;
  }) => (
    <input
      data-testid="path-autocomplete"
      onChange={(e) => props.onChange(e.target.value)}
      value={props.value}
    />
  ),
}));

vi.mock("@/lib/engineer/queries/keys", () => ({
  queryKeys: {
    healthCheck: () => ["health-check"],
    repos: () => ["repos"],
  },
}));

vi.mock("@/lib/engineer/queries/repos", () => ({
  updateRepoSettings: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Import after mocks are registered
import { HealthCheckDialog } from "../HealthCheckDialog";

/** The reviewer's scenario: expired `gh auth` — required, and beyond Repair. */
const blockingUnrepairableCheck = {
  id: "gh-auth",
  label: "GitHub auth",
  required: true,
  passed: false,
  error: "Token expired",
  repair: {
    repairable: false,
    reason: "Re-authenticating gh has to happen on that machine.",
  },
};

/** An OPTIONAL row Repair can fix — the one ISS-5435 newly made repairable. */
const repairableOptionalMcpServers = {
  codex: {
    available: false,
    serverName: null,
    matchedUrl: "https://mcp.example.com",
    checkedAt: "2026-08-08T00:00:00.000Z",
    repair: {
      repairable: true,
      action: HealthCheckRepairAction.ConfigureMcp,
    },
  },
};

async function renderDialog(initialData: Record<string, unknown>) {
  const Wrapper = createWrapper();
  render(
    <Wrapper>
      <HealthCheckDialog
        initialData={initialData as never}
        isOwnedTarget
        latestVersionOverride={null}
        onCancel={vi.fn()}
        onRunOnCloud={vi.fn()}
        pluginAutoUpdateEnabled={false}
        relayTargetId="target-1"
      />
    </Wrapper>
  );
  await act(async () => {});
}

/** A required row Repair CAN fix, so the repair run has something to succeed at. */
const repairableRequiredCheck = {
  id: "claude-cli",
  label: "Claude CLI",
  required: true,
  passed: false,
  repair: {
    repairable: true,
    action: HealthCheckRepairAction.ClearBinaryOverride,
  },
};

const RE_SUCCESS_SCREEN = /all pre-checks passed/i;
const MCP_STEP_LABEL = "Configure MCP server: Codex";
/**
 * How long to poll for the success view. Comfortably past the reveal stagger
 * plus `SUCCESS_SCREEN_DELAY`, and short of the point where the success view
 * would have dismissed itself again.
 */
const SUCCESS_WINDOW_MS = 2500;

describe("HealthCheckDialog footer — Run on Cloud vs. Repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFeatureFlagEnabled.mockReturnValue(true);
  });

  it("keeps Run on Cloud when the only repairable row is optional", async () => {
    await renderDialog({
      checks: [blockingUnrepairableCheck],
      allRequiredPassed: false,
      mcpServers: repairableOptionalMcpServers,
    });

    // Repair IS offered — the optional MCP row earns the button…
    expect(screen.getByRole("button", { name: RE_REPAIR_BUTTON })).toBeTruthy();
    // …but the user is stuck on `gh-auth`, which Repair cannot touch, so the
    // only way forward must stay on screen.
    expect(
      screen.getByRole("button", { name: RE_RUN_ON_CLOUD_BUTTON })
    ).toBeTruthy();
  });

  it("drops Run on Cloud when Repair can clear the required failure", async () => {
    await renderDialog({
      checks: [
        {
          id: "claude-cli",
          label: "Claude CLI",
          required: true,
          passed: false,
          repair: {
            repairable: true,
            action: HealthCheckRepairAction.ClearBinaryOverride,
          },
        },
      ],
      allRequiredPassed: false,
    });

    expect(screen.getByRole("button", { name: RE_REPAIR_BUTTON })).toBeTruthy();
    // Repair, then Re-check, is genuinely the next action here.
    expect(screen.queryByRole("button", { name: RE_RUN_ON_CLOUD_BUTTON })).toBe(
      null
    );
  });
});

describe("HealthCheckDialog success screen vs. a failed repair step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFeatureFlagEnabled.mockReturnValue(true);
  });

  /**
   * The repair clears the required row but its MCP step {@link status}. Because
   * the MCP row is OPTIONAL, `allRequiredPassed` flips true either way — which
   * is exactly how a failed repair could reach the success screen.
   */
  function repairResponse(status: HealthCheckRepairStepStatus) {
    return {
      steps: [
        {
          action: HealthCheckRepairAction.ClearBinaryOverride,
          label: "Clear stale binary path override: Claude CLI",
          status: HealthCheckRepairStepStatus.Succeeded,
          checkIds: ["claude-cli"],
        },
        {
          action: HealthCheckRepairAction.ConfigureMcp,
          label: MCP_STEP_LABEL,
          status,
          checkIds: ["codex-mcp"],
        },
      ],
      result: {
        checks: [
          { ...repairableRequiredCheck, passed: true, repair: undefined },
        ],
        allRequiredPassed: true,
        mcpServers: {
          codex: {
            available: status === HealthCheckRepairStepStatus.Succeeded,
            serverName: null,
            matchedUrl: "https://mcp.example.com",
            checkedAt: "2026-08-08T00:00:00.000Z",
          },
        },
      },
    };
  }

  async function renderAndRepair(status: HealthCheckRepairStepStatus) {
    mockRepairHealthCheck.mockResolvedValue(repairResponse(status));
    await renderDialog({
      checks: [repairableRequiredCheck],
      allRequiredPassed: false,
      mcpServers: repairableOptionalMcpServers,
    });

    fireEvent.click(screen.getByRole("button", { name: RE_REPAIR_BUTTON }));
  }

  it("holds the dialog open when the last repair reported a failed step", async () => {
    await renderAndRepair(HealthCheckRepairStepStatus.Failed);

    // Polled, not slept: the success view is transient — it replaces the panel
    // and then dismisses the whole dialog — so only polling can prove it never
    // appeared rather than merely missing it between two fixed instants.
    await expect(
      waitFor(
        () => {
          expect(screen.getByText(RE_SUCCESS_SCREEN)).toBeTruthy();
        },
        { timeout: SUCCESS_WINDOW_MS }
      )
    ).rejects.toThrow();

    // And the repair panel is still what the user is looking at.
    expect(screen.getByText(new RegExp(MCP_STEP_LABEL, "i"))).toBeTruthy();
  });

  it("still reaches the success screen when every repair step succeeded", async () => {
    await renderAndRepair(HealthCheckRepairStepStatus.Succeeded);

    // The positive control: nothing but a failed step holds the dialog, so the
    // same run, polled the same way and for the same window, DOES reach success.
    // That is what makes the assertion above a statement about the failed step
    // rather than about timing.
    await waitFor(
      () => {
        expect(screen.getByText(RE_SUCCESS_SCREEN)).toBeTruthy();
      },
      { timeout: SUCCESS_WINDOW_MS }
    );
  });
});
