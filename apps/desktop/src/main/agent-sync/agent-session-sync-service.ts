import { randomUUID } from "node:crypto";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { DesktopAgentSessionsAck } from "../cloud/cloud-protocol.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { DesktopSyncBatchOutcome } from "../telemetry/app-otel-runtime.js";
import { reportFreshestSessionLagAnomaly } from "../telemetry/sync-freshness-lag-telemetry.js";
import { adoptStrandedOutboxRows } from "./adopt-stranded-outbox-rows.js";
import type { SessionAttributionResolverCache } from "./agent-session-attribution.js";
import { classifyDeadLetteredSession } from "./agent-session-dead-letter-sync-state.js";
import {
  advanceIncrementalPassCount,
  selectDrainCandidates,
} from "./agent-session-drain-selection.js";
import { resolveFreshestUpdatedAtMs } from "./agent-session-freshness-lag.js";
import { resolveEmptyHydration } from "./agent-session-hydration-absence.js";
import { hydrateSyncCandidates } from "./agent-session-hydration-budget.js";
import { createOutboxWriters } from "./agent-session-outbox-writers.js";
import { collectOwedIds, dequeueOwedIds } from "./agent-session-owed-queues.js";
import {
  handlePreparationFailures,
  inProcessAgentSessionPayloadPreparer,
  prepareCandidatePayloadsIsolated,
  selectHydratableCandidateIds,
} from "./agent-session-payload-preparation.js";
import { SessionProgressTally } from "./agent-session-progress-tally.js";
import {
  acceptedAckInput,
  processAcceptedAck,
  type SentBatchAttempt,
} from "./agent-session-sync-accepted-ack.js";
import {
  MAX_CONSECUTIVE_TRANSPORT_ERRORS,
  SESSION_PAYLOAD_BYTE_CAP,
  SESSION_PAYLOAD_CONTENT_BYTE_CAP,
  UNCONFIRMED_ABSENCE_BACKOFF_MS,
} from "./agent-session-sync-backoff-policy.js";
import {
  resolvePreSendDeferral,
  SessionSyncCapability,
} from "./agent-session-sync-capabilities.js";
import { AgentComponentSyncLane } from "./agent-session-sync-component-lane.js";
import { syncPayloadSizerFor } from "./agent-session-sync-compression.js";
import {
  type AgentSessionSyncBatch,
  AgentSessionSyncClass,
  buildAgentSessionSyncBatch,
  type SyncedAgentSession,
} from "./agent-session-sync-contract.js";
import { createSessionCursorPersister } from "./agent-session-sync-cursor-persist.js";
import type { SessionCursorBoundary } from "./agent-session-sync-cursor-prefix.js";
import {
  type DeadLetterLifecycleDeps,
  enforceDeadLetterCap,
  markDeadLettered,
  promoteDeadLetterIfIdle,
  recoverExpiredDeadLetters,
  resetDeadLetterRevisitAfterDrainedAck,
} from "./agent-session-sync-dead-letter-lifecycle.js";
import {
  applyPendingChunkDiscard,
  deadLetterOversizedLocalSession,
  reconcilePendingOutboxIfIdle,
  type SessionDispositionDeps,
  screenUploadableCandidates,
} from "./agent-session-sync-dispositions.js";
import { createSessionFoldRunners } from "./agent-session-sync-fold-runners.js";
import {
  createSyncPassIdentityGuard,
  type SyncPassIdentityGuard,
} from "./agent-session-sync-pass-identity.js";
import {
  SyncPassPump,
  type SyncPassRun,
} from "./agent-session-sync-pass-pump.js";
import {
  SyncPassOutcome,
  SyncPassTrigger,
} from "./agent-session-sync-pass-trace.js";
import {
  type AgentSessionPayloadPreparer,
  tilingStrippedSessionIds,
  type UnsendableComponentUnits,
} from "./agent-session-sync-payload.js";
import {
  accumulatePreparedPayloads,
  isPendingChunkDiscard,
  type PendingChunks,
  type PreparedPayloadAccumulator,
  pendingChunkSendState,
  resolvePendingChunkTransition,
} from "./agent-session-sync-pending-chunks.js";
import { pickReadyCandidates } from "./agent-session-sync-progress-counts.js";
import { dispatchRejectedAck } from "./agent-session-sync-rejection-dispatch.js";
import {
  collectIdsAtTimestamp,
  formatBytes,
} from "./agent-session-sync-service-helpers.js";
import type {
  AgentSessionSyncProgress,
  AgentSessionSyncServiceOptions,
  AgentSessionSyncStartOptions,
} from "./agent-session-sync-service-options.js";
import type { AgentSessionSyncSource } from "./agent-session-sync-source.js";
import {
  logSyncPreSendDeferral,
  logSyncTickFailure,
} from "./agent-session-sync-tick-failure-log.js";
import { applyTransportErrorFold } from "./agent-session-sync-transport-error-fold.js";
import { TransportTimeoutBudget } from "./agent-session-sync-transport-timeout-budget.js";
import { isMultiPartSyncEnvelope } from "./agent-session-sync-validation-failure.js";
import {
  type BackfillQueueFeedContext,
  type BackfillQueueFeedState,
  feedIdsIntoBackfillQueue,
  injectIdsIntoLiveQueue,
} from "./backfill-queue-feed.js";
import { feedIncrementalCursorRows } from "./incremental-cursor-feed.js";
import { runInitialBackfillWalk } from "./initial-backfill-walk.js";
import { hydratePersistedCursorForPass } from "./persisted-cursor-hydration.js";
import { priorityUploadClaims } from "./priority-upload-claims.js";
import { createLongLivedSessionAttributionCache } from "./session-attribution-cache.js";
import {
  failureCountForReason,
  reportSessionMetadataAttemptFailure,
  resolveSyncPayloadShapingPair,
  syncReasonForAckReason,
} from "./sync-failure-diagnostic.js";
import { SyncPollTimers } from "./sync-poll-timers.js";

const TAG = "agent-session-sync";
const agentSessionSyncLogDeps = {
  logError: (message: string) => gatewayLog.error(TAG, message),
  logInfo: (message: string) => gatewayLog.info(TAG, message),
  logWarn: (message: string) => gatewayLog.warn(TAG, message),
};

/**
 * Goal stage 3: the FALLBACK SWEEP cadence — no longer the thing that makes
 * sync happen. The event-driven pump (`notifyLocalSessionActivity`, the ack
 * self-continue, `refresh()` nudges) schedules passes the moment work arrives;
 * this timer exists only to sweep up anything the pump missed (a deferred
 * retry whose backoff elapsed, a trigger lost to a transient shouldRun()
 * bounce, a source that came up between events). A healthy lane does its real
 * work off triggers and this tick finds nothing.
 */
const SYNC_INTERVAL_MS = 5000;

