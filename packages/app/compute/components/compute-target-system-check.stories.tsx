import type { CheckResult } from "@repo/api/src/types/compute-target";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import {
  ComputeTargetSystemCheck,
  type ComputeTargetSystemCheckState,
} from "./compute-target-system-check";
import {
  SystemCheckRepairButton,
  SystemCheckRepairPanel,
} from "./system-check-repair";
import { SystemCheckResults } from "./system-check-results";

const checks: CheckResult[] = [
  {
    id: "git",
    label: "Git",
    passed: true,
    required: true,
    version: "2.49.0",
  },
  {
    id: "claude-cli",
    label: "Claude Code",
    passed: false,
    required: true,
    error: "Not found",
    remediation: "Install Claude Code and retry.",
  },
];

/**
 * The ISS-5687 machine: every REQUIRED row green, and the only findings are the
 * two OPTIONAL MCP rows. This is what used to render as "2 failures".
 */
const warningsOnlyChecks: CheckResult[] = [
  {
    id: "git",
    label: "Git",
    passed: true,
    required: true,
    version: "2.49.0",
  },
  {
    id: "claude-cli",
    label: "Claude Code",
    passed: true,
    required: true,
    version: "2.1.220",
  },
  {
    id: "codex-cli",
    label: "Codex CLI",
    passed: true,
    required: true,
    version: "0.147.0",
  },
  {
    id: "claude-mcp",
    label: "Claude MCP",
    passed: false,
    required: false,
    error: "Not configured",
    remediation: "Add the Closedloop MCP server to Claude Code.",
  },
  {
    id: "codex-mcp",
    label: "Codex MCP",
    passed: false,
    required: false,
    error: "Not configured",
    remediation: "Add the Closedloop MCP server to Codex.",
  },
];

/** A blocking row and a non-blocking one in the same result. */
const mixedChecks: CheckResult[] = [
  ...checks,
  {
    id: "codex-cli",
    label: "Codex CLI",
    passed: false,
    required: true,
    error: "Not found",
    remediation: "Install Codex and retry.",
  },
  {
    id: "claude-mcp",
    label: "Claude MCP",
    passed: false,
    required: false,
    error: "Not configured",
    remediation: "Add the Closedloop MCP server to Claude Code.",
  },
];

/**
 * How the surface has wired its Repair slots for a given story. The shell owns
 * the transport, so this stands in for what it would hand down.
 */
const SystemCheckRepairDemoState = {
  /** Nothing repairable, so the button renders nothing and only Re-check shows. */
  NotOffered: "not-offered",
  /** Repairable rows, no run started: the control shows, the panel does not. */
  Offered: "offered",
  Running: "running",
} as const;
type SystemCheckRepairDemoState =
  (typeof SystemCheckRepairDemoState)[keyof typeof SystemCheckRepairDemoState];

function ComputeTargetSystemCheckDemo({
  initialState,
  repair = SystemCheckRepairDemoState.NotOffered,
  failureCount,
  warningCount = 0,
  resultChecks = checks,
}: {
  initialState: ComputeTargetSystemCheckState;
  repair?: SystemCheckRepairDemoState;
  /** Failing REQUIRED rows. Defaults to the legacy one-failure warning shape. */
  failureCount?: number;
  /** Failing OPTIONAL rows (ISS-5687). Amber, but never a "failure". */
  warningCount?: number;
  resultChecks?: CheckResult[];
}) {
  const [state, setState] =
    useState<ComputeTargetSystemCheckState>(initialState);
  const hasResults = state === "success" || state === "warning";
  const isRepairing = repair === SystemCheckRepairDemoState.Running;
  const repairableCount =
    repair === SystemCheckRepairDemoState.NotOffered ? 0 : 1;
  const resolvedFailureCount =
    failureCount ?? (state === "warning" && warningCount === 0 ? 1 : 0);

  return (
    <ComputeTargetSystemCheck
      actionDisabled={state === "loading" || state === "disabled"}
      checkedAtLabel={hasResults ? "May 30, 2026, 9:41 AM" : undefined}
      content={
        hasResults ? <SystemCheckResults checks={resultChecks} /> : undefined
      }
      failureCount={resolvedFailureCount}
      hasResult={hasResults}
      isEligible={state !== "disabled"}
      isLoading={state === "loading"}
      isRepairing={isRepairing}
      onAction={() => {
        setState("loading");
        setTimeout(() => {
          setState((current) =>
            current === "loading" && initialState === "success"
              ? "success"
              : "warning"
          );
        }, 700);
      }}
      repairAction={
        <SystemCheckRepairButton
          isCheckRunning={state === "loading"}
          isRepairing={isRepairing}
          isSupported={true}
          onRepair={() => {
            // Presentational story: the surface owns the transport.
          }}
          repairableCount={repairableCount}
          variant="secondary"
        />
      }
      repairPanel={<SystemCheckRepairPanel isRepairing={isRepairing} />}
      targetName="Mike's MacBook Pro"
      warningCount={warningCount}
    />
  );
}

