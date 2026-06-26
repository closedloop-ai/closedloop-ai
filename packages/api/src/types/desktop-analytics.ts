import type { JsonValue } from "./common";

export const DESKTOP_ANALYTICS_SOCKET_EVENT = "desktop.analytics" as const;
export const DESKTOP_SERVER_ANALYTICS_RELAY_FLAG =
  "desktop-server-analytics-relay" as const;

export const DesktopAnalyticsAckReason = {
  FeatureDisabled: "feature_disabled",
  RateLimited: "rate_limited",
  ValidationFailed: "validation_failed",
  CaptureFailed: "capture_failed",
} as const;

export type DesktopAnalyticsAckReason =
  (typeof DesktopAnalyticsAckReason)[keyof typeof DesktopAnalyticsAckReason];

export type DesktopAnalyticsAck =
  | { accepted: true }
  | { accepted: false; reason: DesktopAnalyticsAckReason };

export const DesktopAnalyticsEventName = {
  AgentSessionSyncBatchFailed: "agent_session_sync_batch_failed",
  CommandInitiated: "command_initiated",
  CommandStarted: "command_started",
  CommandCompleted: "command_completed",
  CommandFailed: "command_failed",
  ApprovalRequested: "approval_requested",
  ApprovalResolved: "approval_resolved",
  DesktopConnectionEstablished: "desktop_connection_established",
  DesktopReconnectionResumed: "desktop_reconnection_resumed",
  DesktopConnectionDegraded: "desktop_connection_degraded",
  DesktopConnectionLost: "desktop_connection_lost",
  DesktopPopUnavailable: "desktop_pop_unavailable",
  PluginUpdateAttempted: "plugin_update_attempted",
  PluginUpdateSucceeded: "plugin_update_succeeded",
  PluginUpdateFailed: "plugin_update_failed",
  SandboxBlockedOperation: "sandbox_blocked_operation",
  HealthcheckFailureDetected: "healthcheck.failure_detected",
  HealthcheckFailurePersistent: "healthcheck.failure_persistent",
  HealthcheckRecovered: "healthcheck.recovered",
} as const;

export type DesktopAnalyticsEventName =
  (typeof DesktopAnalyticsEventName)[keyof typeof DesktopAnalyticsEventName];

export type DesktopAnalyticsPayload = {
  event: DesktopAnalyticsEventName;
  properties: Record<string, JsonValue>;
  occurredAt: string;
};