export class AgentSessionSyncService {
  private readonly options: AgentSessionSyncServiceOptions;
  private readonly preparePayloads: AgentSessionPayloadPreparer;
  /** ISS-4758: the 5s poll + coalesced self-continue drain, and their `unref` discipline. */
  private readonly timers = new SyncPollTimers();
  private started = false;
  private syncing = false;
  private historicalBackfillEnabled = true;
  private activeSyncToken: symbol | null = null;
  private sourceStateGeneration = 0;
  private observedTopUpdatedAt: string | null = null;
  private observedIdsAtTopUpdatedAt = new Set<string>();
  /**
   * ISS-8041: `sessions.updated_at` per queued id, for ids a live cursor scan
   * admitted. It is the only evidence that can place a still-owed row against a
   * candidate watermark, so an id ABSENT here refuses cursor advancement
   * outright — see `agent-session-sync-cursor-prefix.ts`. Bounded by the queues:
   * written on admission, evicted in `dequeue`, dropped on identity change.
   */
  private readonly queuedUpdatedAtById = new Map<string, string>();
  /**
   * FEA-2733: whether the initial cursor enumeration has run for the current
   * identity. Distinguishes "not yet started the first-connect walk" (queues
   * transiently empty before the first tick, or an empty local store) from
   * "fully caught up" in `getSyncProgress()`. Reset on identity change.
   */
  private initialBackfillPassRun = false;
  /**
   * Every durable-outbox write, bound to this lane's live target. The target is
   * re-resolved per call with the `hydratedSourceKey ?? resolveSyncSourceKey()`
   * precedence every writer used, so a hydration or account switch can never let
   * a write land on the previous identity's partition.
   */
  private readonly outbox = createOutboxWriters(() => ({
    sourceKey:
      this.hydratedSourceKey ?? SessionSyncCapability.sourceKey(this.options),
    source: this.options.getSource?.() ?? null,
  }));
  /**
   * FEA-1962: the source key the in-memory cursor was last hydrated for; `null`
   * is "not yet hydrated" (or for an unknown identity). When the computed key
   * differs, the next sync clears cursor/queue state and re-hydrates from it.
   */
  private hydratedSourceKey: string | null = null;
  /**
   * ISS-6067: the identity the in-memory source-derived state (cursor, queues,
   * dead-letters, retry counters) belongs to. NOT a synonym for
   * `hydratedSourceKey`, whose `null` means "re-run the once-per-identity resume
   * read": the discard path un-hydrates a pass that already seeded this state, so
   * keying the clear on that marker let the next identity inherit the previous
   * target's cursor. Nulled by `clearSourceDerivedState`, which is what keeps it
   * describing the state.
   */
  private sourceDerivedStateKey: string | null = null;
  private lastIncrementalBatchAttemptedAtMs = 0;
  private featureDisabledForSession = false;
  private firstAckReceived = false;
  private incrementalQueue: string[] = [];
  private readonly incrementalQueuedIds = new Set<string>();
  /**
   * ISS-6166: how many consecutive passes the incremental lane has won. Drives
   * the backfill fairness reservation (`selectDrainCandidates`).
   */
  private consecutiveIncrementalPasses = 0;
  private backfillQueue: string[] = [];
  private readonly backfillQueuedIds = new Set<string>();
  // ISS-8611: bounded — a FIELD, so see `session-attribution-cache.ts`.
  private readonly attributionCache: SessionAttributionResolverCache =
    createLongLivedSessionAttributionCache();
  /**
   * The four ENVIRONMENTAL attempt TALLIES: `ack_timeout` (ISS-8605 F2),
   * `rate_limited` (ISS-8605 F1), `ingestion_failed` (ISS-7730), and an ack
   * reason this build cannot name (ISS-8595). None is a budget — every one of
   * those classes is lane-wide, so `main/sync/AGENTS.md` invariant 4 forbids a
   * terminal path reading it and `laneStalledSinceMsById` below is the bound.
   * They are kept, and kept SEPARATE so no class is charged for another's
   * failures, because `attempt_count` is what a dead-letter row and the ISS-7248
   * diagnostic report, and what `loadPendingSessionOutboxEngineState` selects on
   * (`attempt_count > 0`) to find a stalled row and rehydrate its clock.
   */
  private readonly timeoutCountById = new Map<string, number>();
  private readonly rateLimitedCountById = new Map<string, number>();
  private readonly unknownAckReasonCountById = new Map<string, number>();
  private readonly ingestionFailedCountById = new Map<string, number>();
  /**
   * ISS-7730: when each session's current unbroken LANE-WIDE failure run began
   * (ms since epoch), rehydrated from the durable `lane_stalled_since`. This is
   * the bound that replaces the retry budget `ingestion_failed` is exempt from,
   * so invariant 5's terminal path stays reachable. Cleared with every other
   * per-class budget by `clearFailureStateForId`, so a recovered row starts a
   * fresh run instead of inheriting an already-expired one.
   */
  private readonly laneStalledSinceMsById = new Map<string, number>();
  /**
   * FEA-3366: consecutive `validation_failed` count per session ID. Parallel to
   * the other retry counters so a transient validation rejection gets a small
   * bounded retry budget (re-fetching + re-sanitizing from source on each retry)
   * before the session is dead-lettered, instead of being dropped on the first
   * failure.
   */
  private readonly validationFailedCountById = new Map<string, number>();
  /**
   * Goal stage 2: consecutive ack-echo omissions per sent row — the bounded,
   * row-attributable budget behind `SyncReason.AckOmitted` (see
   * `agent-session-sync-accepted-ack.ts`).
   */
  private readonly ackOmittedCountById = new Map<string, number>();
  /**
   * FEA-4375: ids to re-send as a SINGLETON batch to isolate a `validation_failed`
   * rejection to the truly-invalid row. The ack is batch-level (no per-item ids),
   * so a multi-id validation_failed marks the whole batch for bisection; the next
   * pass sends each id alone (`capBatchForBisection`) so only the row that fails
   * singly burns its budget and the neighbors ack. Cleared on a verified ack.
   */
  private readonly validationBisectIds = new Set<string>();
  /**
   * FEA-3364: consecutive THROWN-error count per session ID. A throw the fold
   * charges to the row (never a dropped connection, ISS-10602) produced no ack,
   * so it is tracked separately from the ack-reason counters above. Bounded by
   * `MAX_CONSECUTIVE_TRANSPORT_ERRORS` so a persistently failing send is
   * eventually dead-lettered instead of retrying every 5s forever.
   */
  private readonly transportErrorCountById = new Map<string, number>();
  /**
   * ISS-5088: the refundable budget for a CLIENT-side request abort
   * (`transport_timeout`), kept separate from `timeoutCountById` because a
   * server-answered 408 is a verdict on the batch while a local abort is
   * ambiguous. The suppress/refund contract lives on the class.
   */
  private readonly transportTimeoutBudget = new TransportTimeoutBudget();
  /**
   * FEA-1461: per-session deferred-retry deadline (ms since epoch). While the
   * deadline is in the future, `pickReadyCandidates` skips the session.
   */
  private readonly nextRetryAfterMs = new Map<string, number>();
  /** ISS-7099: the renderer-facing progress counters for one source identity. */
  private readonly progressTally = new SessionProgressTally();
  /**
   * Session IDs removed from the queue after exceeding a retry threshold, mapped
   * to their retry-after deadline (ms since epoch). FEA-3363: the deadline lets
   * `recoverExpiredDeadLetters` re-enqueue an id once its window elapses so a
   * dead-letter is a deferral, not a permanent strand. `.size` still reflects the
   * live dead-letter count for `getSyncProgress`, the persist block, and logs.
   */
  private readonly deadLetteredIds = new Map<string, number>();
  /**
   * FEA-3795 / ISS-8617: consecutive recoverable dead-letter count per session
   * ID, driving the progressive retry backoff (`deadLetterRetryDelayMs`).
   * Incremented each time an id is dead-lettered recoverably, cleared only on a
   * verified server ack, and seeded from the durable outbox on resume so a
   * relaunch cannot restart the short recovery window.
   */
  private readonly deadLetterCountById = new Map<string, number>();
  /**
   * ISS-5090: the chunk-validation-ONLY re-drive cycle count, bumped solely when
   * an id dead-letters as a recoverable multi-part-envelope rejection
   * (`CHUNK_VALIDATION_FAILED_REASON`), so `MAX_CHUNK_ENVELOPE_DEAD_LETTERS` is
   * spent by that class alone — reading the shared `deadLetterCountById` let
   * three unrelated timeout/rate-limit/ingestion/transport cycles turn the FIRST
   * chunk rejection terminal. Survives recovery, cleared only by a verified ack,
   * evicted by `enforceDeadLetterCap` so it stays bounded by the same cap.
   * KNOWN GAP: in-process only — a cold restart re-derives it from zero and
   * re-grants an exhausted row a full allowance. Closing that needs a durable
   * read of dead-lettered outbox rows (whose `last_error` already records the
   * class), i.e. a new `AgentSessionSyncSource` method. Retry stays bounded
   * regardless: each process spends one capped allowance, then goes terminal.
   */
  private readonly chunkValidationCycleById = new Map<string, number>();
  /**
   * Goal stage 2: the ack-omitted-ONLY re-drive cycle count, the exact sibling
   * of `chunkValidationCycleById` above and charged on its own class for the
   * same reason. Spends `MAX_ACK_OMITTED_DEAD_LETTERS`; survives recovery,
   * cleared only by a verified ack, evicted by `enforceDeadLetterCap`.
   *
   * ISS-9182 gave this class a DURABLE sibling the other one still lacks —
   * `ack_omitted_cycle_count`, charged on every ack-omitted dead-letter
   * (terminal ones too, which this map skips) and never reset. A resume seeds
   * this map from it, so the three-cycle bound survives a restart whichever
   * door re-drives the row; the boot re-pend also reads it and leaves a row
   * that has spent its cycles dead-lettered. `promoteDeadLetterIfIdle` still
   * revisits a set-aside row once per idle cycle, but a spent row's next
   * dead-letter is terminal rather than a fresh recoverable cycle
   * (`sqliteSelectRedrivableSessionDeadLetters` states why that trickle stays).
   */
  private readonly ackOmittedCycleById = new Map<string, number>();
  /**
   * Lowest-priority dead-letter revisit guard. Dead-lettered sessions are set
   * aside, de-prioritized, and revisited ONLY after the entire rest of backfill
   * drains — i.e. after BOTH `incrementalQueue` AND `backfillQueue` are empty. To
   * keep that revisit from becoming a hot loop (a promoted dead-letter that
   * re-fails would otherwise be re-promoted on the very next idle tick), this flag
   * marks the revisit already done for the current idle cycle. It is RESET the
   * moment genuinely-new incremental or backfill work is enqueued, so any new or
   * changed session preempts dead-letter retries (they go to the end of the line)
   * and a fresh idle cycle can promote the next dead-letter. Net ordering:
   * live > backfill > (only when both empty, once per idle cycle) dead-letter.
   */
  private deadLetterRevisitedThisIdleCycle = false;
  /** ISS-6031: one pending-outbox reconciliation read in flight at a time. */
  private outboxReconcileInFlight = false;
  /**
   * ISS-6031 (codex review): the CURRENT pass's post-await guard, published so
   * the two continuations that outlive their await — the presence probe and the
   * idle-tick outbox read — can re-check it without threading a parameter
   * through every frame. Defaults to "not current" so nothing can dispose or
   * enqueue before a pass has ever claimed the lane.
   */
  private currentPassGuard: () => boolean = () => false;
  /**
   * ISS-8116 (davetho / whitlockk review): the same publication for the
   * IDENTITY-ONLY half, which the accepted-ack continuation needs and
   * {@link currentPassGuard} cannot supply — that one folds in `shouldRun()`,
   * and an ack the server already accepted must survive a readiness drop.
   * Published rather than threaded for the reason above; a new pass can never
   * overwrite it mid-continuation, because `syncSessionsOnce` is single-flight
   * on `syncing` for exactly as long as the pass's awaits are outstanding.
   */
  private currentPassIdentityGuard: () => boolean = () => false;
  /** Remaining chunks for an oversized session being sent in parts. */
  // FEA-4138/FEA-4152: the in-flight tail of an oversized session being drained
  // one chunk per tick. The `PendingChunks.compress` encoding contract (pinned
  // while gzip stays negotiated, discarded + re-prepared under identity on a
  // capability downgrade) lives with the transition logic in
  // agent-session-sync-pending-chunks.ts.
  private pendingChunks: PendingChunks | null = null;

  /**
   * T-8.7 / ISS-4676: the component inventory sync lane. Owns ALL of its own
   * state — its own keyset cursor (separate from the session sync cursor so the
   * two lanes advance independently), hydrated source key, single-flight guard,
   * in-flight run handle, transition logger, and dead-letter tracker. This
   * service only drives its lifecycle (clear-on-reset / clear-on-identity-change)
   * and reads its dead-letter count for `getSyncProgress`.
   */
  private readonly componentLane: AgentComponentSyncLane;
  /**
   * ISS-4807: the session lane's mirror of the component lane's in-flight run
   * handle — the in-flight `runSessionSyncPass` run, or `null` when the lane is
   * idle. Set only
   * by a tick that actually STARTS a pass (a tick bounced by the `syncing` /
   * `shouldRun()` gate never publishes one) and cleared by the same identity guard
   * the component lane uses, so a bounced or superseded tick can never resolve the
   * signal early. Consumed by `whenSessionSyncSettled`.
   */
  private sessionSyncPromise: Promise<void> | null = null;
  /**
   * Goal stage 3 (ISS-5993): trigger identity, mid-pass coalescing and the
   * pass-lifecycle trace (see `agent-session-sync-pass-pump.ts`). The service
   * still decides WHEN to pump; the pump owns the bookkeeping.
   */
  private readonly pump = new SyncPassPump(gatewayLog, TAG);

  /**
   * ISS-7730: every rejection fold, bound once to this service's counters,
   * queues, and outbox. Declared after the counter maps above so the view
   * captures live references; the queues ARE reassigned on an identity change,
   * which is why `queueSizes` reads them through a closure.
   */
  private readonly folds = createSessionFoldRunners({
    sourceKey: () => SessionSyncCapability.sourceKey(this.options),
    nextRetryAfterMs: this.nextRetryAfterMs,
    rateLimitedCountById: this.rateLimitedCountById,
    timeoutCountById: this.timeoutCountById,
    unknownAckReasonCountById: this.unknownAckReasonCountById,
    ingestionFailedCountById: this.ingestionFailedCountById,
    laneStalledSinceMsById: this.laneStalledSinceMsById,
    validationFailedCountById: this.validationFailedCountById,
    chunkValidationCycleById: this.chunkValidationCycleById,
    validationBisectIds: this.validationBisectIds,
    clearFailureStateForId: (id) => this.clearFailureStateForId(id),
    markDeadLettered: (...args) => this.markDeadLettered(...args),
    dequeue: (syncMode, ids) => this.dequeue(syncMode, ids),
    ...this.outbox.slices.folds,
    queueSizes: () => ({
      incremental: this.incrementalQueue.length,
      backfill: this.backfillQueue.length,
      deadLettered: this.deadLetteredIds.size,
    }),
    ...agentSessionSyncLogDeps,
  });

  constructor(options: AgentSessionSyncServiceOptions) {
    this.options = options;
    this.componentLane = new AgentComponentSyncLane(options, {
      getSourceStateGeneration: () => this.sourceStateGeneration,
      isStarted: () => this.started,
    });
    this.preparePayloads =
      options.preparePayloads ?? inProcessAgentSessionPayloadPreparer;
  }

  start(options: AgentSessionSyncStartOptions = {}): void {
    if (this.started) {
      return;
    }
    this.historicalBackfillEnabled = options.historicalBackfill ?? true;
    this.started = true;
    this.refresh();
  }

  stop(): void {
    this.started = false;
    this.timers.clearAll();
    const disposeResult = this.preparePayloads.dispose?.();
    if (disposeResult instanceof Promise) {
      disposeResult.catch(() => undefined);
    }
    this.resetSourceState();
  }

  /** The renderer-facing progress snapshot; the projection is pure (ISS-7099). */
  getSyncProgress(): AgentSessionSyncProgress {
    return this.progressTally.sample({
      backfillQueue: this.backfillQueue,
      incrementalQueue: this.incrementalQueue,
      nextRetryAfterMs: this.nextRetryAfterMs,
      nowMs: Date.now(),
      hasPendingParts: this.pendingChunks !== null,
      sourceKey: SessionSyncCapability.sourceKey(this.options),
      hydratedSourceKey: this.hydratedSourceKey,
      initialBackfillPassRun: this.initialBackfillPassRun,
      deadLetteredSessions: this.deadLetteredIds.size,
      deadLetteredComponents: this.componentLane.deadLetteredCount,
    });
  }

  /** ISS-11427: this session's dead-letter sync state, if it is set aside. */
  readDeadLetterState(id: string) {
    return classifyDeadLetteredSession(id, this.deadLetterLifecycleDeps());
  }

  /** ISS-10429: the row the durable cursor is waiting on, for the burn-down. */
  readCursorBoundary(): SessionCursorBoundary | null {
    return this.cursor.readBoundary();
  }

  /**
   * Clear every cursor, queue, retry, dead-letter, pending chunk, and
   * attribution cache that is derived from the currently selected dashboard
   * source. Availability disable and source transitions must restart from the
   * next selected source instead of replaying stale work from the prior one.
   */
  resetSourceState(): void {
    this.sourceStateGeneration += 1;
    this.activeSyncToken = null;
    this.syncing = false;
    this.pump.reset();
    // FEA-3448: clear the component-lane single-flight guard + in-flight run
    // handle on a hard reset (stop/restart of the same instance), mirroring
    // `this.syncing` above. Kept OUT of `clearSourceDerivedState` on purpose —
    // see the lane's `clearInFlightState` header for why. Same placement as
    // `this.syncing`.
    this.componentLane.clearInFlightState();
    this.featureDisabledForSession = false;
    this.firstAckReceived = false;
    // FEA-1962: force re-hydration from the persisted cursor on the next sync.
    this.hydratedSourceKey = null;
    this.clearSourceDerivedState();
  }

