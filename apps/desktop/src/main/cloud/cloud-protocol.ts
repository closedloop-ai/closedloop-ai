import type { DesktopAgentSessionsAck as CanonicalDesktopAgentSessionsAck } from "@repo/api/src/types/agent-session";
import type { ComputeTargetServerCapabilities } from "@repo/api/src/types/compute-target";
import type { CloudSocketState } from "../../shared/cloud-socket-error.js";
import type { AgentSessionSyncTransportPayload } from "../agent-sync/agent-session-sync-contract.js";

export type CloudSocketStatus =
  | { state: typeof CloudSocketState.Idle }
  | { state: typeof CloudSocketState.Online; targetId: string }
  | { state: typeof CloudSocketState.Degraded; error: string };

export type ProtocolVersion = "1";

export const PROTOCOL_VERSION: ProtocolVersion = "1";

export type ProtocolEnvelope = {
  protocolVersion: ProtocolVersion;
  messageId: string;
  timestamp: string;
};

export interface DesktopHelloEvent extends ProtocolEnvelope {
  computeTargetId?: string;
  gatewayId?: string;
  desktopSecurityUpgradeProtocolVersion?: 1;
  machineName: string;
  platform: NodeJS.Platform;
  pluginVersion: string;
  /** Electron app version (from app.getVersion()), distinct from the gateway wire protocol version. */
  desktopClientVersion: string;
  /**
   * Gateway wire-protocol version (e.g. "0.1.0"), distinct from ProtocolEnvelope.protocolVersion
   * which identifies the Socket.IO envelope schema version ("1", "2", …).
   */
  gatewayProtocolVersion: string;
  supportedOperations: string[];
  maxInFlightCommands: number;
  allowedDirectoriesHash: string;
  capabilities?: Record<string, unknown>;
}

