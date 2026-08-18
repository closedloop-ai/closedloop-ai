import { z } from "zod";
import type { JsonValue } from "./common";

export const DESKTOP_ANALYTICS_SOCKET_EVENT = "desktop.analytics" as const;
export const DESKTOP_SERVER_ANALYTICS_RELAY_FLAG =
  "desktop-server-analytics-relay" as const;

/**
 * Maximum length (UTF-16 code units) the cloud accepts for any single string
 * property value. The server schema rejects the entire event when a value
 * exceeds this, so Desktop clamps each string to this length before sending.
 * Shared here so the sender-side clamp and the server-side cap stay in lockstep.
 */
export const DESKTOP_ANALYTICS_STRING_MAX_LENGTH = 512;

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

/**
 * FEA-3425: success payload of `POST /desktop/analytics`. Not `.strict()`:
 * Desktop and API deploy independently and are version-skewed, so an additive
 * server field must degrade gracefully (ignored) rather than fail parsing and
 * silently drop the whole capture on a skewed client.
 */
export const desktopAnalyticsCaptureResponseValidator = z.object({
  captured: z.literal(true),
});
export type DesktopAnalyticsCaptureResponse = z.infer<
  typeof desktopAnalyticsCaptureResponseValidator
>;

/**
 * FEA-3425: full `ApiResult` envelope of `POST /desktop/analytics`. The success
 * arm is not `.strict()` (see {@link desktopAnalyticsCaptureResponseValidator})
 * so additive server fields degrade gracefully; the error arm stays
 * `.passthrough()` so the `code` metadata survives.
 */
export const desktopAnalyticsCaptureApiResultValidator = z.union([
  z.object({
    success: z.literal(true),
    data: desktopAnalyticsCaptureResponseValidator,
  }),
  z
    .object({
      success: z.literal(false),
      error: z.string(),
    })
    .passthrough(),
]);
export type DesktopAnalyticsCaptureApiResult = z.infer<
  typeof desktopAnalyticsCaptureApiResultValidator
>;
