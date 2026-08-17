import type {
  AgentSessionSyncMode,
  SyncedAgentSession as SharedSyncedAgentSession,
  SyncedAgentSessionAgent as SharedSyncedAgentSessionAgent,
  SyncedAgentSessionEvent as SharedSyncedAgentSessionEvent,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import type { BillingMode } from "../../shared/billing-mode.js";

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
  SyncedAgentSessionChunkMeta,
  SyncedAgentSessionTokenEvent,
  SyncedAgentSessionTokenUsage,
  SyncedComponent,
} from "@repo/api/src/types/agent-session";
export type {
  AgentComponentCursorRow,
  DesktopAgentComponentsPayload,
} from "./agent-session-sync-source.js";

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
  /**
   * FEA-4138: optional, additive declaration of how the batch was serialized on
   * the wire. Omitted / `identity` = the legacy uncompressed JSON shape every
   * pre-FEA-4138 server assumes. `gzip` means the transport gzip-compressed this
   * batch (and stamped `Content-Encoding: gzip`); it is set ONLY after the
   * server advertised the `agentSessionSyncCompression` capability. The field is
   * informational — the server dispatches decompression on the HTTP header, not
   * this field, because the body is opaque compressed bytes until decoded — but
   * it is kept in the contract so the batch is self-describing once decompressed.
   */
  encoding?: SyncPayloadEncoding;
  /**
   * Goal stage 2 (atomic row-level ack): declares that this client can parse
   * `acceptedSessionIds` on the success response. Optional + additive: an old
   * server strips it (non-strict request schema) and responds with the legacy
   * `{ synced: true }` shape, which the client treats as a whole-batch ack.
   * Request-gating is mandatory — installed desktops `.strict()`-parse the
   * success response, so the server may never add the field unrequested.
   */
  wantsAcceptedSessionIds?: boolean;
};

// FEA-2718: the event-fragment transports were retired; a sync payload is now
// always a whole-session batch.
export type AgentSessionSyncTransportPayload = AgentSessionSyncBatch;

/**
 * ISS-4546 (PR #4098 review, shafty023): the closed set of sync classes a durable
 * outbox row / an outbox enqueue can carry — which lane discovered the row
 * (backfill vs incremental), recorded for diagnostics only. Owned here as ONE
 * canonical const object + type so the `AgentSessionOutboxEntry` contract, the
 * outbox writers, the sync service, and the tests all reference the same closed
 * union instead of re-declaring the `"backfill" | "incremental"` literal in
 * parallel (which lets the writer and service drift independently the next time a
 * class is added). Lives in this lightweight contract module (no Zod / parser
 * imports) so bundle-sensitive consumers can import just the value/type.
 */
export const AgentSessionSyncClass = {
  Backfill: "backfill",
  Incremental: "incremental",
} as const;
export type AgentSessionSyncClass =
  (typeof AgentSessionSyncClass)[keyof typeof AgentSessionSyncClass];
