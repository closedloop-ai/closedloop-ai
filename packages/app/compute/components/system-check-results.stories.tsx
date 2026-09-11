import type { CheckResult } from "@repo/api/src/types/compute-target";
import {
  CheckSeverity,
  HealthCheckRepairAction,
} from "@repo/api/src/types/compute-target";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, within } from "storybook/test";
import { SystemCheckResults } from "./system-check-results";

const CLAUDE_CLI_REMEDIATION =
  "Update binary path in Settings, or clear the override";

/** Matches the plugin-code row's structured remediation link. */
const PLUGIN_REMEDIATION_LINK_NAME = /update closedloop plugins manually/i;

const CLOSEDLOOP_PLUGIN_LABELS: [string, string][] = [
  ["code", "Symphony Plugin"],
  ["self-learning", "Self-Learning Plugin"],
  ["judges", "Judges Plugin"],
  ["code-review", "Code Review Plugin"],
  ["platform", "Platform Plugin"],
];

const baseChecks: CheckResult[] = [
  {
    id: "git",
    label: "Git",
    required: true,
    passed: true,
    version: "2.49.0",
  },
  {
    id: "claude-cli",
    label: "Claude Code",
    required: true,
    passed: false,
    error: "Not found",
    remediation: "Install Claude Code and retry.",
  },
  {
    id: "plugin-code",
    label: "Symphony Plugin",
    required: true,
    passed: false,
    error: "Outdated",
    remediation:
      "Update plugins or see https://github.com/closedloop-ai/claude-plugins#quick-start",
    remediationLinks: [
      {
        label: "Update Closedloop plugins manually",
        url: "https://github.com/closedloop-ai/claude-plugins#quick-start",
      },
    ],
    updateOutcome: "failed",
    enableOutcome: "skipped",
  },
  {
    id: "gh-auth",
    label: "GitHub Authentication",
    required: false,
    passed: false,
    error: "Not authenticated",
    remediation: "Run gh auth login.",
  },
  {
    id: "claude-mcp",
    label: "Claude MCP",
    required: false,
    passed: true,
    version: "closedloop-agent-monitor",
  },
  {
    id: "app-version",
    label: "Gateway Version",
    required: true,
    passed: false,
    error: "1.2.0 available",
    remediation: "Update Desktop to continue.",
  },
];

/**
 * The full itemized breakdown of every check a compute target ran, each with
 * a pass or fail badge, unlike Compute Target System Check's collapsed
 * summary badge.
 */
const meta = {
  title: "Composites/Compute/System Check Results",
  component: SystemCheckResults,
  tags: ["autodocs"],
  argTypes: {
    checks: { control: "object", table: { category: "Data" } },
    isLoading: { control: "boolean", table: { category: "State" } },
    revealedCount: {
      control: { type: "number", min: 0 },
      description: "Rows revealed so far. Leave empty to reveal every row.",
      table: { category: "State" },
    },
    pluginAutoUpdateEnabled: {
      control: "boolean",
      table: { category: "State" },
    },
    targetKind: {
      control: { type: "radio" },
      options: ["local", "owned_relay", "shared_relay"],
      table: { category: "State" },
    },
    afterRequired: { control: false, table: { category: "Content" } },
    onStructuredRemediationViewed: {
      control: false,
      table: { category: "Events" },
    },
    onStructuredRemediationLinkClick: {
      control: false,
      table: { category: "Events" },
    },
  },
  args: {
    checks: baseChecks,
    isLoading: false,
    pluginAutoUpdateEnabled: true,
    targetKind: "local",
    onStructuredRemediationViewed: fn(),
    onStructuredRemediationLinkClick: fn(),
  },
} satisfies Meta<typeof SystemCheckResults>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("link", { name: PLUGIN_REMEDIATION_LINK_NAME })
    ).toBeInTheDocument();
    await expect(args.onStructuredRemediationViewed).toHaveBeenCalled();
  },
};

export const Loading: Story = {
  args: {
    checks: undefined,
    isLoading: true,
  },
};

export const HealthyRelayTarget: Story = {
  args: {
    checks: [
      {
        id: "git",
        label: "Git",
        required: true,
        passed: true,
        version: "2.49.0",
      },
      {
        id: "claude-cli",
        label: "Claude Code",
        required: true,
        passed: true,
        version: "1.0.32",
      },
      {
        id: "plugin-code",
        label: "Symphony Plugin",
        required: true,
        passed: true,
        version: "0.9.5",
        updateOutcome: "success",
      },
      {
        id: "claude-mcp",
        label: "Claude MCP",
        required: false,
        passed: true,
      },
    ],
    targetKind: "owned_relay",
  },
};

export const RevealedProgressively: Story = {
  args: {
    checks: baseChecks,
    revealedCount: 2,
  },
};

