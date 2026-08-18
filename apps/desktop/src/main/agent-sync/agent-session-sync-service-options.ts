/**
 * Construction, start, telemetry, and progress contracts for
 * `AgentSessionSyncService` — the options bag the desktop runtime wires it with,
 * the per-send transport hints, the failure-only product-analytics event, and the
 * content-blind progress snapshot the renderer reads.
 *
 * Extracted verbatim from `agent-session-sync-service.ts` (ISS-4676).
 */
import type {
  AgentSessionSyncMode,
  SyncedComponent,
} from "@repo/api/src/types/agent-session";
import type {
  DesktopAgentSessionsAck,
  DesktopAgentSessionsAckReason,
} from "../cloud/cloud-protocol.js";
import type {
  DesktopSyncBatchEventInput,
  DesktopSyncBatchOutcome,
} from "../telemetry/app-otel-runtime.js";
import type { ComponentSyncSendResult } from "./agent-component-sync-dead-letter.js";
import type { AgentSessionSyncTransportPayload } from "./agent-session-sync-contract.js";
import type { AgentSessionPayloadPreparer } from "./agent-session-sync-payload.js";
import type {
  AgentComponentCursorRow,
  AgentSessionSyncSource,
  DesktopAgentComponentsPayload,
} from "./agent-session-sync-source.js";

export type AgentSessionSyncTelemetryEvent = {
  outcome: typeof DesktopSyncBatchOutcome.Failure;
  reason: DesktopAgentSessionsAckReason;
  syncMode: AgentSessionSyncMode;
  sessionCount: number;
  payloadBytes: number;
};

/**
 * FEA-4138: per-send transport hints. `compress` asks the transport to gzip the
 * body and stamp `Content-Encoding: gzip`; it is only set when the server
 * negotiated decompression, and the accumulation loop already sized the batch
 * against the same compressed bytes.
 */
export type AgentSessionSyncSendOptions = {
  compress?: boolean;
};

export type AgentSessionSyncServiceOptions = {
  /**
   * FEA-3425 (Phase 4a): is the HTTP write transport ready — a live first-party
   * session AND a connected cloud (computeTargetId is hello-derived, D6)? This
   * is the only transport since the relay socket write path was retired; there
   * is no socket fallback to select.
   */
  isHttpReady: () => boolean;
  /**
   * PRD-532 §7 consent gate for the session-metadata lane. Returns whether the
   * user's chosen `syncObservabilityTier` permits counts/aggregates to leave the
   * machine. Omitted (undefined) means "not gated" — today's behavior, so
   * existing callers and tests are unaffected. When provided and it returns
   * false (tier `local`, or `null`/not-yet-consented), `shouldRun()` returns
   * false and NO cloud sync occurs regardless of the other preconditions. See
   * `syncTierAllowsSessionMetadata` in `../shared/contracts.js`.
   */
  isCloudSyncTierAllowed?: () => boolean;
  /**
   * FEA-4138: has the server advertised the `agentSessionSyncCompression`
   * hello-ack capability (it can accept + decompress a gzip sync body)? When
   * this returns true the service sizes the cap/chunk decision against
   * compressed bytes and asks the transport to gzip the batch; when omitted or
   * false it stays on the legacy uncompressed + chunker path. Negotiated per
   * hello-ack, so it flips false on disconnect and re-arms on the next ack —
   * skew-safe in both directions.
   */
  isSyncCompressionSupported?: () => boolean;
  /**
   * ISS-4541: has the server advertised the `agentSessionSyncActivityChunking`
   * hello-ack capability (it merges a multi-part activity-segment tiling
   * additively)? When true the payload preparer PAGINATES an oversized session's
   * tiling across chunks so the FULL tiling reaches the cloud; when omitted or
   * false the tiling rides the base whole — which either fits or dead-letters the
   * whole session for a larger-payload retry, never a silent truncation.
   * Negotiated per hello-ack (flips false on disconnect, re-arms on the next
   * ack), so it is skew-safe in both directions.
   */
  isSyncActivityChunkingSupported?: () => boolean;
  /** True only after hello negotiation accepts the ISS-6060 ref carrier. */
  isSyncMonitoredActivitySupported?: () => boolean;
  sendBatch: (
    batch: AgentSessionSyncTransportPayload,
    options?: AgentSessionSyncSendOptions
  ) => Promise<DesktopAgentSessionsAck>;
  /** Live dashboard source for SQLite. */
  getSource?: () => AgentSessionSyncSource | null;
  /**
   * Optional scheduler gate before DB reads, payload shaping, and transport
   * serialization. It must only delay work; sync semantics and payload caps stay
   * owned by this service.
   */
  waitForBackgroundSlot?: () => Promise<void>;
  /**
   * Prepares sanitized, size-checked, and chunked payloads. Production wires a
   * worker-backed implementation so large transcript walks do not run on the
   * Electron main thread; tests default to the in-process pure implementation.
   */
  preparePayloads?: AgentSessionPayloadPreparer;
  onBatchOutcome?: (event: AgentSessionSyncTelemetryEvent) => void;
  /**
   * FEA-1995: per-batch transport-health telemetry sink for the `sync.*`
   * contract schema. Fires on every batch outcome — `success`, `failure`
   * (including a thrown transport error), and `dead_letter` — distinct from
   * `onBatchOutcome`, which is a failure-only product-analytics signal. Routed
   * to the desktop OTel runtime, which owns the `DesktopSyncBatchEventInput`
   * shape (transport health only: counts, bytes, latency, outcome — never
   * session ids or content, per the PRD-468/FEA-1981 guardrail).
   */
  onSyncBatchTelemetry?: (event: DesktopSyncBatchEventInput) => void;
  /**
   * FEA-1962: the authenticated compute target the cursor is scoped to. Returns
   * `null` when none is known yet (offline / pre-hello-ack) → the service runs
   * in-memory-only (full-backfill-on-restart, today's behavior). When the target
   * changes, the in-memory cursor resets and re-hydrates so one compute target
   * never inherits another's persisted watermark.
   */
  getSyncComputeTargetId?: () => string | null;
  /**
   * T-8.7: optional transport for the component inventory sync lane. When
   * provided, each 5s tick also batch-reads updated `agent_components` from the
   * local SQLite store and POSTs them to `POST /desktop/components/sync`.
   * ISS-4542: resolves a {@link ComponentSyncSendResult} classifying the send —
   * `Accepted` (advance the cursor), `LaneFailure` (pause without advancing or
   * charging the poison budget), or `BatchRejected` (charge the bounded
   * dead-letter budget). The cursor is NOT advanced except on `Accepted` or once
   * a `BatchRejected` batch has exhausted its bounded in-place retries.
   */
  sendComponents?: (
    payload: DesktopAgentComponentsPayload
  ) => Promise<ComponentSyncSendResult>;
  /**
   * T-8.7: keyset cursor reader for the component inventory sync lane. Returns
   * rows from `agent_components` ordered by (last_seen_at, id) STRICTLY AFTER
   * the `(sinceTs, sinceId)` keyset position (`('', '')` = full backfill).
   * Includes tombstoned rows.
   */
  listComponentCursorRows?: (
    sinceTs: string,
    sinceId: string,
    limit: number
  ) => Promise<AgentComponentCursorRow[]>;
  /**
   * T-8.7: full-row loader for component inventory sync. Returns the
   * `SyncedComponent`-shaped rows for the given component ids.
   */
  loadComponentRows?: (ids: string[]) => Promise<SyncedComponent[]>;
};