  /**
   * FEA-1962: clear every cursor/queue/retry/chunk field derived from the
   * current source's rows, WITHOUT bumping the source-state generation or
   * touching session-scoped flags. Shared by `resetSourceState` (hard reset) and
   * the hydration path (identity change), so the two cannot drift (DRY).
   */
  private clearSourceDerivedState(): void {
    this.observedTopUpdatedAt = null;
    this.observedIdsAtTopUpdatedAt = new Set<string>();
    this.initialBackfillPassRun = false;
    this.lastIncrementalBatchAttemptedAtMs = 0;
    this.consecutiveIncrementalPasses = 0;
    this.incrementalQueue = [];
    this.incrementalQueuedIds.clear();
    this.backfillQueue = [];
    this.backfillQueuedIds.clear();
    // ISS-8041: both halves of the prefix-boundary state are derived from THIS
    // identity's rows and its `sync_state` row, so neither may survive into the
    // next one.
    this.queuedUpdatedAtById.clear();
    this.cursor.reset();
    this.attributionCache.attributionByCwd.clear();
    this.attributionCache.launchMetadataRootByCwd.clear();
    this.attributionCache.repoFullNameByPath.clear();
    // ISS-8610: every tally, deadline and stall clock the FOLDS own, reset in
    // the collaborator that declares them rather than listed again here.
    this.folds.resetForIdentity();
    // Goal stage 2: drop the ack-omitted budget with the other per-row counters.
    this.ackOmittedCountById.clear();
    this.transportErrorCountById.clear();
    // ISS-5088: drop the client-abort budget on identity change / hard reset too.
    this.transportTimeoutBudget.clearAll();
    // ISS-7099: a new identity starts its own counters.
    this.progressTally.reset();
    this.deadLetteredIds.clear();
    // FEA-3795: drop the progressive-backoff escalation counters too.
    this.deadLetterCountById.clear();
    this.ackOmittedCycleById.clear();
    this.deadLetterRevisitedThisIdleCycle = false;
    this.pendingChunks = null;
    this.timers.clearDrain();
    // T-8.7 / ISS-4542: reset the component lane's keyset cursor and drop its
    // dead-letter tracker so the next tick re-hydrates from the persisted
    // position and no prior account's dead-lettered ids leak into the next
    // identity's lane.
    this.componentLane.clearCursorState();
    // ISS-6067: nothing above is derived from an identity any more.
    this.sourceDerivedStateKey = null;
  }

  refresh(): void {
    if (!this.started) {
      return;
    }
    if (!this.options.isHttpReady()) {
      this.featureDisabledForSession = false;
      this.firstAckReceived = false;
      this.lastIncrementalBatchAttemptedAtMs = 0;
      // ISS-5088: the lane just lost readiness (relay socket ping timeout, sign
      // out, cloud offline). Any client-abort charge taken while that was
      // happening was a lane-wide symptom, not a payload verdict — refund it.
      this.noteTransportLoss("cloud transport not ready");
    }
    if (!(this.shouldRun() || this.options.isHttpReady())) {
      this.timers.stopPoll();
      return;
    }
    this.pump.markTrigger(SyncPassTrigger.Refresh);
    this.ensureTimer();
    void this.syncOnce();
  }

  /**
   * Goal stage 3: the event-driven pump's WORK-ARRIVAL trigger. Called by the
   * owners of local session writes (the post-write emit of the collector
   * import, via the dashboard runtime wiring) the moment session data
   * lands, so a pass runs within ~one tick of arrival instead of waiting for
   * the fallback sweep. Coalesced end to end: while a pass is running the
   * request folds into the pump's coalescer (N triggers = exactly one
   * follow-up pass), and while idle it rides the already-coalesced drain
   * timer. Never gated on renderer state — the caller is the main-process
   * import path (invariant 9; the ISS-5990 direction).
   */
  notifyLocalSessionActivity(): void {
    if (!(this.started && (this.shouldRun() || this.options.isHttpReady()))) {
      // Not startable right now (stopped or transport down). The
      // trigger is deliberately dropped rather than latched: the readiness
      // subscriptions call refresh() when the gate re-opens, and the fallback
      // sweep covers anything that slips between.
      return;
    }
    this.pump.markTrigger(SyncPassTrigger.WorkArrival);
    // Re-arm the fallback sweep too — a work signal proves the lane should be
    // live even if a transient not-ready refresh() stopped the poll earlier.
    this.ensureTimer();
    if (this.syncing) {
      this.pump.requestWhileRunning();
      return;
    }
    this.schedulePendingPartDrain();
  }

  /**
   * ISS-4546: the mutable in-memory queue/dedup state the `backfill-queue-feed`
   * helpers append to, exposing the private fields as the structural
   * {@link BackfillQueueFeedState} the shared helper takes. Both the live
   * `injectBackfillIds` path and the restart-hydration re-enqueue route through
   * `feedIdsIntoBackfillQueue(this.backfillQueueFeedState(), …)`, so the dedup
   * discipline cannot drift between them.
   */
  private backfillQueueFeedState(): BackfillQueueFeedState {
    return {
      backfillQueue: this.backfillQueue,
      backfillQueuedIds: this.backfillQueuedIds,
      incrementalQueuedIds: this.incrementalQueuedIds,
      deadLetteredIds: this.deadLetteredIds,
    };
  }

  injectBackfillIds(
    ids: readonly string[],
    capturedSourceKey: string | null
  ): void {
    const ctx: BackfillQueueFeedContext = {
      ...this.backfillQueueFeedState(),
      hydratedSourceKey: this.hydratedSourceKey,
      resolveSyncSourceKey: () => SessionSyncCapability.sourceKey(this.options),
      recoverDeadLetteredId: (id) => {
        // Mirror `promoteDeadLetterIfIdle`'s recovery: drop the set-aside marker,
        // clear the in-memory failure/retry budget, and durably flip the outbox
        // row from `dead_lettered` back to `pending` so a restart's
        // `loadPendingOutboxIds` re-discovers it too (belt-and-suspenders with the
        // live queue). `feedIdsIntoBackfillQueue` then queues it as new work.
        this.deadLetteredIds.delete(id);
        this.clearFailureStateForId(id);
        void this.outbox.reEnqueue(id);
      },
      resetDeadLetterRevisitGuard: () => {
        this.deadLetterRevisitedThisIdleCycle = false;
      },
      nudgeAfterInject: () => {
        if (this.started && this.shouldRun()) {
          // Goal stage 3: an injected id is arriving work — trace it as such.
          this.pump.markTrigger(SyncPassTrigger.WorkArrival);
          this.ensureTimer();
          void this.syncOnce();
        }
      },
    };
    injectIdsIntoLiveQueue(ctx, ids, capturedSourceKey, (message) =>
      gatewayLog.info(TAG, message)
    );
  }

  private shouldRun(): boolean {
    // Allow syncing when the HTTP transport reports ready (live session +
    // connected cloud), or when we have already received a confirmed ack for
    // this connection (so the service does not rely solely on readiness). The
    // firstAckReceived flag starts false, so initial syncs still proceed via
    // isHttpReady() before any ack is received.
    const httpAccepting = this.options.isHttpReady() || this.firstAckReceived;
    // PRD-532 §7: honor the user's sync-observability consent. When the tier
    // gate is wired and reports the chosen tier does not permit cloud sync
    // (`local`, or not-yet-consented `null`), suppress the
    // session-metadata lane entirely — this is the consent contract, so it wins
    // over agent-monitor/HTTP readiness. Undefined = not gated (legacy).
    const tierAllowsSync = this.options.isCloudSyncTierAllowed?.() ?? true;
    return tierAllowsSync && httpAccepting && !this.featureDisabledForSession;
  }

  private ensureTimer(): void {
    this.timers.startPoll(SYNC_INTERVAL_MS, () => {
      // Goal stage 3: the fallback sweep tick (see SYNC_INTERVAL_MS).
      this.pump.markTrigger(SyncPassTrigger.Poll);
      void this.syncOnce();
    });
  }

  private schedulePendingPartDrain(): void {
    if (!this.started) {
      return;
    }
    // Goal stage 3: every drain-timer schedule is a pump input; record the
    // cause for the pass trace when no earlier trigger already did.
    this.pump.markTrigger(SyncPassTrigger.AckContinue);
    this.timers.scheduleDrain(() => {
      // FEA-4375: the immediate self-continue drain and the chunk-drain
      // continuation advance the SESSION lane only. The component inventory lane
      // stays on its own 5-second `setInterval` tick so a fast component-lane
      // failure is not retried once per session batch during a large backfill.
      void this.syncSessionsOnce();
    });
  }

  /**
   * FEA-4375: kick an IMMEDIATE follow-up SESSION-ONLY tick after a productive
   * batch when ready work remains, instead of idling `SYNC_INTERVAL_MS` (5s). The
   * poll otherwise caps drain at `BACKFILL_SESSION_BATCH_SIZE` (3) sessions / 5s ≈
   * 50 min for a large first-connect corpus (the observed "initial sync hangs")
   * even though nothing is wedged — just throttled to the poll cadence. Reuses the
   * shared drain timer (cleared by `stop()`, coalesced with the chunk drain)
   * and runs `syncSessionsOnce` so it never re-kicks the component lane per batch.
   *
   * NEVER hot-loops: it reschedules only when at least one queued session is READY
   * now (past its `nextRetryAfterMs`). If every remaining row is in backoff,
   * `pickReadyCandidates` returns nothing and the 5s poll drives the next attempt.
   */
  private scheduleImmediateDrainIfReadyWorkRemains(): void {
    if (this.timers.drainScheduled || !this.started) {
      return;
    }
    const nowMs = Date.now();
    const hasReadyWork =
      this.pendingChunks !== null ||
      this.selectReadyCandidates(this.backfillQueue, 1, nowMs).length > 0 ||
      this.selectReadyCandidates(this.incrementalQueue, 1, nowMs).length > 0;
    if (!hasReadyWork) {
      return;
    }
    this.schedulePendingPartDrain();
  }

  /**
   * Await the current component-lane run to fully settle (its load/send/advance
   * awaits all complete and the single-flight guard clears). Returns immediately
   * when the lane is idle. This is the REAL completion signal for the
   * fire-and-forget component lane — tests await it instead of guessing a fixed
   * flush count (FEA-2399 determinism / davetho review). It never throws (the
   * lane's awaits are all try/caught internally). The mechanics live on the lane
   * (ISS-4676); this stays the public name callers and tests use.
   */
  whenComponentSyncSettled(): Promise<void> {
    return this.componentLane.whenSettled();
  }

  /**
   * ISS-9418/ISS-8610: a precondition a blocked lane may have been waiting on
   * changed — an auth-session change that `wireAuthSessionLaneRecovery`'s own
   * identity diff proved is a genuine account switch. Re-arms a give-up and ends
   * the environmental pacing window,
   * so the next tick gets ONE attempt on both lanes.
   *
   * Deliberately SEPARATE from {@link refresh}, which is also the work-arrival
   * trigger: re-arming on that would let an ordinary collector import clear a
   * terminal state that says the CLOUD is unreachable. A routine same-account
   * token renewal is on the same footing and gets
   * {@link noteCredentialsRefreshed} instead. A compute-target change needs no
   * call at all — `heldEnvironmentally` drops a run whose lane identity moved.
   */
  noteLaneRecoverySignal(): void {
    this.componentLane.noteRecoverySignal();
    this.folds.noteLaneRecoverySignal();
  }

  /**
   * ISS-8610: the access token was re-minted for the SAME account. Ends the
   * session lane's environmental PACING window and nothing else — the narrow
   * door 401 needs, without the give-up re-arm the seam above owns.
   */
  noteCredentialsRefreshed(): void {
    this.folds.noteCredentialsRefreshed();
  }

  /**
   * A full sync tick: kick the component inventory lane in parallel, then run
   * the session pass. The `setInterval` poll and `refresh()` both drive this so
   * BOTH lanes advance on the documented 5-second cadence.
   */
  private syncOnce(): Promise<void> {
    // T-8.7: run component inventory sync in parallel with the session sync tick.
    // The lane owns its in-flight run handle (set to the real run, cleared by
    // identity) so `whenComponentSyncSettled` awaits the REAL lane completion (a
    // deterministic test signal) instead of a fixed flush count. A tick bounced by
    // the single-flight guard returns the in-flight run rather than replacing it.
    // The lane never throws through (its awaits are all try/caught), so no `.catch`.
    void this.componentLane.syncOnce();
    return this.syncSessionsOnce();
  }

