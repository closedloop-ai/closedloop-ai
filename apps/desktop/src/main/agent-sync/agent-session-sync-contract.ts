import {
  type AgentSessionSyncMode,
  type SyncedAgentSession as SharedSyncedAgentSession,
  type SyncedAgentSessionAgent as SharedSyncedAgentSessionAgent,
  type SyncedAgentSessionEvent as SharedSyncedAgentSessionEvent,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { BillingMode } from "../../shared/billing-mode.js";

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
  SyncedAgentSessionAnalytics,
  SyncedAgentSessionAttribution,
  SyncedAgentSessionChunkMeta,
  SyncedAgentSessionTokenEvent,
  SyncedAgentSessionTokenUsage,
  SyncedComponent,
} from "@repo/api/src/types/agent-session";

// Desktop mirror of the shared `@repo/api` constant of the same name, kept as a
// hardcoded copy so the desktop main-process bundle need not import a runtime
// value from `@repo/api`. It MUST stay in lockstep with the shared constant: it
// is the version THIS build stamps on every batch it sends (FEA-2718 / PLN-1294
// bumped both 1 → 2 when turn text left the event schema).
//
// ISS-6886: the API no longer pins acceptance to this literal. It accepts every
// member of `ACCEPTED_AGENT_SESSION_SYNC_SCHEMA_VERSIONS` in `@repo/api`, so an
// installed v1 desktop syncs instead of parking its whole lane behind a
// `schema_version_invalid` defer. That defer (see
// `agent-session-sync-validation-failure.ts`) is unchanged and still correct: it
// now fires only for a version the server genuinely does not know.
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
  /**
   * ISS-5801: count of this session's locally materialized component
   * invocations (`agent_component_invocations`), hydrated unconditionally by
   * `sync-source.ts`. The widened substantive predicate reads it so an
   * invocation-only (slash/skill/subagent/hook) session uploads instead of
   * being withheld while its invocation children queue — the ISS-5801 orphan
   * class. Emitted on the wire only when positive; the cloud derives its own
   * column at generation activation and never reads this field.
   */
  componentInvocationCount?: number | null;
  /** Exact local Sessions list count when the list read omits agent graphs. */
  listAgentCount?: number;
  /** Exact local Sessions list tool count when the list read omits event rows. */
  listToolUseCount?: number;
  /** Exact local Sessions list error count when the list read omits event rows. */
  listErrorCount?: number;
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
  /**
   * ISS-7516: the data-sync level this machine was on when the batch was built,
   * so the cloud can tell a transcript that was never queued from one still in
   * flight. Optional + additive: omitted when the runtime wires no level, and
   * stripped by a server that predates the field (non-strict request schema).
   *
   * Declared HERE as well as on the shared `DesktopAgentSessionsPayload` because
   * this type is the desktop's own view of the batch and is what `buildBatch`
   * returns; a field only on the shared type is spread through at runtime but
   * invisible to every desktop-side reader and assertion.
   */
  dataSyncLevel?: DataSyncLevel;
};

// FEA-2718: the event-fragment transports were retired; a sync payload is now
// always a whole-session batch.
export type AgentSessionSyncTransportPayload = AgentSessionSyncBatch;

/**
 * ISS-4546 (PR #4098 review, davetho): the closed set of sync classes a durable
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

/**
 * Everything {@link buildAgentSessionSyncBatch} needs to emit one envelope.
 *
 * Named (ISS-8327) rather than inlined on the function so the envelope BYTE
 * RESERVE can be derived by enumerating this shape's own value domain. Adding a
 * field here fails `tsc` in `agent-session-sync-envelope-reserve.ts` until the
 * reserve names the values it must be measured across — which is what stops a
 * new field from widening the wire envelope while the reserve stays put, the
 * defect ISS-7775 and this ticket both landed on.
 */
export type AgentSessionSyncBatchInput = {
  batchId: string;
  syncMode: AgentSessionSyncMode;
  sessions: SyncedAgentSession[];
  compress: boolean;
  dataSyncLevel: DataSyncLevel | undefined;
};

/**
 * Build the ONE desktop→cloud sync batch envelope.
 *
 * Extracted (ISS-7775) because it existed TWICE and both copies knew it: the
 * fresh-drain builder in `agent-session-sync-service.ts` and the pending-chunk
 * builder in `agent-session-sync-pending-chunks.ts`, whose comments said
 * "exactly as the fresh-drain `buildBatch` does" — twice, once for
 * `dataSyncLevel` (ISS-7516) and once for `wantsAcceptedSessionIds` (PR #4862),
 * each recording a field the chunk path had silently omitted until someone
 * noticed. Two envelopes that must agree, kept in agreement by a comment, is the
 * arrangement that produced both of those bugs; there is now one.
 *
 * `encoding` and `dataSyncLevel` are OMITTED rather than sent as `null` when
 * absent, which is what a server predating either field expects.
 */
export function buildAgentSessionSyncBatch(
  input: AgentSessionSyncBatchInput
): AgentSessionSyncBatch {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: input.batchId,
    syncMode: input.syncMode,
    sessionCount: input.sessions.length,
    sessions: input.sessions,
    ...(input.compress ? { encoding: SyncPayloadEncoding.Gzip } : {}),
    ...(input.dataSyncLevel === undefined
      ? {}
      : { dataSyncLevel: input.dataSyncLevel }),
    // Goal stage 2: request the per-session ack echo (additive in both skew
    // directions — an old server strips it and answers whole-batch). REQUEST-
    // GATED server-side, so a path that omitted it got a legacy whole-batch ack
    // and durably cleared the outbox — the accept-without-persist hole stage 2
    // exists to close (PR #4862, on the chunk path).
    wantsAcceptedSessionIds: true,
  };
}