export interface DesktopHelloAckEvent extends ProtocolEnvelope {
  computeTargetId: string;
  sessionId: string;
  serverTime: string;
  resumeFromSequence?: Record<string, number>;
  serverCapabilities?: ComputeTargetServerCapabilities;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface DesktopCommandEvent extends ProtocolEnvelope {
  commandId: string;
  operationId: string;
  method: HttpMethod;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: unknown;
  timeoutMs?: number;
  queuedAt?: string;
  lockKey?: string;
  requiresApproval?: boolean;
  approvalReason?: string;
  signature?: string;
  signaturePayload?: string;
  publicKeyFingerprint?: string;
}

export interface DesktopCommandAckEvent extends ProtocolEnvelope {
  commandId: string;
  accepted: boolean;
  state?: "accepted" | "failed";
  reason?: string;
}

export type CommandStreamEventType =
  | "status"
  | "chunk"
  | "result"
  | "error"
  | "done";

export interface DesktopCommandStreamEvent extends ProtocolEnvelope {
  commandId: string;
  sequence: number;
  eventType: CommandStreamEventType;
  data: unknown;
}

export interface DesktopCommandStreamAckEvent extends ProtocolEnvelope {
  commandId: string;
  sequence: number;
}

export interface DesktopCancelEvent extends ProtocolEnvelope {
  commandId: string;
  reason?: string;
}

export interface DesktopPresenceEvent extends ProtocolEnvelope {
  state: "online" | "degraded" | "paused";
  error?: string;
  activeCommands?: number;
  queueDepth?: number;
}

export const DESKTOP_ANALYTICS_SOCKET_EVENT = "desktop.analytics" as const;
export const DESKTOP_AGENT_SESSIONS_SOCKET_EVENT =
  "desktop.agent-sessions" as const;

export const DesktopAnalyticsAckReason = {
  FeatureDisabled: "feature_disabled",
  RateLimited: "rate_limited",
  ValidationFailed: "validation_failed",
} as const;

export type DesktopAnalyticsAckReason =
  (typeof DesktopAnalyticsAckReason)[keyof typeof DesktopAnalyticsAckReason];

export type DesktopAnalyticsAck =
  | { accepted: true }
  | { accepted: false; reason: DesktopAnalyticsAckReason };

export const DesktopAgentSessionsAckReason = {
  /**
   * The SERVER answered that it gave up on this batch (HTTP 408). Attributable
   * to the batch itself (oversized/slow payload), so it burns the session's
   * bounded timeout budget toward a dead-letter.
   *
   * ISS-5088: this no longer covers a CLIENT-side abort — see
   * {@link DesktopAgentSessionsAckReason.TransportTimeout}.
   */
  AckTimeout: "ack_timeout",
  FeatureDisabled: "feature_disabled",
  IngestionFailed: "ingestion_failed",
  // FEA-3792 (PRD-536 D9): `RateLimited` was overloaded across a genuine
  // server-side throttle AND local transport unavailability (relay not ready /
  // socket disconnected after the batch was prepared). Split them so backoff /
  // retry logic and telemetry stop reverse-engineering the cause via a racy
  // post-hoc `isHttpReady()` re-read. `RateLimited` now means ONLY a server
  // throttle (received over the wire); `TransportUnavailable` is a desktop-local
  // reason the client returns without ever reaching the server.
  RateLimited: "rate_limited",
  /**
   * FEA-3425, client-only: the HTTP transport's coded 403 — the sent
   * computeTargetId is not owned by the authenticated identity. Waiting cannot
   * fix a wrong id, so the sync service defers WITHOUT burning any retry
   * budget and surfaces the condition loudly; identity re-resolves via the
   * normal hello/refresh path.
   */
  TargetNotOwned: "target_not_owned",
  /**
   * ISS-5088, client-only: the local request aborted at its own timeout without
   * the server ever answering. Split out of {@link
   * DesktopAgentSessionsAckReason.AckTimeout} because the two mean opposite
   * things for blame: a server-answered 408 is attributable to THIS batch, while
   * a client-side abort is a LANE-WIDE stall (the transport, not the payload) —
   * production ISS-5088 windows show the session lane, the component lane, and
   * the relay socket's ping all timing out together, which one session's payload
   * cannot cause. Per `main/sync/AGENTS.md` invariant 4 a lane-wide failure must
   * not burn a row's retry budget, so this reason carries its own bounded budget
   * that is REFUNDED once the lane observes unambiguous connectivity loss.
   */
  TransportTimeout: "transport_timeout",
  TransportUnavailable: "transport_unavailable",
  /**
   * FEA-3425, client-only: the HTTP transport had no session token or the
   * server rejected it (401). Auth loss must pause the lane with all retry
   * budgets intact — it is never a payload problem.
   */
  Unauthenticated: "unauthenticated",
  ValidationFailed: "validation_failed",
} as const;

export type DesktopAgentSessionsAckReason =
  (typeof DesktopAgentSessionsAckReason)[keyof typeof DesktopAgentSessionsAckReason];

/**
 * The ACCEPTED arm, DERIVED from the canonical `packages/api` ack rather than
 * restated here (ISS-6202).
 *
 * It used to be a hand-copied `{ accepted: true; acceptedSessionIds?: string[] }`
 * sitting one repo away from the type the server actually serializes, so a field
 * added or narrowed there would have gone unnoticed here until a payload arrived
 * that this build could not read. Extracting it means the success shape has one
 * owner and `tsc` reports the drift.
 *
 * Only the SUCCESS arm is shared. The failure arm below stays desktop-owned
 * because {@link DesktopAgentSessionsAckReason} is a deliberate superset: the
 * client-only reasons (`transport_timeout`, `target_not_owned`,
 * `unauthenticated`, …) are verdicts the desktop reaches without the server ever
 * answering, so they cannot come from a wire contract.
 */
export type DesktopAgentSessionsAcceptedAck = Extract<
  CanonicalDesktopAgentSessionsAck,
  { accepted: true }
>;

export type DesktopAgentSessionsAck =
  | DesktopAgentSessionsAcceptedAck
  | {
      accepted: false;
      reason: DesktopAgentSessionsAckReason;
      /**
       * ISS-5090: the server's stable, value-free field/path summary for a
       * rejection, when it sent one. Optional and additive (an older API omits
       * it); logged only, never used to classify or retry.
       */
      detail?: string;
    };

export type DesktopAgentSessionsEvent = ProtocolEnvelope &
  AgentSessionSyncTransportPayload;

export const DesktopAnalyticsEventName = {
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
  AgentSessionSyncBatchFailed: "agent_session_sync_batch_failed",
} as const;

export type DesktopAnalyticsEventName =
  (typeof DesktopAnalyticsEventName)[keyof typeof DesktopAnalyticsEventName];

export interface DesktopAnalyticsEvent extends ProtocolEnvelope {
  event: DesktopAnalyticsEventName;
  properties?: Record<string, unknown>;
  occurredAt: string;
}

export type CommandEventRecord = {
  sequence: number;
  eventType: CommandStreamEventType;
  data: unknown;
};
