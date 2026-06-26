import type { CheckResult } from "@repo/api/src/types/compute-target";
import type { Meta, StoryObj } from "@storybook/react";
import {
  SystemCheckResults,
  type SystemCheckResultsRemediationClick,
  type SystemCheckResultsRemediationView,
} from "./system-check-results";

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

const meta = {
  title: "App Core/Compute/System Check Results",
  component: SystemCheckResults,
  args: {
    checks: baseChecks,
    pluginAutoUpdateEnabled: true,
    onStructuredRemediationViewed: (
      _payload: SystemCheckResultsRemediationView
    ) => {},
    onStructuredRemediationLinkClick: (
      _payload: SystemCheckResultsRemediationClick
    ) => {},
  },
} satisfies Meta<typeof SystemCheckResults>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

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
