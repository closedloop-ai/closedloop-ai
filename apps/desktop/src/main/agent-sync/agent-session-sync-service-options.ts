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
import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type {
  DesktopAgentSessionsAck,
  DesktopAgentSessionsAckReason,
  UNKNOWN_ACK_REASON,
} from "../cloud/cloud-protocol.js";
import type {
  DesktopSyncBatchOutcome,
  SessionSyncBatchEvent,
} from "../telemetry/app-otel-runtime.js";
import type { SignedInUserIdentity } from "../util/user-identity.js";
import type { ComponentSyncSendResult } from "./agent-component-sync-dead-letter.js";
import type { AgentSessionSyncTransportPayload } from "./agent-session-sync-contract.js";
import type { AgentSessionPayloadPreparer } from "./agent-session-sync-payload.js";
import type {
  AgentComponentCursorRow,
  AgentSessionSyncSource,
  DesktopAgentComponentsPayload,
} from "./agent-session-sync-source.js";
import type { OutboxResumeOutcome } from "./session-outbox-engine-state.js";
import type { SyncLaneBatchEmit } from "./sync-lane-cloud-health.js";

export type AgentSessionSyncTelemetryEvent = {
  outcome: typeof DesktopSyncBatchOutcome.Failure;
  /**
   * ISS-8595: includes the version-skew class. This is the PRODUCT-analytics
   * seam, whose property is free-form, so it keeps the distinction the OTel
   * `sync.reason` attribute cannot — that one is a closed enum and folds the
   * skew class to `ingestion_failed` (`syncReasonForAckReason`).
   */
  reason: DesktopAgentSessionsAckReason | typeof UNKNOWN_ACK_REASON;
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
   * ISS-7516 — this machine's RECONCILED data-sync level, stamped on each batch
   * so the cloud can tell a session whose transcript was never queued from one
   * whose transcript is still on its way.
   *
   * Must be the reconciled level (`settingsStore.getDataSyncLevel()`), not the
   * raw stored one: reconciliation is what discards a persisted level whose
   * derived booleans disagree with the live connectivity flags, so the raw value
   * can claim an egress posture the machine is not actually on. Publishing the
   * unreconciled level would tell a reader transcripts are coming when this
   * machine has already reconciled down to a level that excludes them.
   *
   * Optional: when omitted the batch carries no level and the cloud records
   * none, which the read side serves as "no level reported". Existing callers
   * and tests are therefore unaffected.
   */
  getDataSyncLevel?: () => DataSyncLevel;
  /**
   * FEA-4138: has the server advertised the `agentSessionSyncCompression`
   * hello-ack capability (it can accept + decompress a gzip sync body)? When
   * this returns true the service sizes the cap/chunk decision against
   * compressed bytes and asks the transport to gzip the batch; when omitted or
   * false it stays on the legacy uncompressed + chunker path. Negotiated per
   * hello-ack and replaced by the next ack (ISS-12068 keeps it across a
   * disconnect) — skew-safe in both directions.
   */
  isSyncCompressionSupported?: () => boolean;
  /**
   * ISS-4541: has the server advertised the `agentSessionSyncActivityChunking`
   * hello-ack capability (it merges a multi-part activity-segment tiling
   * additively)? When true the payload preparer PAGINATES an oversized session's
   * tiling across chunks so the FULL tiling reaches the cloud; when omitted or
   * false the tiling rides the base whole — which either fits or dead-letters the
   * whole session for a larger-payload retry, never a silent truncation.
   * Negotiated per hello-ack and replaced by the next ack (ISS-12068 keeps it
   * across a disconnect), so it is skew-safe in both directions.
   */
  isSyncActivityChunkingSupported?: () => boolean;
  /**
   * ISS-9859: has the server advertised `agentSessionSyncPrRefChunking` (it
   * merges a part marked `prRefsPaginated` into the session's stored PR links
   * and `pullRequests` blob instead of replacing them)? When true the payload
   * preparer may split a session's `prRefs` and `prs` across parts rather than
   * replicating them into every one; when omitted or false they ride the base
   * whole, which either fits or dead-letters the session — never a partial set,
   * because an older server REPLACES both with each part's slice.
   * Negotiated per hello-ack, so it is skew-safe in both directions.
   */
  isSyncPrRefChunkingSupported?: () => boolean;
  /** True only after hello negotiation accepts the ISS-6060 ref carrier. */
  isSyncMonitoredActivitySupported?: () => boolean;
  /**
   * ISS-5850: has the server advertised `agentSessionSyncSpanExtent` (its
   * `sessionSpanSchema` knows `startMs`/`endMs`, so a span carrying them is
   * persisted rather than stripped)?
   *
   * It does NOT select what is sent — the pair is additive and an older server
   * drops it harmlessly. It selects which payload-contract revision this lane is
   * allowed to stamp on its durable cursor, so a stamped watermark can never
   * mean "delivered" for a field the peer silently discarded. Omitted or false
   * keeps the lane on the pre-extent revision, which is what leaves the one-time
   * replay owed until a capable server answers.
   */
  isSyncSpanExtentSupported?: () => boolean;
  /**
   * ISS-7896: has the server advertised `agentSessionSyncHumanTurnTimestamps`
   * (its persist boundary preserves `metadata.humanTurnTimestamps` whole rather
   * than capping it at the generic 100-item array bound)?
   *
   * Like the extent above it does NOT select what is sent — an older server
   * stores a CAPPED copy and acks normally. It selects which payload-contract
   * revision this lane may stamp, so a watermark can never mean "delivered" for
   * an array the peer silently truncated and the cloud then reads as
   * authoritative. Omitted or false keeps the lane on the pre-human-turn
   * revision, which is what leaves the one-time replay owed.
   */
  isSyncHumanTurnTimestampsSupported?: () => boolean;
  /**
   * ISS-9864: has the server advertised `agentSessionSyncAgentTurnTimestamps`
   * (its persist boundary preserves `metadata.agentTurnTimestamps` whole and
   * its heatmap reads it)? Same contract as the human flag above: it selects
   * which payload-contract revision this lane may stamp, never what is sent.
   */
  isSyncAgentTurnTimestampsSupported?: () => boolean;
  /**
   * ISS-12552: does the CONNECTED server accept token-event owners
   * (`agentExternalId`)? Selects whether the payload carries them.
   */
  isSyncTokenEventOwnerSupported?: () => boolean;
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
   * to the desktop OTel runtime, which owns the `SessionSyncBatchEvent`
   * shape (transport health only: counts, bytes, latency, outcome — never
   * session ids or content, per the PRD-468/FEA-1981 guardrail).
   */
  onSyncBatchTelemetry?: (event: SessionSyncBatchEvent) => void;
  /**
   * ISS-6338: the COMPONENT-INVENTORY lane's batch health — a separate seam from
   * {@link onSyncBatchTelemetry}, deliberately.
   *
   * `AgentComponentSyncLane` is constructed with this very options object, so a
   * shared callback would route lane 3's events through the session lane's
   * handler: that handler stamps `lane: session_metadata` (destroying the
   * attribution this ticket exists to add) and tees into
   * `recordSessionBatch` (crediting the ISS-5387 session burn-down with work the
   * session lane never did, which is the "counters must not mix outcomes" rule
   * in `main/sync/AGENTS.md`). Two seams make both impossible by construction.
   */
  onComponentSyncBatchTelemetry?: SyncLaneBatchEmit;
  /**
   * ISS-9823: the once-per-identity resume hydration's outcome, teed on EVERY
   * pass that runs it — including the ones that succeed, because the consumer
   * holds a level and a clear is as load-bearing as a set.
   *
   * Pushed rather than pulled, following {@link onSyncBatchTelemetry}: the
   * composition root builds the burn-down reporter before this service
   * deliberately, so lanes tee into it.
   *
   * `Discarded` is delivered too and means LEAVE THE LEVEL ALONE. It is not a
   * fault — a superseded identity is what an account or compute-target switch
   * looks like — and a consumer that treats it as one raises a false alarm on
   * every sign-in.
   */
  onResumeOutcome?: (outcome: OutboxResumeOutcome) => void;
  /**
   * FEA-1962: the authenticated compute target the cursor is scoped to. Returns
   * `null` when none is known yet (offline / pre-hello-ack) → the service runs
   * in-memory-only (full-backfill-on-restart, today's behavior). When the target
   * changes, the in-memory cursor resets and re-hydrates so one compute target
   * never inherits another's persisted watermark.
   */
  getSyncComputeTargetId?: () => string | null;
  /**
   * The account this device is syncing as, or `null` when signed out. Read only
   * to decide whether a stranded outbox row may be re-keyed onto the live
   * compute target. Deliberately NOT part of the source key — that names the
   * device, and widening it would invalidate every persisted cursor on disk.
   */
  getSyncIdentity?: () => SignedInUserIdentity | null;
  /**
   * ISS-7096: the normalized apiOrigin of the ACTIVE saved config — the
   * environment this device is currently syncing against — or `null` when
   * unknown. Read at hydration to record the live compute target's
   * environment binding (`compute_target_environments`); never part of the
   * source key.
   */
  getActiveEnvironmentKey?: () => string | null;
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
  /**
   * ISS-7099: of the pending counts above, the sessions the lane could send
   * RIGHT NOW — past their deferred-retry deadline, the same predicate the
   * drain picks with. The pending totals include work parked behind a backoff,
   * an auth/identity gate, or a transport outage, none of which is going to
   * move; a surface reporting MOTION must divide by these instead.
   *
   * Never a substitute for the pending totals: work being ineligible is not
   * work being done, and `caughtUp` stays keyed on the queues being empty.
   *
   * `null` while the current source key and the hydrated one disagree — see
   * {@link inFlightTotalSessions}.
   */
  readyBackfillSessions: number | null;
  readyIncrementalSessions: number | null;
  /**
   * ISS-7099: sessions DELIVERED under the current identity, counted at the
   * verified ack. A progress numerator has to come from proven deliveries —
   * derived from a fall in the owed count, a backoff, a withhold, or a
   * dead-letter all read as progress.
   */
  deliveredSessions: number | null;
  /**
   * ISS-7099: the denominator {@link deliveredSessions} is measured against —
   * the largest `delivered + ready` this identity has reached, snapped back when
   * the lane reports itself caught up.
   *
   * Reported from HERE rather than accumulated in the renderer because it has to
   * survive a component remount and reset with the identity, and only the lane
   * can do both. A component-held total restarts at zero on every mount, which
   * divides inherited deliveries by a backlog that mount never saw.
   *
   * All four of these counts are `null` together while the current source key
   * and the hydrated one disagree: during that window `identified` is already
   * true for the NEW compute target while the counters still describe the PRIOR
   * one, and `null` ("not yet attributable") is the only answer that does not
   * credit one account with another's work. A reader must render it as
   * unmeasured, never as zero.
   */
  inFlightTotalSessions: number | null;
  /**
   * ISS-12529: of the pending counts, the sessions in the batch the lane has on
   * the wire right now, between `sendBatch` and its ack. NOT the ready counts
   * above: ready is everything the drain COULD pick, and the drain sends one
   * capped batch at a time, so a fresh backlog is thousands ready and a handful
   * sending.
   *
   * `null` while the keys disagree (as above) and until the initial cursor
   * enumeration has run for this identity: before the walk lists history the
   * queues are empty because nothing has been enumerated, not because nothing
   * is owed, and a zero there would read as an empty upload queue.
   */
  sendingSessions: number | null;
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
   * invocation-parts lane, or the transcript archive, and it can be true while
   * `deadLetteredSessions > 0`.
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