  /**
   * FEA-4375: the SESSION-ONLY sync pass — the session lane WITHOUT the component
   * inventory lane. The self-continue and chunk-drain continuations drive THIS
   * (not `syncOnce`) so a large backfill advances back-to-back without
   * re-entering the component lane per batch; that lane keeps its own 5s tick so
   * a fast failure there retries on that cadence rather than once per session
   * batch (whitlockk review). `syncOnce` is the only caller that runs both.
   */
  private syncSessionsOnce(): Promise<void> {
    // Only a tick that STARTS a pass publishes `sessionSyncPromise`, so the
    // settled signal below is never clobbered by a bounced tick. The hold is
    // re-checked after hydration (ISS-8610) — admission precedes the stamp read.
    if (this.syncing || !this.shouldRun() || this.folds.heldEnvironmentally()) {
      return Promise.resolve();
    }
    // Goal stage 3: this tick is ADMITTED — the pump consumes the pending
    // trigger and mints the pass's trace run (fired→admitted starts here).
    const run = this.runSessionSyncPass(this.pump.admit()).finally(() => {
      // Clear by identity: only null the field if it still points at THIS run, so
      // a later run that has already replaced it is never clobbered. An identity
      // change starts a new pass, which republishes the field.
      if (this.sessionSyncPromise === run) {
        this.sessionSyncPromise = null;
      }
    });
    this.sessionSyncPromise = run;
    return run;
  }

  /**
   * ISS-4807: await the current session-lane pass to fully settle, mirroring
   * {@link whenComponentSyncSettled} for the session lane. `refresh()` drives the
   * lane fire-and-forget (`void this.syncOnce()`), so this is the REAL completion
   * signal — tests await it instead of flushing a fixed number of event-loop turns
   * and hoping the pass finished. Returns immediately when the lane is idle, and
   * never throws (the pass's awaits are all try/caught internally).
   */
  async whenSessionSyncSettled(): Promise<void> {
    // A pass's awaits can span several turns, and its `.finally` clears the field
    // only after it resolves; loop so a pass that started while we awaited a
    // previous one is also awaited before the caller proceeds.
    while (this.sessionSyncPromise) {
      await this.sessionSyncPromise;
    }
  }