/**
 * A collapsible panel showing whether a compute target passed its required
 * checks, with a status badge, a summary, and buttons to re-check or repair
 * issues in place.
 */
const meta = {
  title: "Composites/Compute/Compute Target System Check",
  component: ComputeTargetSystemCheckDemo,
  tags: ["autodocs"],
  args: {
    initialState: "idle",
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof ComputeTargetSystemCheckDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const Warning: Story = {
  args: {
    initialState: "warning",
  },
};

/**
 * ISS-5687, the reported machine: zero blocking failures, two OPTIONAL MCP rows
 * unconfigured. The badge must stay amber and say "2 warnings" — NOT "2
 * failures" (the bug) and NOT "All checks passed" (the over-correction). This
 * state was unreachable in Storybook before, because the demo drove its amber
 * badge off `failureCount: 1` and never passed `warningCount` at all, so a
 * regression that re-merged the two counts would not have shown here.
 */
export const WarningsOnly: Story = {
  args: {
    initialState: "warning",
    failureCount: 0,
    warningCount: 2,
    resultChecks: warningsOnlyChecks,
  },
};

/**
 * Both counts standing at once — "2 failures, 1 warning". The widest summary
 * string the header has to seat, and the case where collapsing to the failure
 * count alone would quietly hide a real finding behind a more severe one.
 */
export const FailuresAndWarnings: Story = {
  args: {
    initialState: "warning",
    failureCount: 2,
    warningCount: 1,
    resultChecks: mixedChecks,
  },
};

/**
 * Singular grammar on both halves: "1 failure, 1 warning". Pluralization is
 * per-part, so this is the story that catches a stray "1 failures".
 */
export const SingleFailureAndWarning: Story = {
  args: {
    initialState: "warning",
    failureCount: 1,
    warningCount: 1,
    resultChecks: mixedChecks,
  },
};

export const Healthy: Story = {
  args: {
    initialState: "success",
  },
};

export const Offline: Story = {
  args: {
    initialState: "disabled",
  },
};

/**
 * Repair offered but not started. The section is still collapsed, so the two
 * header controls are the whole of it: Repair ahead of Re-check, and no panel,
 * because there is no run to narrate yet. The contrast for the story below.
 */
export const RepairOffered: Story = {
  args: {
    initialState: "warning",
    repair: SystemCheckRepairDemoState.Offered,
  },
};

/**
 * A repair is running. The narration lives inside the collapsible, which
 * defaults closed, so the section force-opens rather than reporting the run
 * through the badge alone. Repair is disabled for the duration; Re-check keeps
 * its place beside it.
 */
export const RepairInProgress: Story = {
  args: {
    initialState: "warning",
    repair: SystemCheckRepairDemoState.Running,
  },
};

/**
 * Nothing on screen is repairable, so the slot is filled but paints nothing.
 * The header is Re-check alone, unshifted, and the section stays collapsed.
 */
export const RepairNotOffered: Story = {
  args: {
    initialState: "warning",
    repair: SystemCheckRepairDemoState.NotOffered,
  },
};
