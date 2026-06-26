import type {
  AgentSessionSyncMode,
  SyncedAgentSession as SharedSyncedAgentSession,
  SyncedAgentSessionAgent as SharedSyncedAgentSessionAgent,
  SyncedAgentSessionEvent as SharedSyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import type { BillingMode } from "../shared/billing-mode.js";

// Re-export canonical shared types
export type {
  ActivityBucket,
  PhaseIterations,
  PhaseLoopback,
  SessionMarker,
  SessionPhase,
  SessionPR,
  SessionSpan,
  SessionThrottle,
  SessionTraceCorrectionSource,
  SessionTracePhaseSource,
  SessionTraceThrottleSource,
  SyncedAgentSessionAttribution,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";

export const AGENT_SESSION_SYNC_SCHEMA_VERSION = 1 as const;

// Desktop-specific JSON aliases (structurally identical to JsonObject/JsonValue)
export type SyncJsonObject = JsonObject;
export type SyncJsonValue = JsonValue;

// Desktop-specific sub-types (re-exported with desktop-consistent names)
export type SyncedAgentSessionAgent = SharedSyncedAgentSessionAgent;
export type SyncedAgentSessionEvent = SharedSyncedAgentSessionEvent;

/**
 * Desktop agent session with additional desktop-only fields
 * (billingMode, userId, organizationId) that the shared type omits
 * because they are added by the desktop sync pipeline before cloud delivery.
 */
export type SyncedAgentSession = SharedSyncedAgentSession & {
  billingMode?: BillingMode | null;
  userId?: string | null;
  organizationId?: string | null;
};

export type AgentSessionSyncBatch = {
  schemaVersion: typeof AGENT_SESSION_SYNC_SCHEMA_VERSION;
  batchId: string;
  syncMode: AgentSessionSyncMode;
  sessionCount: number;
  sessions: SyncedAgentSession[];
};
