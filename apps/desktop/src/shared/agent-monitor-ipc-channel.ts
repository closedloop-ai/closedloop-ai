/** IPC channel names the agent-monitor handler registers and the preload bridge invokes. */
export const AgentMonitorIpcChannel = {
  GetAgentMonitorUrl: "desktop:get-agent-monitor-url",
  GetAgentMonitorIngestProgress: "desktop:get-agent-monitor-ingest-progress",
  SetAgentMonitorImportPaused: "desktop:set-agent-monitor-import-paused",
  // FEA-3639: re-run the idempotent boot import after the user grants a
  // previously-denied file-access permission, so the now-readable sessions
  // backfill without an app restart.
  ReimportAgentSessions: "desktop:reimport-agent-sessions",
  ReprocessAgentLogs: "desktop:reprocess-agent-logs",
  OpenAgentMonitor: "desktop:open-agent-monitor",
  GetAgentMonitorHooksEnabled: "desktop:get-agent-monitor-hooks-enabled",
  SetAgentMonitorHooksEnabled: "desktop:set-agent-monitor-hooks-enabled",
} as const;

export type AgentMonitorIpcChannel =
  (typeof AgentMonitorIpcChannel)[keyof typeof AgentMonitorIpcChannel];