  private async runSessionSyncPass(pass: SyncPassRun): Promise<void> {
    const syncToken = Symbol("agent-session-sync");
    const sourceStateGeneration = this.sourceStateGeneration;
    this.activeSyncToken = syncToken;
    this.syncing = true;
    // ISS-8116: the pass captures its identity ONCE, here, and every guard below
    // compares the LIVE key against it. A compute-target/account switch — and a
    // hello-ack renegotiation that moves `monitoredActivity`, which the key folds
    // — changes identity WITHOUT bumping `sourceStateGeneration`, so the
    // generation half alone was blind to exactly the case these guards exist for.
    // `currentPassGuard` is what `dispositionDeps()` hands every disposition
    // write, so strengthening it here strengthens those too.
    const passIdentity = createSyncPassIdentityGuard({
      isActivePass: () =>
        this.activeSyncToken === syncToken &&
        this.sourceStateGeneration === sourceStateGeneration &&
        this.started,
      shouldRun: () => this.shouldRun(),
      readLiveSourceKey: () => SessionSyncCapability.sourceKey(this.options),
    });
    const isCurrentSourceState = passIdentity.isCurrentSourceState;
    this.currentPassGuard = isCurrentSourceState;
    this.currentPassIdentityGuard = passIdentity.isCurrentSourceIdentity;

    try {
      await this.options.waitForBackgroundSlot?.();
      if (!isCurrentSourceState()) {
        return;
      }

      const injectedSource = this.options.getSource?.() ?? null;
      if (!injectedSource) {
        return;
      }
      pass.noteStarted();

      let syncMode: AgentSessionSyncMode | null = null;
      let syncIds: string[] = [];
      let batch: AgentSessionSyncBatch | null = null;
      let accumulatedBytes = 0;
      // ISS-6999: the skip this payload owes, carried to the ack.
      let unsendableComponentUnits: UnsendableComponentUnits | undefined;
      // ISS-4541: is THIS tick draining a chunk off an already-open pending tail
      // (vs. shipping chunk 0 of a fresh sequence)? A thrown transport error on a
      // mid-sequence chunk must discard the whole remaining tail rather than let
      // later chunks drain and dequeue the session with the thrown chunk missing
      // (davetho P1) — the shifted chunk is already gone from the tail, so the
      // only safe recovery is to re-prepare the session from chunk 0 next tick,
      // exactly as the capability-downgrade discard path already does.
      let drainingPendingChunkTail = false;
      // ISS-7775: the level a FRESH batch was sanitized under. Read below beside
      // the prepare (not here, like `sendCompress`) so its staleness window is
      // no wider than the awaits; hoisted only to reach the pre-send gate.
      let capturedDataSyncLevel: DataSyncLevel | undefined;
      // FEA-4138: whether THIS batch ships compressed. For a fresh batch it
      // follows the currently-negotiated capability; a pending-chunk drain
      // honors the encoding the chunks were sized for so the sequence stays
      // consistent even if the capability flips mid-drain.
      const syncCapabilities = SessionSyncCapability.capture(this.options);
      let sendCompress = syncCapabilities.compression;
      const sizer = syncPayloadSizerFor(sendCompress);
      // ISS-4541: captured once at the top of the tick (like sendCompress) so a
      // fresh batch's chunk decision and any sequestered tail agree on it.
      const activityChunkingSupported = syncCapabilities.activityChunking;
      // ISS-9859: captured once per tick, for the same reason as the tiling flag.
      const prRefChunkingSupported = syncCapabilities.prRefChunking;
      const monitoredActivitySupported = syncCapabilities.monitoredActivity;
      // ISS-7265 AC3: the server can merge a multi-part tiling now, so every
      // tiling an earlier strip left owed can finally be re-delivered. Once per
      // lane, gated and drained inside the writer.
      this.outbox.repairOwedTilings(activityChunkingSupported);

      const pendingTransition = resolvePendingChunkTransition(
        this.pendingChunks,
        syncCapabilities.compression,
        activityChunkingSupported,
        monitoredActivitySupported,
        this.options.getDataSyncLevel?.(),
        undefined,
        prRefChunkingSupported,
        syncCapabilities.tokenEventOwner
      );
      if (isPendingChunkDiscard(pendingTransition)) {
        // The two transitions that clear the tail without sending; which one
        // and why is `applyPendingChunkDiscard`. Cleared BEFORE applying, so a
        // verdict it folds cannot re-read a tail this tick already abandoned.
        this.pendingChunks = null;
        applyPendingChunkDiscard(
          pendingTransition,
          this.folds.validationFailureDeps(),
          this.dispositionDeps()
        );
        return;
      }

      if (pendingTransition.kind === "send") {
        // Drain the next pending chunk (already shifted off the tail) without
        // touching the DB or queues. `resolvePendingChunkTransition` mutated the
        // tail in place; clear it only after the FINAL chunk.
        drainingPendingChunkTail = true;
        if (pendingTransition.isLast) {
          this.pendingChunks = null;
        }
        const drain = pendingChunkSendState(pendingTransition);
        ({ sendCompress, batch, accumulatedBytes, syncMode, syncIds } = drain);
        unsendableComponentUnits = pendingTransition.unsendableComponentUnits;
        gatewayLog.info(TAG, drain.logLine);
        // Skip DB access — go straight to send.
      } else {
        const source = injectedSource;
        try {
          // FEA-1962: hydrate the persisted cursor BEFORE deciding backfill vs
          // incremental. A hydrated watermark makes initializeBackfillQueueIfNeeded
          // short-circuit (no full re-upload); a fresh/absent row leaves it null
          // → full backfill as today.
          const hydrated = await this.hydratePersistedCursorIfNeeded(
            source,
            isCurrentSourceState
          );
          // ISS-8116 / ISS-8594: ABANDON the pass, rather than merely leaving
          // the identity un-hydrated, when the identity moved across a
          // hydration await OR either resume read — the un-acked prefix or the
          // retry budget — did not land. Nulling alone lets
          // `initializeBackfillQueueIfNeeded` repopulate `observedTopUpdatedAt`
          // under a null `sourceDerivedStateKey` a THIRD identity inherits
          // (ISS-6067), and an unread budget uploads against empty maps.
          if (!(hydrated && isCurrentSourceState())) {
            return;
          }
          await this.initializeBackfillQueueIfNeeded(source, passIdentity);
          await this.enqueueIncrementalUpdates(source, isCurrentSourceState);

          const nowMs = Date.now();
          // FEA-3363: give any dead-lettered session whose retry-after window has
          // elapsed a fresh path back onto the backfill queue before selecting
          // this tick's candidates, so it can eventually reach the cloud without
          // requiring an app restart.
          recoverExpiredDeadLetters(nowMs, this.deadLetterLifecycleDeps());
          // ISS-6031: before falling through to the dead-letter revisit, reconcile
          // the durable outbox against the in-memory queues. A `pending` row that
          // neither queue is tracking is owed work nothing will ever select — the
          // measured hang: one row sat at `attempt_count = 0`, no error, no
          // backoff, no log, while the reported backlog stayed pinned at 1.
          this.reconcilePendingOutboxIfIdle(source);
          // Lowest-priority revisit: only when BOTH queues are already empty does
          // this promote a single set-aside dead-letter onto the backfill lane,
          // and only once per idle cycle. Genuinely-new incremental/backfill work
          // enqueued above resets the guard so live/backfill always drain first.
          promoteDeadLetterIfIdle(this.deadLetterLifecycleDeps());
          // ISS-6166: which lane wins this tick, including the backfill fairness
          // reservation. See `agent-session-drain-selection.ts` for the policy.
          const selection = selectDrainCandidates({
            nowMs,
            incrementalQueue: this.incrementalQueue,
            backfillQueue: this.backfillQueue,
            lastIncrementalBatchAttemptedAtMs:
              this.lastIncrementalBatchAttemptedAtMs,
            consecutiveIncrementalPasses: this.consecutiveIncrementalPasses,
            pickReady: (queue, limit, at) =>
              this.selectReadyCandidates(queue, limit, at),
            validationBisectIds: this.validationBisectIds,
          });
          this.consecutiveIncrementalPasses = advanceIncrementalPassCount(
            this.consecutiveIncrementalPasses,
            selection.syncMode
          );
          if (selection.incrementalAttemptedAtMs !== null) {
            this.lastIncrementalBatchAttemptedAtMs =
              selection.incrementalAttemptedAtMs;
          }
          if (!selection.syncMode || selection.candidateIds.length === 0) {
            return;
          }
          syncMode = selection.syncMode;

          // ISS-8116: no guard of its own, and none is owed. The only write this
          // await can produce is the oversize dead-letter, and
          // `deadLetterOversizedLocalSession` now refuses it on
          // `deps.isCurrentSourceState()` — `currentPassGuard`, identity-bearing
          // — as its first statement (tamsinb review: it took that guard in its
          // deps bag and never read it). The refusal therefore happens at the
          // write, which is strictly later and strictly narrower than a check
          // here; adding one would only skip the still-correct in-memory
          // selection alongside it.
          const hydratableCandidateIds =
            await this.selectHydratableCandidateIds(
              source,
              syncMode,
              selection.candidateIds,
              sendCompress
            );
          if (hydratableCandidateIds.length === 0) {
            return;
          }

          // Load candidates, then accumulate until the next would exceed the
          // 256 KiB cap; ones that individually exceed it are chunked.
          // ISS-5988: bounded by BYTES HELD, not candidate count, so raising
          // the count backstop cannot reintroduce the V8 OOM (exit 5); see
          // `hydrateSyncCandidates`. `let` so it is released for GC below.
          const hydration = await hydrateSyncCandidates(
            source,
            hydratableCandidateIds,
            this.attributionCache,
            monitoredActivitySupported
          );
          // Scope unhydratable handling to the ids actually ATTEMPTED: a
          // budget-deferred id was never loaded, so treating it as
          // unhydratable would dead-letter a healthy session.
          const attemptedCandidateIds = hydration.attemptedIds;
          let candidateSessions: SyncedAgentSession[] = hydration.sessions;
          if (!isCurrentSourceState()) {
            return;
          }

          // ISS-6031: account for EVERY id that was asked for. An id the
          // hydration did not return is a read result, not a cause, so prove
          // which before disposing of anything (`resolveEmptyHydration`);
          // FEA-3473 (E1, AC-2)'s durable dead-letter + cursor persist still
          // applies, but only to ids a presence probe confirms are gone from
          // `sessions`.
          //
          // Deliberately the MISSING SET, not `length === 0`. A partial miss —
          // some ids hydrate, some do not — took no branch at all before: the
          // absent ids were silently omitted from the batch, never probed, never
          // logged, and left to be re-picked forever. That is the same
          // fail-silent hazard this ticket exists to remove, merely hidden by a
          // non-zero aggregate count.
          //
          // ISS-5988 (PR #4862): the missing set is taken over
          // `attemptedCandidateIds`, NOT the full admitted list. Raising the
          // request ceiling put a BYTE BUDGET in front of the hydrate, so the
          // admitted list now splits into ids that were actually loaded and ids
          // the budget stopped short of. A budget deferral is neither an absence
          // nor an unproven absence — the row is present and healthy, and the
          // probe would duly find it, but routing it here would still park it
          // behind `UNCONFIRMED_ABSENCE_BACKOFF_MS` and log a read failure that
          // never happened, throttling the very drain this ticket raised.
          // `attemptedIds` excludes those ids by construction
          // (`hydrateWithinByteBudget`), which keeps the probe scoped to ids
          // whose non-return is genuinely unexplained.
          const hydratedIds = new Set(
            candidateSessions.map((session) => session.externalSessionId)
          );
          const unhydratedIds = attemptedCandidateIds.filter(
            (id) => !hydratedIds.has(id)
          );
          if (unhydratedIds.length > 0) {
            await this.resolveEmptyHydration(source, syncMode, unhydratedIds);
            if (!isCurrentSourceState()) {
              return;
            }
          }
          if (candidateSessions.length === 0) {
            return;
          }

          // FEA-3287 + ISS-7096 + ISS-8271: the pre-payload candidate screen
          // (withhold idle/foreign, then defer sentinel revisions) lives whole
          // in agent-session-sync-dispositions.ts.
          candidateSessions = screenUploadableCandidates(
            {
              syncMode,
              sessions: candidateSessions,
              identity: this.options.getSyncIdentity?.() ?? null,
            },
            this.dispositionDeps()
          );
          if (candidateSessions.length === 0) {
            // Every hydrated candidate this pass was idle, foreign-owned, or
            // sentinel-deferred — nothing to upload. The drop paths already
            // dequeued and persisted; a deferred id keeps its queue slot behind
            // its deadline (mirrors the unhydratable all-dropped path above).
            return;
          }

          const sessions: SyncedAgentSession[] = [];
          syncIds = [];
          const batchId = randomUUID();
          const selectedSyncMode = syncMode;
          capturedDataSyncLevel = this.options.getDataSyncLevel?.();
          const buildBatch = (
            batchSessions: SyncedAgentSession[]
          ): AgentSessionSyncBatch =>
            buildAgentSessionSyncBatch({
              batchId,
              syncMode: selectedSyncMode,
              sessions: batchSessions,
              compress: sendCompress,
              dataSyncLevel: capturedDataSyncLevel,
            });
          // FEA-4014: isolate + bound prep failures (see
          // agent-session-payload-preparation.ts). A batch failure falls back to
          // per-session prep so only the offender(s) burn the FEA-3364
          // transport-error budget, and `handlePreparationFailures` dead-letters
          // them (immediately if deterministic, else after the budget) so the
          // queue always drains past a session that can never be prepared.
          const prepStartedMs = Date.now();
          const { prepared: preparedPayloads, failures: prepFailures } =
            await prepareCandidatePayloadsIsolated(
              this.preparePayloads,
              candidateSessions,
              SESSION_PAYLOAD_CONTENT_BYTE_CAP,
              sendCompress,
              syncCapabilities,
              capturedDataSyncLevel
            );
          // If stop()/a source reset raced the prep await, service state was
          // already cleared synchronously; leave a superseded sync cleared rather
          // than repopulate retry/dead-letter state, emit a post-shutdown result,
          // or send stale survivors.
          if (!isCurrentSourceState()) {
            return;
          }
          if (prepFailures.length > 0) {
            handlePreparationFailures(
              {
                chargeTransportError: (sessionId, error) =>
                  this.handleTransportError(
                    selectedSyncMode,
                    [sessionId],
                    0,
                    error
                  ),
                emitBatchTelemetry: (event) =>
                  this.options.onSyncBatchTelemetry?.(event),
              },
              prepFailures,
              prepStartedMs
            );
          }
          // The prepared payloads are the sanitized copies actually sent; the
          // source hydration is no longer needed. Drop the only reference to it
          // now so it is eligible for GC during the accumulation loop and the
          // subsequent `sendBatch` network round-trip rather than being pinned
          // until `syncOnce` returns. (Since FEA-2718 hydrates without event
          // `data`, this hydration is already slim — the drop still trims the
          // cycle's peak retained memory to just the stripped payloads.)
          candidateSessions = [];
          // FEA-4152: fold lives in agent-session-sync-pending-chunks.ts (keeps
          // this grandfathered file shrinking); it mutates `acc` in place.
          const acc: PreparedPayloadAccumulator = {
            sessions,
            syncIds,
            accumulatedBytes,
            pendingChunks: this.pendingChunks,
          };
          accumulatePreparedPayloads(acc, preparedPayloads, {
            syncMode: selectedSyncMode,
            sendCompress,
            activityChunked: activityChunkingSupported,
            prRefChunked: prRefChunkingSupported,
            monitoredActivityIncluded: monitoredActivitySupported,
            tokenEventOwnerIncluded: syncCapabilities.tokenEventOwner,
            dataSyncLevel: capturedDataSyncLevel,
            sizer,
            byteCap: SESSION_PAYLOAD_BYTE_CAP,
            buildBatch,
            deadLetter: (sessionId, payloadBytes) =>
              deadLetterOversizedLocalSession(
                { syncMode: selectedSyncMode, sessionId, payloadBytes },
                this.dispositionDeps()
              ),
            logChunking: (sessionId, payloadBytes, chunkCount) =>
              gatewayLog.info(
                TAG,
                `chunking oversized session ${sessionId} (~${formatBytes(payloadBytes)}) into ` +
                  `${chunkCount} chunks of <=${formatBytes(SESSION_PAYLOAD_BYTE_CAP)}`
              ),
          });
          // `acc.sessions`/`acc.syncIds` are the same array refs (pushed into in
          // place); only the byte total and pinned tail need copying back.
          accumulatedBytes = acc.accumulatedBytes;
          this.pendingChunks = acc.pendingChunks;
          unsendableComponentUnits = acc.unsendableComponentUnits;
          if (!batch) {
            batch = buildBatch(sessions);
          }
        } finally {
          // ISS-8116: unguarded on purpose — releasing the read handle this pass
          // opened writes no service state and no durable row, and it must run
          // for a superseded pass exactly as for a current one.
          await source.close?.();
        }
      }

      if (!(batch && syncMode) || syncIds.length === 0) {
        return;
      }
      if (!isCurrentSourceState()) {
        gatewayLog.debug(
          TAG,
          "skipping agent-session sync batch from a stale dashboard source"
        );
        return;
      }

      // Pre-send freshness: this payload was built before hydration and worker
      // prep, so a CAPABILITY may have renegotiated and the data-sync-level
      // POLICY may have changed during those awaits. Both decisions, and why
      // each defers, live in `agent-session-sync-capabilities.ts`.
      const preSendDeferral = resolvePreSendDeferral({
        isPendingChunkDrain: pendingTransition.kind === "send",
        captured: { ...syncCapabilities, compression: sendCompress },
        current: SessionSyncCapability.capture(this.options),
        capturedDataSyncLevel,
        currentDataSyncLevel: this.options.getDataSyncLevel?.(),
      });
      if (preSendDeferral) {
        logSyncPreSendDeferral(TAG, preSendDeferral, syncIds.length);
        return;
      }

      const sendStartedMs = Date.now();
      // ISS-7265: read the strip off the payload about to be sent, so the ids
      // and the bytes can never disagree. Covers the pending-chunk drain too —
      // the flag is spread into every chunk of a stripped session.
      const strippedIds = tilingStrippedSessionIds(batch.sessions);
      const tilingStrippedSessionCount = strippedIds.length;
      // ISS-7496: read the freshest `updatedAt` off the SAME payload, for the
      // same reason — a timestamp resolved anywhere else could describe rows
      // this batch is not carrying. The lag itself is taken when the ack lands.
      const freshestUpdatedAtMs = resolveFreshestUpdatedAtMs(batch.sessions);
      // Goal stage 3: a batch reached the wire — productive work whatever the
      // ack says (trace outcome only; ack handling is unchanged).
      pass.noteOutcome(SyncPassOutcome.Sent);
      let ack: DesktopAgentSessionsAck;
      this.progressTally.noteSending(syncIds);
      try {
        ack = await this.options.sendBatch(batch, { compress: sendCompress });
      } catch (sendError) {
        // A thrown transport error (socket drop, serialization failure) is
        // itself a batch failure. FEA-3364: unlike an ack rejection it used to
        // increment no counter, so the batch stayed queued at retry-count 0 and
        // re-sent every 5s forever (a persistent transport/serialization fault =
        // infinite retry, never dead-lettered). Bound it here: a serialization
        // bug dead-letters at once, a dropped connection defers the lane
        // (ISS-10602), anything else after MAX_CONSECUTIVE_TRANSPORT_ERRORS.
        // Emit the batch outcome so the dashboard counts it (dead_letter when
        // the throw stranded a session, else failure) instead of silently
        // undercounting — the outer catch only logs. Rethrow so the existing
        // "sync failed" log and finally-block cleanup still run.
        // ISS-7248: read the budget BEFORE the fold. An exhausting fold
        // dead-letters the row and clears its counters, so reading afterwards
        // would blank the attempt number on exactly the record that proves the
        // retries never landed.
        const attemptBefore = this.failureCountFor(
          SyncReason.TransportError,
          syncIds
        );
        // Whether a pinned remainder actually existed to discard. The final
        // chunk of a sequence already cleared the tail when it was shifted off,
        // so assuming the discard from `drainingPendingChunkTail` alone would
        // report an abandoned sequence for a batch that abandoned nothing.
        const hadPinnedChunkTail = this.pendingChunks !== null;
        const deadLettered = this.handleTransportError(
          syncMode,
          syncIds,
          accumulatedBytes,
          sendError
        );
        // ISS-7248: a throw while draining a tail discards the WHOLE remainder
        // a few lines below, so the shaping this attempt is reported with must
        // say so — resolving it after that assignment would read `pendingChunks`
        // already nulled and be unable to tell the two cases apart.
        this.reportAttemptFailure({
          attemptBefore,
          batchId: batch.batchId,
          outcome: deadLettered
            ? DesktopSyncBatchOutcome.DeadLetter
            : DesktopSyncBatchOutcome.Failure,
          reason: SyncReason.TransportError,
          payloadBytes: accumulatedBytes,
          sessionIds: syncIds,
          ...resolveSyncPayloadShapingPair({
            drainingPendingChunkTail,
            hasPinnedChunkTail: hadPinnedChunkTail,
            chunkTailDiscarded: drainingPendingChunkTail && hadPinnedChunkTail,
            activityTilingStripped: tilingStrippedSessionCount > 0,
          }),
          tilingStrippedSessionCount,
          latencyMs: Math.max(0, Date.now() - sendStartedMs),
        });
        if (drainingPendingChunkTail) {
          // ISS-4541 (davetho P1): this throw stranded a chunk that
          // `resolvePendingChunkTransition` had ALREADY shifted off the pending
          // tail. Draining the remaining tail on later ticks would dequeue the
          // session with this chunk permanently missing from the cloud tiling.
          // Discard the whole remaining tail so the session re-prepares from
          // chunk 0 next tick — same recovery the capability-downgrade discard
          // path uses above.
          this.pendingChunks = null;
        }
        throw sendError;
      }
      // Clamp at 0: a backward wall-clock step (NTP correction, sleep/resume)
      // during the awaited round-trip would otherwise yield a negative latency,
      // which the contract's `sync.latency_ms` (z.number().min(0)) rejects —
      // throwing inside emitSyncBatchEvent and dropping the event. Mirrors the
      // existing Math.max(0, …) duration guard elsewhere in the desktop main.
      const latencyMs = Math.max(0, Date.now() - sendStartedMs);
      // ISS-8116: token + generation + `started` + the LIVE identity, and
      // deliberately NOT `shouldRun()`. The readiness omission is pre-existing
      // and load-bearing — the server already accepted this batch, so a
      // readiness drop must not discard its ack and force a re-upload. An
      // identity move is the opposite case: folding the ack clears outbox rows
      // and advances a cursor that now belong to a different account.
      //
      // ENTRY only — the same predicate is re-read after the tiling-debt and
      // durable-clear awaits inside `processAcceptedAck` (`AcceptedAckDeps.
      // isCurrentSourceIdentity`), because a check here cannot see an identity
      // that moves while those are outstanding (davetho / whitlockk review).
      if (!passIdentity.isCurrentSourceIdentity()) {
        gatewayLog.debug(
          TAG,
          "ignoring agent-session batch ack from a stale dashboard source"
        );
        return;
      }
      await this.handleBatchAck(
        syncMode,
        syncIds,
        batch.sessionCount,
        accumulatedBytes,
        ack,
        latencyMs,
        isMultiPartSyncEnvelope(batch),
        {
          batchId: batch.batchId,
          drainingPendingChunkTail,
          tilingStrippedSessionIds: strippedIds,
          freshestUpdatedAtMs,
          unsendableComponentUnits,
          priorityUploadClaims: priorityUploadClaims(batch.sessions),
        }
      );
    } catch (error) {
      // ISS-5262/ISS-8776: derived ONCE, from the failure log's own verdict.
      // This was a parallel switch on `isDbHostShutdownError`, and it drifted
      // the moment a SECOND abandonment case (a db-host the supervisor has
      // given up restarting) was added to that helper — the trace would have
      // printed `outcome=failed` for a pass the log called abandoned.
      pass.noteOutcome(
        logSyncTickFailure(TAG, error)
          ? SyncPassOutcome.Failed
          : SyncPassOutcome.Abandoned
      );
    } finally {
      if (this.activeSyncToken === syncToken) {
        this.activeSyncToken = null;
        this.syncing = false;
        this.progressTally.noteSending([]);
      }
      // Goal stage 3 (ISS-5993): one trace line per pass — the instrument that
      // names which stage gated a starved tick.
      pass.finish();
      // Exactly one coalesced follow-up for the triggers that landed mid-pass.
      if (this.pump.takeFollowUp() && this.started) {
        this.schedulePendingPartDrain();
      }
    }
  }