/**
 * ISS-5369's reason for existing: one unresolvable Claude binary. The CLI row
 * is the single proven fault; the five plugin rows below it could not be
 * determined at all, so they read `blocked` with a neutral mark and the card
 * states the one shared fix once instead of five times.
 */
export const ClaudeCliCascadeBlocked: Story = {
  args: {
    checks: [
      {
        id: "claude-cli",
        label: "Claude Code",
        required: true,
        passed: false,
        severity: CheckSeverity.Error,
        error: "Override path does not exist or is not executable",
        remediation: CLAUDE_CLI_REMEDIATION,
      },
      ...CLOSEDLOOP_PLUGIN_LABELS.map(([folder, label]) => ({
        id: `plugin-${folder}`,
        label,
        required: true,
        passed: false,
        severity: CheckSeverity.Blocked,
        blockedBy: "claude-cli",
        error: "Not checked, Claude CLI unavailable",
        remediation: `Fix the Claude CLI check first: ${CLAUDE_CLI_REMEDIATION}`,
      })),
    ],
  },
};

/**
 * The severity tiers side by side: a non-blocking `warning`, an
 * undeterminable `unknown` with no single blocker to name, an optional
 * `error` that must not read as destructive, and a required `error` that must.
 */
export const SeverityTiers: Story = {
  args: {
    checks: [
      {
        id: "git",
        label: "Git",
        required: true,
        passed: false,
        severity: CheckSeverity.Error,
        error: "Not found",
        remediation: "Install git and retry.",
      },
      {
        id: "app-version",
        label: "Gateway Version",
        required: false,
        passed: true,
        version: "0.16.69",
        severity: CheckSeverity.Warning,
        error: "Update available: 0.17.0",
        remediation: "Open the Closedloop Gateway app to update",
      },
      {
        id: "plugin-code",
        label: "Symphony Plugin",
        required: false,
        passed: false,
        severity: CheckSeverity.Unknown,
        error: "Could not verify enabled state",
        remediation:
          "Run: claude plugin enable code@closedloop-ai --scope user, then rerun System Check",
      },
      {
        id: "codex",
        label: "Codex CLI",
        required: false,
        passed: false,
        severity: CheckSeverity.Error,
        error: "Not installed",
        remediation: "Install the Codex CLI if you want to run Codex sessions.",
      },
    ],
  },
};

/**
 * ISS-5389: a failing row Repair cannot fix says so on the row itself, under
 * the remediation text it qualifies, rather than in a verdict panel above the
 * results. Short reasons, plus one repairable row that carries no note at all,
 * which is what keeps the note worth reading.
 */
export const BeyondRepairShortReason: Story = {
  args: {
    checks: [
      {
        id: "claude-cli",
        label: "Claude Code",
        required: true,
        passed: false,
        severity: CheckSeverity.Error,
        error: "Override path does not exist",
        remediation: CLAUDE_CLI_REMEDIATION,
        repair: {
          repairable: true,
          action: HealthCheckRepairAction.ClearBinaryOverride,
        },
      },
      {
        id: "app-version",
        label: "Gateway Version",
        required: true,
        passed: false,
        severity: CheckSeverity.Error,
        error: "1.2.0 available",
        remediation: "Update Desktop to continue.",
        repair: {
          repairable: false,
          reason: "Update the gateway app on that machine.",
        },
      },
      {
        id: "gh-auth",
        label: "GitHub Authentication",
        required: false,
        passed: false,
        severity: CheckSeverity.Error,
        error: "Not authenticated",
        remediation: "Run gh auth login.",
        repair: {
          repairable: false,
          reason: "Signing in needs a browser on that machine.",
        },
      },
    ],
  },
};

/**
 * The same note with a reason long enough to wrap. What to look at: the wrapped
 * lines stay on the `ml-6` indent under the row label, so the note reads as
 * belonging to this row and not to the one below it, and the info mark holds
 * its place on the first line instead of centering against the block.
 */
export const BeyondRepairLongReason: Story = {
  args: {
    checks: [
      {
        id: "app-version",
        label: "Gateway Version",
        required: true,
        passed: false,
        severity: CheckSeverity.Error,
        error: "1.2.0 available",
        remediation:
          "Update the Closedloop Gateway app, then run this check again.",
        repair: {
          repairable: false,
          reason:
            "Updating the Closedloop Gateway app has to happen on that machine, because the installer replaces the running app and asks for its own confirmation. Repair cannot do that from here, so open the gateway app on that machine, take the update it offers, and run this check again.",
        },
      },
      {
        id: "git",
        label: "Git",
        required: true,
        passed: true,
        version: "2.49.0",
      },
    ],
  },
};