export type AgentSessionSyncStartOptions = {
  /**
   * Queue every known historical session on startup. Boot passes false so the
   * first interactive Desktop window is not competing with a bulk cloud backfill;
   * live sessions are still picked up through the established cursor.
   */
  historicalBackfill?: boolean;
};

/**
 * FEA-2733: a content-blind snapshot of local→cloud sync progress for the
 * renderer "syncing your history" indicator. Counts only — never session ids or
 * content — mirroring the service's telemetry-only outward contract. Read via
 * `getSyncProgress()` and folded into the desktop runtime-status payload.
 */
export type AgentSessionSyncProgress = {
  /** The service is running for an authenticated compute-target identity. */
  identified: boolean;
  /** Historical sessions still queued for the first-connect backfill walk. */
  pendingBackfillSessions: number;
  /** Recently-changed sessions still queued for incremental sync. */
  pendingIncrementalSessions: number;
  /** A bulk historical backfill is currently draining. */
  backfilling: boolean;
  /**
   * The initial cursor enumeration has run for the current identity AND every
   * session-sync queue is drained with no pending parts. Stays false until the
   * first backfill pass runs, so it never flashes true before the walk begins.
   *
   * **This is a PER-LANE signal and must never be presented as a whole-app
   * completeness claim (ISS-5768).** It is scoped to the session
   * backfill/incremental lanes — one of the five in `main/sync/AGENTS.md`. It
   * does NOT reflect the separately-cursored component-inventory lane, the
   * invocation-parts lane, the transcript archive, or trace comments, and it can
   * be true while `deadLetteredSessions > 0`.
   *
   * Each exclusion is individually defensible; together they let a user-facing
   * indicator read "Up to date" on a machine owing 2,985 component-inventory
   * rows with one item dead-lettered, beside a `Cloud (partial)` badge reading
   * the whole-app aggregate and saying exactly that. So the completeness claim
   * moved: the renderer now derives it from `resolveCloudSyncBacklog` over the
   * burn-down's every-lane snapshot (`cloudReadReadiness` on the runtime-status
   * payload), and this field is only the live per-poll session-lane input to it.
   *
   * If you are reaching for this to answer "is sync finished?", you want
   * {@link CloudSyncBacklog} instead.
   */
  caughtUp: boolean;
  /** Sessions dropped after exceeding retry thresholds (surfaced as a warning). */
  deadLetteredSessions: number;
  /**
   * ISS-4542: component-inventory rows dead-lettered to the back of the line
   * after their batch exceeded the in-place retry budget (surfaced as a warning,
   * like `deadLetteredSessions`). They are still re-attempted once the lane
   * drains and eventually re-sync on their next change — never hard-dropped.
   */
  deadLetteredComponents: number;
};