  /**
   * The uncompressed-path oversize prefilter — mechanics and the FEA-2718 /
   * FEA-4152 rationale live in `selectHydratableCandidateIds` in
   * `agent-session-payload-preparation.ts`; this delegate only wires the
   * dead-letter collaborator.
   */
  private selectHydratableCandidateIds(
    source: AgentSessionSyncSource,
    syncMode: AgentSessionSyncMode,
    candidateIds: string[],
    compress: boolean
  ): Promise<string[]> {
    return selectHydratableCandidateIds(source, candidateIds, compress, {
      contentByteCap: SESSION_PAYLOAD_CONTENT_BYTE_CAP,
      deadLetterOversized: (id, payloadBytes) =>
        deadLetterOversizedLocalSession(
          { syncMode, sessionId: id, payloadBytes },
          this.dispositionDeps()
        ),
    });
  }

  /**
   * FEA-2733 / FEA-3473: the once-per-identity full-corpus walk, its durable
   * outbox seed and the cursor persist that follows — all in the cohesive
   * sibling `initial-backfill-walk.ts`. This file keeps only the delegate that
   * hands its own fields through (ISS-8116; same split as
   * `backfill-queue-feed.ts` and `incremental-cursor-feed.ts`).
   */
  private initializeBackfillQueueIfNeeded(
    source: AgentSessionSyncSource,
    passIdentity: SyncPassIdentityGuard
  ): Promise<void> {
    return runInitialBackfillWalk({
      source,
      isCurrentSourceState: passIdentity.isCurrentSourceState,
      isCurrentSourceIdentity: passIdentity.isCurrentSourceIdentity,
      historicalBackfillEnabled: this.historicalBackfillEnabled,
      readObservedTopUpdatedAt: () => this.observedTopUpdatedAt,
      markInitialPassRun: () => {
        this.initialBackfillPassRun = true;
      },
      seedObservedTop: (rows) => {
        this.observedTopUpdatedAt = rows[0].updated_at;
        this.observedIdsAtTopUpdatedAt = collectIdsAtTimestamp(
          rows,
          this.observedTopUpdatedAt
        );
        return this.observedIdsAtTopUpdatedAt.size;
      },
      enqueueBackfillRows: (rows) => {
        const newlyQueued: string[] = [];
        for (const row of rows) {
          if (this.backfillQueuedIds.has(row.id)) {
            continue;
          }
          this.backfillQueuedIds.add(row.id);
          this.backfillQueue.push(row.id);
          this.queuedUpdatedAtById.set(row.id, row.updated_at);
          newlyQueued.push(row.id);
        }
        return newlyQueued;
      },
      resetDeadLetterRevisit: () => {
        this.deadLetterRevisitedThisIdleCycle = false;
      },
      resolveSourceKey: () =>
        this.hydratedSourceKey ?? SessionSyncCapability.sourceKey(this.options),
      seedThenPersistInitialBackfill: (sourceKey, ids, isCurrentIdentity) =>
        this.cursor.seedThenPersistInitialBackfill(
          sourceKey,
          ids,
          isCurrentIdentity
        ),
      logInfo: (message) => gatewayLog.info(TAG, message),
    });
  }

  private async enqueueIncrementalUpdates(
    source: AgentSessionSyncSource,
    /** ISS-8116: the pass guard — see `initializeBackfillQueueIfNeeded`. */
    isCurrentSourceState: () => boolean
  ): Promise<void> {
    if (!this.observedTopUpdatedAt) {
      return;
    }

    const previousTopUpdatedAt = this.observedTopUpdatedAt;
    const previousTopIds = new Set(this.observedIdsAtTopUpdatedAt);
    // PRD-536 E1: pass the FULL observed-id SET at the top timestamp (not just
    // its max) so the query re-reads the tied-top-timestamp cluster while
    // excluding exactly the already-seen ids — `WHERE updated_at > $1 OR
    // (updated_at = $1 AND id NOT IN (<observed ids>))`. This catches a
    // genuinely-new sibling that lands at the SAME top `updated_at` with a
    // LOWER-sorting id (two same-millisecond writes) — the previous `id > maxId`
    // boundary silently skipped such a row forever (data loss), since it is
    // neither `> maxId` nor at a strictly-greater timestamp. Already-seen ids stay
    // excluded, so the seen cluster is not needlessly re-emitted (the keyset
    // perf win — no re-walk of the whole corpus — is preserved). The
    // `previousTopIds` JS filter below is retained as belt-and-suspenders for the
    // empty-set fallback (an over-cap persisted cursor drops the set, so the DB
    // re-selects the whole tied-top group); it is idempotently deduped by the
    // outbox + server too.
    const rows = await source.listUpdatedSessionCursorRows(
      previousTopUpdatedAt,
      [...previousTopIds]
    );
    // ISS-8116: the fold below writes the incremental queue, advances
    // `observedTopUpdatedAt`, and issues two DURABLE outbox writes (`enqueue` +
    // `rePend`) whose key the writers re-resolve at call time — so a superseded
    // read would enqueue rows selected under the departing account onto the
    // arriving one, against a watermark that never described it.
    if (!isCurrentSourceState()) {
      return;
    }
    if (rows.length === 0) {
      return;
    }

    // ISS-4807: the admission + watermark-advance policy lives in the sibling
    // `incremental-cursor-feed` (mirroring `backfill-queue-feed`), so this file
    // keeps only the thin delegate that hands its own queue fields through.
    const { newlyQueued, nextTopUpdatedAt, nextTopIds } =
      feedIncrementalCursorRows(
        {
          incrementalQueue: this.incrementalQueue,
          incrementalQueuedIds: this.incrementalQueuedIds,
          backfillQueuedIds: this.backfillQueuedIds,
          queuedUpdatedAtById: this.queuedUpdatedAtById,
        },
        rows,
        previousTopUpdatedAt,
        previousTopIds
      );
    if (newlyQueued.length > 0) {
      // Genuinely-new incremental work preempts dead-letter retries: reset the
      // idle-cycle revisit guard so this session drains first and the next
      // dead-letter promotion waits for the next idle cycle.
      this.deadLetterRevisitedThisIdleCycle = false;
    }

    // FEA-3473: durably record the incremental enqueue in the outbox.
    this.outbox.enqueue(newlyQueued, AgentSessionSyncClass.Incremental);
    // ISS-7246: a bumped `updated_at` is NEW EVIDENCE about a session this lane
    // previously withheld as unsubstantive, so its row returns to `pending` to
    // be re-judged. The enqueue above cannot do this itself: its `ON CONFLICT`
    // clause deliberately never touches `status` (so a re-enqueue can never
    // resurrect a dead-letter), which would otherwise leave a withheld row
    // withheld forever and a session that became substantive would never
    // upload. Scoped to the INCREMENTAL feed on purpose — the whole-corpus
    // backfill re-seed carries no new information about a session, so re-pending
    // there would reintroduce a per-boot phantom cycle.
    this.outbox.rePend(newlyQueued);

    this.observedTopUpdatedAt = nextTopUpdatedAt;
    this.observedIdsAtTopUpdatedAt = nextTopIds;
  }

  /**
   * FEA-1962 / FEA-3473 / FEA-3659: the once-per-identity hydration — stranded-row
   * adoption, the durable cursor load and what it seeds, the un-acked prefix
   * resume and its retry counters — all in the cohesive sibling
   * `persisted-cursor-hydration.ts`. This file keeps only the delegate that hands
   * its own fields through (ISS-8116; same split as `initial-backfill-walk.ts`).
   */
  private hydratePersistedCursorIfNeeded(
    source: AgentSessionSyncSource,
    isCurrentSourceState: () => boolean
  ): Promise<boolean> {
    return hydratePersistedCursorForPass({
      source,
      isCurrentSourceState,
      resolveLiveSourceKey: () => SessionSyncCapability.sourceKey(this.options),
      readContract: () => SessionSyncCapability.contract(this.options),
      readHydratedSourceKey: () => this.hydratedSourceKey,
      setHydratedSourceKey: (sourceKey) => {
        this.hydratedSourceKey = sourceKey;
      },
      readSourceDerivedStateKey: () => this.sourceDerivedStateKey,
      setSourceDerivedStateKey: (sourceKey) => {
        this.sourceDerivedStateKey = sourceKey;
      },
      clearSourceDerivedState: () => this.clearSourceDerivedState(),
      syncOptions: this.options,
      applyResumedCursor: (observedTopUpdatedAt, observedIdsAtTopUpdatedAt) => {
        this.observedTopUpdatedAt = observedTopUpdatedAt;
        this.observedIdsAtTopUpdatedAt = new Set(observedIdsAtTopUpdatedAt);
        // ISS-8041: what is already on disk for this identity, so a prefix
        // boundary below it is refused instead of rewinding the cursor.
        this.cursor.noteResumedFrom(observedTopUpdatedAt);
      },
      adoptLaneRun: this.folds.adoptLaneRun,
      deadLetteredIds: this.deadLetteredIds,
      enforceDeadLetterCap: () =>
        enforceDeadLetterCap(this.deadLetterLifecycleDeps()),
      dispositionDeps: () => this.dispositionDeps(),
      retryCounters: {
        ackOmitted: this.ackOmittedCountById,
        ackTimeout: this.timeoutCountById,
        ingestionFailed: this.ingestionFailedCountById,
        rateLimited: this.rateLimitedCountById,
        unknownAckReason: this.unknownAckReasonCountById,
        validationFailed: this.validationFailedCountById,
        nextRetryAfterMs: this.nextRetryAfterMs,
        laneStalledSinceMsById: this.laneStalledSinceMsById,
        deadLetterRecoveryCountById: this.deadLetterCountById,
        ackOmittedCycleById: this.ackOmittedCycleById,
      },
      ...agentSessionSyncLogDeps,
      // ISS-8610: the give-up stamp is adopted in here, after admission ran.
    }).then((hydrated) => hydrated && !this.folds.heldEnvironmentally());
  }

  /**
   * ISS-8041: the two durable-cursor writes and the outbox seed that orders one
   * of them, bound to this lane's live state. The state getter is re-resolved per
   * call for the same reason `outbox` is — hydration and account switches move
   * the identity under it. What the prefix boundary may claim lives in
   * `agent-session-sync-cursor-prefix.ts`.
   */
  private readonly cursor = createSessionCursorPersister(
    () => ({
      historicalBackfillEnabled: this.historicalBackfillEnabled,
      sourceKey: this.hydratedSourceKey,
      source: this.options.getSource?.() ?? null,
      contract: SessionSyncCapability.contract(this.options),
      unackedIds: collectOwedIds(
        this.incrementalQueue,
        this.backfillQueue,
        this.pendingChunks?.sessionId ?? null
      ),
      queuedUpdatedAtById: this.queuedUpdatedAtById,
      observedTopUpdatedAt: this.observedTopUpdatedAt,
      observedIdsAtTopUpdatedAt: this.observedIdsAtTopUpdatedAt,
      deadLetteredIds: this.deadLetteredIds.keys(),
    }),
    (message) => gatewayLog.warn(TAG, message),
    AgentSessionSyncClass.Backfill
  );

