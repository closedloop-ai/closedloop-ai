import type { ComputeTargetServerCapabilities } from "@repo/api/src/types/compute-target";
import type { AgentSessionSyncTransportPayload } from "./agent-session-sync-contract.js";

export type CloudSocketStatus =
  | { state: "idle" }
  | { state: "online"; targetId: string }
  | { state: "degraded"; error: string };

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
  AckTimeout: "ack_timeout",
  FeatureDisabled: "feature_disabled",
  IngestionFailed: "ingestion_failed",
  RateLimited: "rate_limited",
  ValidationFailed: "validation_failed",
} as const;

export type DesktopAgentSessionsAckReason =
  (typeof DesktopAgentSessionsAckReason)[keyof typeof DesktopAgentSessionsAckReason];

export type DesktopAgentSessionsAck =
  | { accepted: true }
  | { accepted: false; reason: DesktopAgentSessionsAckReason };

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
