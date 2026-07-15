import type {
  AgentSessionSyncMode,
  SyncedAgentSession as SharedSyncedAgentSession,
  SyncedAgentSessionAgent as SharedSyncedAgentSessionAgent,
  SyncedAgentSessionEvent as SharedSyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import type { BillingMode } from "../shared/billing-mode.js";

// Re-export canonical shared types
// T-8.8: re-export component sync contract types
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
  SyncedAgentSessionAnalytics,
  SyncedAgentSessionAttribution,
  SyncedAgentSessionTokenEvent,
  SyncedAgentSessionTokenUsage,
  SyncedComponent,
} from "@repo/api/src/types/agent-session";
export type {
  AgentComponentCursorRow,
  DesktopAgentComponentsPayload,
} from "./agent-session-sync-service.js";

// Desktop mirror of the shared `@repo/api` constant of the same name, kept as a
// hardcoded copy so the desktop main-process bundle need not import a runtime
// value from `@repo/api`. It MUST stay in lockstep with the shared constant —
// FEA-2718 (PLN-1294) bumped both 1 → 2 so the API rejects stale (v1) desktop
// payloads instead of silently accepting the pre-FEA-2718 shape.
export const AGENT_SESSION_SYNC_SCHEMA_VERSION = 2 as const;

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

// FEA-2718: the event-fragment transports were retired; a sync payload is now
// always a whole-session batch.
export type AgentSessionSyncTransportPayload = AgentSessionSyncBatch;