  private selectReadyCandidates(
    queue: readonly string[],
    limit: number,
    nowMs: number
  ): string[] {
    return pickReadyCandidates({
      queue,
      limit,
      nowMs,
      nextRetryAfterMs: this.nextRetryAfterMs,
    });
  }

  private async handleBatchAck(
    syncMode: AgentSessionSyncMode,
    ids: string[],
    sessionCount: number,
    payloadBytes: number,
    ack: DesktopAgentSessionsAck,
    latencyMs: number,
    // ISS-5090: whether the sent envelope was one part of a MULTI-part chunk
    // sequence. A `validation_failed` on such a part is not attributable to the
    // persisted row, so it may not spend the deterministic dead-letter budget.
    multiPartEnvelope: boolean,
    attempt: SentBatchAttempt
  ): Promise<void> {
    if (ack.accepted) {
      this.firstAckReceived = true;
      this.transportTimeoutBudget.noteVerifiedAck();
      // Only dequeue the session after all chunks have been sent. The rest of
      // accepted-ack processing — the goal-stage-2 awaited row-level durable
      // clear keyed on the server echo, the ack_omitted fold, logging,
      // self-continue, telemetry — lives in agent-session-sync-accepted-ack.ts.
      const hasMoreChunks =
        this.pendingChunks !== null &&
        ids.length === 1 &&
        this.pendingChunks.sessionId === ids[0];
      await processAcceptedAck(
        acceptedAckInput({
          syncMode,
          ids,
          sessionCount,
          payloadBytes,
          latencyMs,
          hasMoreChunks,
          pendingChunkCount: this.pendingChunks?.chunks.length ?? null,
          acceptedSessionIds: ack.acceptedSessionIds,
          attempt,
        }),
        {
          rowState: {
            timeoutCountById: this.timeoutCountById,
            rateLimitedCountById: this.rateLimitedCountById,
            unknownAckReasonCountById: this.unknownAckReasonCountById,
            ingestionFailedCountById: this.ingestionFailedCountById,
            laneStalledSinceMsById: this.laneStalledSinceMsById,
            validationFailedCountById: this.validationFailedCountById,
            ackOmittedCountById: this.ackOmittedCountById,
            validationBisectIds: this.validationBisectIds,
            transportErrorCountById: this.transportErrorCountById,
            clearTransportTimeoutBudgetFor: (id) =>
              this.transportTimeoutBudget.clearFor(id),
            nextRetryAfterMs: this.nextRetryAfterMs,
            deadLetterCountById: this.deadLetterCountById,
            chunkValidationCycleById: this.chunkValidationCycleById,
            ackOmittedCycleById: this.ackOmittedCycleById,
            deadLetteredIds: this.deadLetteredIds,
          },
          ...this.outbox.slices.acceptedAck,
          clearLaneGiveUp: this.folds.clearLaneGiveUp,
          sourceStateGeneration: () => this.sourceStateGeneration,
          isStarted: () => this.started,
          isCurrentSourceIdentity: () => this.currentPassIdentityGuard(),
          // ISS-7099: the ONE proven-delivery site. `processAcceptedAck` calls
          // this only after the server verified the ack AND the durable outbox
          // clear committed, and a chunked session reaches it once, on its
          // final chunk — so this cannot double-count or credit a withhold.
          dequeue: (mode, ackedIds) => {
            this.progressTally.noteDelivered(ackedIds.length);
            this.dequeue(mode, ackedIds);
          },
          persistCursorIfCaughtUp: () => this.cursor.persistIfAdvanced(),
          applyBoundedFold: (config) => this.folds.applyBoundedFold(config),
          deadLetteredCount: () => this.deadLetteredIds.size,
          resetDeadLetterRevisitAfterDrainedAck: () =>
            this.resetDeadLetterRevisitAfterDrainedAck(),
          queueSizes: () => ({
            incremental: this.incrementalQueue.length,
            backfill: this.backfillQueue.length,
          }),
          discardPendingChunkTail: () => {
            this.pendingChunks = null;
          },
          schedulePendingPartDrain: () => this.schedulePendingPartDrain(),
          scheduleImmediateDrainIfReadyWorkRemains: () =>
            this.scheduleImmediateDrainIfReadyWorkRemains(),
          emitTelemetry: (event) => this.options.onSyncBatchTelemetry?.(event),
          reportFreshnessAnomaly: reportFreshestSessionLagAnomaly,
          ...agentSessionSyncLogDeps,
        }
      );
      return;
    }

    // On any failure, discard remaining chunks for this session — partial
    // chunk sequences are not useful without server-side reassembly.
    //
    // FEA-1461: the next retry re-fetches + re-chunks the source session. That
    // work is bounded by the per-session backoff added below and, terminally, by
    // whichever bound the reason's class carries. True resume-from-chunk-N needs
    // server-side partial reassembly and is out of scope on FEA-1461.
    // ISS-7248: whether THIS ack threw away a pinned remainder. Latched before
    // the tail is nulled, because after that the two cases — "one chunk failed"
    // and "the whole in-flight sequence was abandoned" — are indistinguishable.
    let chunkTailDiscarded = false;
    if (this.pendingChunks && ids.includes(this.pendingChunks.sessionId)) {
      gatewayLog.warn(
        TAG,
        `discarding ${this.pendingChunks.chunks.length} remaining chunk(s) for session ${this.pendingChunks.sessionId} after batch failure (${ack.reason})`
      );
      this.pendingChunks = null;
      chunkTailDiscarded = true;
    }

    /* FEA-1995: a batch is a `dead_letter` for sync.* telemetry when this ack
       removes one or more sessions from the queue. Since ISS-8605 that happens
       two ways: a budgeted class exhausting its counter (validation_failed,
       transport_timeout), or ANY environmental class crossing the 24h wall clock
       — including an unrecognized reason. Every other outcome defers and reports
       `failure`. */
    const deadLetteredCountBefore = this.deadLetteredIds.size;
    // ISS-7248: same reason as the thrown-transport path — an exhausting fold
    // clears the counter it just consumed, so the pre-fold reading is the only
    // place the exhausted attempt number is still legible.
    // ISS-8595: one reading, so the budget and the failure record cannot disagree.
    const failureReason = syncReasonForAckReason(ack.reason);
    const attemptBefore = this.failureCountFor(failureReason, ids);

    await dispatchRejectedAck(
      { ack, ids, syncMode, payloadBytes, multiPartEnvelope },
      {
        nextRetryAfterMs: this.nextRetryAfterMs,
        applyBoundedFold: (config) => this.folds.applyBoundedFold(config),
        validationFailureDeps: () => this.folds.validationFailureDeps(),
        applyLaneStallFold: (config) => this.folds.applyLaneStall(config),
        transportTimeoutFoldPolicy: () =>
          this.transportTimeoutBudget.foldPolicy(),
        // Referenced, not re-wrapped: every fold runner is already a closure
        // over the one captured view, so there is no `this` to rebind.
        deferLaneEnvironmental: this.folds.deferLaneEnvironmental,
        noteLaneAnswered: this.folds.noteLaneAnswered,
        noteTransportLoss: (cause) => this.noteTransportLoss(cause),
        pauseForFeatureDisabled: () => {
          this.featureDisabledForSession = true;
          this.timers.stopPoll();
        },
        ...agentSessionSyncLogDeps,
      }
    );

    this.options.onBatchOutcome?.({
      outcome: DesktopSyncBatchOutcome.Failure,
      // UNFOLDED: free-form product analytics keeps the skew class.
      reason: ack.reason,
      syncMode,
      sessionCount,
      payloadBytes,
    });
    // ISS-7248: one record per failed attempt, to both sinks. The server ack
    // reason (ack_timeout / rate_limited / ingestion_failed / validation_failed
    // / feature_disabled) is the failure/dead-letter cause; surfacing it is the
    // whole point of FEA-3426 (the SLO can split by reason instead of inferring
    // from payload_bytes/latency_ms).
    this.reportAttemptFailure({
      attemptBefore,
      batchId: attempt.batchId,
      outcome:
        this.deadLetteredIds.size > deadLetteredCountBefore
          ? DesktopSyncBatchOutcome.DeadLetter
          : DesktopSyncBatchOutcome.Failure,
      reason: failureReason,
      payloadBytes,
      sessionIds: ids,
      ...resolveSyncPayloadShapingPair({
        drainingPendingChunkTail: attempt.drainingPendingChunkTail,
        hasPinnedChunkTail: this.pendingChunks !== null,
        chunkTailDiscarded,
        activityTilingStripped: attempt.tilingStrippedSessionIds.length > 0,
      }),
      tilingStrippedSessionCount: attempt.tilingStrippedSessionIds.length,
      latencyMs,
    });

    // A dead-letter dequeues its rows and may have just drained both queues
    // without any accepted batch to trigger the persist. Recording the dead ids
    // and advancing the watermark here is what stops the full re-walk on the
    // next restart (the accepted path persists via handleBatchAck's success
    // branch; this covers the "only remaining rows dead-lettered" case).
    if (this.deadLetteredIds.size > deadLetteredCountBefore) {
      this.cursor.persistIfAdvanced();
      // FEA-4375: a terminal rejection that dead-letters rows is forward progress
      // — self-continue so a failure-heavy corpus behind repeatedly-rejected
      // batches does not pay the 5s poll per terminal batch (davetho / whitlockk).
      // Gated on a genuine dead-letter THIS ack: a purely-deferred rejection or a
      // lane-wide pause (feature_disabled / unauthenticated / transport_unavailable)
      // leaves the set unchanged and does NOT self-continue, and the rescheduler
      // itself only fires on a READY neighbor, so deferred backoff never spins.
      this.scheduleImmediateDrainIfReadyWorkRemains();
    }
  }

  /**
   * ISS-7248: report ONE failed sync attempt — the durable local record plus the
   * `sync.batch` span — from the single seam every failure path goes through.
   *
   * Called strictly AFTER the reason fold, so the attempt number it reads is the
   * count including this failure. The ids reach only the DURABLE sink; the span
   * seam is fed a strict transport-health subset by `reportSyncAttemptFailure`,
   * so no session id can cross the wire from here.
   */
  private reportAttemptFailure(
    // `deadLetteredThisAttempt` is derived from `outcome` below, so callers must
    // not have to supply it — only this wrapper holds DesktopSyncBatchOutcome as
    // a value, which is what keeps the diagnostic module's telemetry import
    // type-only.
    input: Omit<
      Parameters<typeof reportSessionMetadataAttemptFailure>[1],
      "deadLetteredThisAttempt"
    >
  ): void {
    reportSessionMetadataAttemptFailure(
      {
        emitTelemetry: this.options.onSyncBatchTelemetry,
        writeDurableRecord: (line) => gatewayLog.warn(TAG, line),
        getOrganizationId: () =>
          this.options.getSyncIdentity?.()?.organizationId,
        failureCountFor: (reason, ids) => this.failureCountFor(reason, ids),
      },
      {
        ...input,
        deadLetteredThisAttempt:
          input.outcome === DesktopSyncBatchOutcome.DeadLetter,
      }
    );
  }

  /**
   * Highest consecutive-failure count these ids carry in the budget THIS reason
   * charges — not across every budget. Maxing across all of them reports a count
   * the current failure did not cause: a session holding an old `ingestion_failed`
   * charge would make an `unauthenticated` deferral (which burns nothing) look
   * like a retry.
   */
  private failureCountFor(reason: SyncReason, ids: readonly string[]): number {
    return failureCountForReason(reason, ids, {
      ackTimeout: this.timeoutCountById,
      transportTimeout: this.transportTimeoutBudget.charges(),
      rateLimited: this.rateLimitedCountById,
      ingestionFailed: this.ingestionFailedCountById,
      validationFailed: this.validationFailedCountById,
      ackOmitted: this.ackOmittedCountById,
      transportError: this.transportErrorCountById,
    });
  }

