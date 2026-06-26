"use client";

import type {
  AgentStatus,
  Harness,
  SessionStatus,
} from "@repo/app/agents/lib/session-types";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import type { Tone } from "@repo/design-system/components/ui/types";

type StatusBadgeConfig = { label: string; tone: Tone; pulse?: boolean };

const sessionStatusConfig: Record<SessionStatus, StatusBadgeConfig> = {
  active: { label: "Active", tone: "success", pulse: true },
  waiting: { label: "Waiting", tone: "accent", pulse: true },
  completed: { label: "Completed", tone: "muted" },
  error: { label: "Error", tone: "danger" },
  abandoned: { label: "Abandoned", tone: "warning" },
};

const agentStatusConfig: Record<AgentStatus, StatusBadgeConfig> = {
  working: { label: "Working", tone: "success", pulse: true },
  waiting: { label: "Waiting", tone: "accent", pulse: true },
  completed: { label: "Completed", tone: "muted" },
  error: { label: "Error", tone: "danger" },
  idle: { label: "Idle", tone: "default" },
};

const harnessConfig: Record<string, { label: string; tone: Tone }> = {
  claude: { label: "Claude", tone: "accent" },
  codex: { label: "Codex", tone: "info" },
  cursor: { label: "Cursor", tone: "warning" },
  copilot: { label: "Copilot", tone: "success" },
  opencode: { label: "OpenCode", tone: "danger" },
};

function resolveStatusConfig(
  status: string,
  config: Record<string, StatusBadgeConfig>
): StatusBadgeConfig {
  if (status in config) {
    return config[status];
  }

  if (status === "failed") {
    return { label: "Failed", tone: "danger" };
  }

  return {
    label: status.replace(/[-_]/g, " "),
    tone: "danger",
  };
}

export function SessionStatusBadge({
  status,
}: {
  status: SessionStatus | string;
}) {
  const config = resolveStatusConfig(status, sessionStatusConfig);
  return (
    <ToneBadge label={config.label} pulse={config.pulse} tone={config.tone} />
  );
}

export function AgentStatusBadge({ status }: { status: AgentStatus | string }) {
  const config = resolveStatusConfig(status, agentStatusConfig);
  return (
    <ToneBadge label={config.label} pulse={config.pulse} tone={config.tone} />
  );
}

export function HarnessBadge({ harness }: { harness?: Harness | null }) {
  const config = harnessConfig[(harness || "claude").toLowerCase()] || {
    label: harness || "Claude",
    tone: "accent" as const,
  };

  return <ToneBadge label={config.label} tone={config.tone} />;
}