  /**
   * FEA-3364: fold a THROWN `sendBatch` or payload prep, which produces no ack
   * and so cannot ride the ack-reason fold. Delegates to the pure
   * `applyTransportErrorFold`, wiring this service's counters/queues/chunks and
   * the lane gate as the collaborator. Returns whether any id was dead-lettered
   * so the caller can pick the batch telemetry outcome (`dead_letter` vs
   * `failure`); the fold module owns the classification (a dropped connection
   * defers the lane, ISS-10602) and documents it.
   */
  private handleTransportError(
    syncMode: AgentSessionSyncMode,
    ids: string[],
    payloadBytes: number,
    error: unknown
  ): boolean {
    return applyTransportErrorFold(
      {
        syncMode,
        ids,
        payloadBytes,
        error,
        maxConsecutive: MAX_CONSECUTIVE_TRANSPORT_ERRORS,
      },
      {
        transportErrorCountById: this.transportErrorCountById,
        // ISS-5090: funnel through the shared helper instead of a hand-rolled
        // subset — the inline deletes had already drifted (they left the
        // validation counters and the bisection flag behind on this path).
        clearRetryStateForId: (id) => this.clearFailureStateForId(id),
        markDeadLettered: (id, recoverable, reason) =>
          this.markDeadLettered(id, recoverable, reason),
        discardPendingChunksFor: (deadLettered) => {
          if (
            this.pendingChunks &&
            deadLettered.includes(this.pendingChunks.sessionId)
          ) {
            this.pendingChunks = null;
          }
        },
        dequeue: (mode, deadLettered) => this.dequeue(mode, deadLettered),
        queueSizes: () => ({
          incremental: this.incrementalQueue.length,
          backfill: this.backfillQueue.length,
          deadLettered: this.deadLetteredIds.size,
        }),
        persistCursorIfCaughtUp: () => this.cursor.persistIfAdvanced(),
        scheduleImmediateDrainIfReadyWorkRemains: () =>
          this.scheduleImmediateDrainIfReadyWorkRemains(),
        noteTransportLoss: (cause) => this.noteTransportLoss(cause),
        deferLaneEnvironmental: this.folds.deferLaneEnvironmental,
        ...agentSessionSyncLogDeps,
      }
    );
  }

  /**
   * Delegates to `resetDeadLetterRevisitAfterDrainedAck` in
   * `agent-session-sync-dead-letter-lifecycle.ts` — the re-arm of the
   * once-per-idle-cycle revisit guard, called by the accepted-ack processor.
   */
  private resetDeadLetterRevisitAfterDrainedAck(): void {
    resetDeadLetterRevisitAfterDrainedAck(this.deadLetterLifecycleDeps());
  }

  private clearFailureStateForId(id: string): void {
    this.timeoutCountById.delete(id);
    this.rateLimitedCountById.delete(id);
    this.unknownAckReasonCountById.delete(id);
    this.ingestionFailedCountById.delete(id);
    // ISS-7730: the stall clock is per-class state like every counter beside it.
    // Dropping it on a dead-letter or a recovery is what stops a recovered row
    // from carrying an already-expired run back onto the queue and
    // dead-lettering on its very first post-recovery failure.
    this.laneStalledSinceMsById.delete(id);
    this.validationFailedCountById.delete(id);
    // Goal stage 2: keep the ack-omitted budget in the shared clear set.
    this.ackOmittedCountById.delete(id);
    // FEA-4375: a dead-letter / recovery clears the bisection flag too, so a
    // set-aside or re-enqueued id never carries a stale singleton-isolation
    // marker back onto the queue.
    this.validationBisectIds.delete(id);
    this.transportErrorCountById.delete(id);
    // ISS-5088: keep the client-abort budget in the same clear set as every
    // other per-class counter, so a dead-lettered or recovered id never carries
    // a stale charge back onto the queue.
    this.transportTimeoutBudget.clearFor(id);
    this.nextRetryAfterMs.delete(id);
  }

  /**
   * ISS-5088: record unambiguous connectivity loss on the client-abort budget —
   * a `transport_unavailable` ack, a send that failed at the network, or
   * readiness going false. See `TransportTimeoutBudget` for why this both
   * refunds and suppresses.
   */
  private noteTransportLoss(cause: string): void {
    this.transportTimeoutBudget.noteLoss(cause, (message) =>
      gatewayLog.info(TAG, message)
    );
  }

  /**
   * Delegates to `markDeadLettered` in
   * `agent-session-sync-dead-letter-lifecycle.ts` — see that module for the
   * FEA-3363 / FEA-3795 deadline and escalation rules, and for why the
   * deterministic classes take an infinite deadline.
   */
  private markDeadLettered(
    id: string,
    recoverable: boolean,
    reason: string,
    attemptCount = 0,
    permanentAttemptCount: number | null = null
  ): void {
    markDeadLettered(
      id,
      recoverable,
      reason,
      attemptCount,
      permanentAttemptCount,
      this.deadLetterLifecycleDeps()
    );
  }

  /**
   * ISS-6031: SELECTION TOTALITY — every `pending` outbox row must eventually be
   * selected.
   *
   * The outbox is the durable record of what is still owed to the cloud, but
   * until now it was only ever re-read into the queues on RESUME
   * (`hydratePersistedCursorIfNeeded`). Any path that dropped an id from the
   * in-memory queues WITHOUT resolving its outbox row therefore stranded it until
   * the next process start: the row stayed `pending` with `attempt_count = 0`,
   * `next_attempt_at` and `last_error` NULL, and the pump never looked at it
   * again. That is a HANG, not a failure — no error, no backoff, no log — and it
   * pins the reported backlog above zero forever.
   *
   * So when both queues are drained and no chunk is in flight, re-read the outbox
   * and feed anything untracked back onto the backfill lane. This closes the hole
   * for EVERY such path, present and future, rather than auditing each dequeue
   * site one at a time — a strictly weaker guarantee is not worth having, because
   * the failure it prevents is silent.
   *
   * Cheap and self-limiting: it runs only in the idle state, issues one indexed
   * read, and `feedIdsIntoBackfillQueue` skips ids already tracked or set aside as
   * dead-letters. A row that is re-stranded on the next pass is re-queued again,
   * which is exactly right — the loop is bounded by the 5s poll and by the
   * logger's consecutive-duplicate suppression, and a repeating reconcile is the
   * signal that a dequeue path is still losing rows.
   */
  private reconcilePendingOutboxIfIdle(source: AgentSessionSyncSource): void {
    void reconcilePendingOutboxIfIdle(
      {
        enabled: this.historicalBackfillEnabled,
        sourceKey: this.hydratedSourceKey,
        hasPendingChunks: this.pendingChunks !== null,
        inFlight: this.outboxReconcileInFlight,
        setInFlight: (value) => {
          this.outboxReconcileInFlight = value;
        },
        hasProbe: Boolean(source.loadPendingOutboxIds),
        loadPendingIds: (key) => source.loadPendingOutboxIds?.(key),
      },
      this.dispositionDeps()
    );
  }

  /**
   * The service-owned state/collaborators the dead-letter lifecycle mutates.
   * Collections go by REFERENCE (same discipline as
   * `backfillQueueFeedState`); the scalars the service reassigns are threaded
   * as accessors so no snapshot can go stale between passes.
   */
  private deadLetterLifecycleDeps(): DeadLetterLifecycleDeps {
    return {
      deadLetteredIds: this.deadLetteredIds,
      deadLetterCountById: this.deadLetterCountById,
      chunkValidationCycleById: this.chunkValidationCycleById,
      ackOmittedCycleById: this.ackOmittedCycleById,
      backfillQueue: this.backfillQueue,
      backfillQueuedIds: this.backfillQueuedIds,
      incrementalQueue: this.incrementalQueue,
      incrementalQueuedIds: this.incrementalQueuedIds,
      hasPendingChunks: () => this.pendingChunks !== null,
      isHistoricalBackfillEnabled: () => this.historicalBackfillEnabled,
      wasDeadLetterRevisitedThisIdleCycle: () =>
        this.deadLetterRevisitedThisIdleCycle,
      setDeadLetterRevisitedThisIdleCycle: (revisited) => {
        this.deadLetterRevisitedThisIdleCycle = revisited;
      },
      clearFailureStateForId: (id) => this.clearFailureStateForId(id),
      recordOutboxDeadLetter: (...args) => this.outbox.deadLetter(...args),
      recordOutboxReEnqueue: (id) => this.outbox.reEnqueue(id),
      ...agentSessionSyncLogDeps,
    };
  }

  /**
   * ISS-6031: an EMPTY `loadSyncedSessions` result is a read result, not a
   * cause. Delegated so the decision and its two outcomes live in one tested
   * module (`agent-session-hydration-absence.ts`).
   *
   * ISS-8115 — `source` is handed over WHOLE rather than as a pre-built probe
   * thunk. Building the thunk here (`source.findExistingSessionIds?.(ids)`)
   * destroyed the one fact the callee needs: optional chaining answers
   * `undefined` both for a delegate that is missing and for a delegate that
   * returned nothing, and only the second is a fault. `buildSessionPresenceProbe`
   * now decides it where the delegate is still visible, and still invokes it as
   * a MEMBER call — in the db-host build `source` is the FEA-2038 forwarding
   * Proxy, whose `get` trap answers `call`/`apply`/`bind` with `undefined`, so a
   * detached reference would throw and permanently degrade the probe to
   * "unverified" on exactly the build that matters.
   */
  private resolveEmptyHydration(
    source: AgentSessionSyncSource,
    syncMode: AgentSessionSyncMode,
    ids: string[]
  ): Promise<void> {
    return resolveEmptyHydration(
      {
        syncMode,
        ids,
        backoffMs: UNCONFIRMED_ABSENCE_BACKOFF_MS,
        source,
      },
      this.dispositionDeps()
    );
  }

  /**
   * The collaborator every pre-send disposition runs on
   * (`agent-session-sync-dispositions.ts`). Built in one place so the absent /
   * unproven / idle / oversized paths cannot drift onto different queue,
   * telemetry or cursor-persistence wiring.
   */
  private dispositionDeps(): SessionDispositionDeps {
    return {
      nextRetryAfterMs: this.nextRetryAfterMs,
      clearFailureStateForId: (id) => this.clearFailureStateForId(id),
      markDeadLettered: (id, recoverable, reason) =>
        this.markDeadLettered(id, recoverable, reason),
      dequeue: (syncMode, ids) => this.dequeue(syncMode, ids),
      queueSizes: () => ({
        incremental: this.incrementalQueue.length,
        backfill: this.backfillQueue.length,
        deadLettered: this.deadLetteredIds.size,
      }),
      ...agentSessionSyncLogDeps,
      emitDeadLetterTelemetry: (input) =>
        this.options.onSyncBatchTelemetry?.(input),
      persistCursorIfCaughtUp: () => this.cursor.persistIfAdvanced(),
      scheduleImmediateDrainIfReadyWorkRemains: () =>
        this.scheduleImmediateDrainIfReadyWorkRemains(),
      isTracked: (id) =>
        this.backfillQueuedIds.has(id) ||
        this.incrementalQueuedIds.has(id) ||
        this.deadLetteredIds.has(id),
      feedIntoBackfillQueue: (ids) =>
        feedIdsIntoBackfillQueue(this.backfillQueueFeedState(), ids),
      onDurableWorkQueued: () => {
        this.deadLetterRevisitedThisIdleCycle = false;
      },
      // ISS-7096: durably park the withheld rows — the maintenance's active-key
      // sweep re-reads ownership from `sessions` itself, so this cannot drift
      // from the in-memory gate's predicate. Fire-and-forget; it never throws.
      parkForeignOutboxRows: () => {
        const source = this.options.getSource?.() ?? null;
        if (source && this.hydratedSourceKey) {
          void adoptStrandedOutboxRows(
            source,
            this.hydratedSourceKey,
            this.options
          );
        }
      },
      // ISS-7246: the idle withhold's durable half. Fire-and-forget like the
      // parking above: a failed write leaves the rows `pending`, which is the
      // pre-ISS-7246 behavior (re-queued and re-withheld on a later pass) —
      // wasted work, never lost data.
      markOutboxWithheld: (ids) => this.outbox.markWithheld(ids),
      isCurrentSourceState: this.currentPassGuard,
      readSourceKey: () => this.hydratedSourceKey,
    };
  }

  private dequeue(syncMode: AgentSessionSyncMode, ids: string[]): void {
    const incremental = syncMode === AgentSessionSyncMode.Incremental;
    const remaining = dequeueOwedIds(
      incremental ? this.incrementalQueue : this.backfillQueue,
      incremental ? this.incrementalQueuedIds : this.backfillQueuedIds,
      this.queuedUpdatedAtById,
      ids
    );
    if (incremental) {
      this.incrementalQueue = remaining;
      return;
    }
    this.backfillQueue = remaining;
  }
}
