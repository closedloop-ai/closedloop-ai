import { randomUUID } from "node:crypto";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import {
  AgentSessionSyncMode,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import { isDbHostShutdownError } from "../../shared/db-host-shutdown-error.js";
import type { DesktopAgentSessionsAck } from "../cloud/cloud-protocol.js";
import { DesktopAgentSessionsAckReason } from "../cloud/cloud-protocol.js";
import { errorMessage } from "../diagnostics/component-sync-diagnostics.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { DesktopSyncBatchOutcome } from "../telemetry/app-otel-runtime.js";
import type { SessionAttributionResolverCache } from "./agent-session-attribution.js";
import {
  advanceIncrementalPassCount,
  selectDrainCandidates,
} from "./agent-session-drain-selection.js";
import { resolveEmptyHydration } from "./agent-session-hydration-absence.js";
import { hydrateSyncCandidates } from "./agent-session-hydration-budget.js";
import {
  clearOutboxOnAck as clearOutboxOnAckWrite,
  recordOutboxDeadLetter as recordOutboxDeadLetterWrite,
  recordOutboxEnqueue as recordOutboxEnqueueWrite,
  recordOutboxReEnqueue as recordOutboxReEnqueueWrite,
  recordOutboxRetry as recordOutboxRetryWrite,
} from "./agent-session-outbox-writers.js";
import {
  handlePreparationFailures,
  prepareCandidatePayloadsIsolated,
  selectHydratableCandidateIds,
} from "./agent-session-payload-preparation.js";
import type { SessionCursorRow } from "./agent-session-read-model.js";
import { processAcceptedAck } from "./agent-session-sync-accepted-ack.js";
import {
  applyBoundedFailureFold,
  type BoundedFailureFoldConfig,
} from "./agent-session-sync-ack-fold.js";
import {
  INGESTION_FAILED_BACKOFF_MS,
  MAX_CONSECUTIVE_INGESTION_FAILED,
  MAX_CONSECUTIVE_RATE_LIMITED,
  MAX_CONSECUTIVE_TIMEOUTS,
  MAX_CONSECUTIVE_TRANSPORT_ERRORS,
  RATE_LIMIT_BACKOFF_MS,
  SESSION_PAYLOAD_BYTE_CAP,
  SESSION_PAYLOAD_CONTENT_BYTE_CAP,
  TARGET_NOT_OWNED_BACKOFF_MS,
  UNAUTHENTICATED_BACKOFF_MS,
  UNCONFIRMED_ABSENCE_BACKOFF_MS,
} from "./agent-session-sync-backoff-policy.js";
import { SessionSyncCapability } from "./agent-session-sync-capabilities.js";
import { AgentComponentSyncLane } from "./agent-session-sync-component-lane.js";
import { syncPayloadSizerFor } from "./agent-session-sync-compression.js";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  type AgentSessionSyncBatch,
  AgentSessionSyncClass,
  type SyncedAgentSession,
} from "./agent-session-sync-contract.js";
import {
  type DeadLetterLifecycleDeps,
  enforceDeadLetterCap,
  markDeadLettered,
  promoteDeadLetterIfIdle,
  recoverExpiredDeadLetters,
  resetDeadLetterRevisitAfterDrainedAck,
} from "./agent-session-sync-dead-letter-lifecycle.js";
import {
  deadLetterOversizedLocalSession,
  dropIdleCandidates,
  reconcilePendingOutboxIfIdle,
  type SessionDispositionDeps,
} from "./agent-session-sync-dispositions.js";
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
  prepareAgentSessionPayload,
} from "./agent-session-sync-payload.js";
import {
  accumulatePreparedPayloads,
  type PendingChunks,
  resolvePendingChunkTransition,
} from "./agent-session-sync-pending-chunks.js";
import {
  capPersistedTopIds,
  collectIdsAtTimestamp,
  formatBytes,
  isLocalSerializationError,
} from "./agent-session-sync-service-helpers.js";
import type {
  AgentSessionSyncProgress,
  AgentSessionSyncServiceOptions,
  AgentSessionSyncStartOptions,
} from "./agent-session-sync-service-options.js";
import type {
  AgentSessionOutboxEntry,
  AgentSessionSyncSource,
  OutboxRetryState,
  PersistedSyncState,
} from "./agent-session-sync-source.js";
import {
  logActivityChunkingDowngradeDeferral,
  logCompressionDowngradeDeferral,
  logSyncTickFailure,
} from "./agent-session-sync-tick-failure-log.js";
import { applyTransportErrorFold } from "./agent-session-sync-transport-error-fold.js";
import { TransportTimeoutBudget } from "./agent-session-sync-transport-timeout-budget.js";
import {
  applyValidationFailure,
  isMultiPartSyncEnvelope,
  isValidationFailureReason,
} from "./agent-session-sync-validation-failure.js";
import {
  type BackfillQueueFeedContext,
  type BackfillQueueFeedState,
  feedIdsIntoBackfillQueue,
  injectIdsIntoLiveQueue,
} from "./backfill-queue-feed.js";
import { feedIncrementalCursorRows } from "./incremental-cursor-feed.js";
import { SyncPollTimers } from "./sync-poll-timers.js";
import { syncedSessionIsSubstantive } from "./synced-session-substantive.js";

const TAG = "agent-session-sync";
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
   * FEA-2733: whether the initial cursor enumeration has run for the current
   * identity. Distinguishes "not yet started the first-connect walk" (queues
   * transiently empty before the first tick, or an empty local store) from
   * "fully caught up" in `getSyncProgress()`. Reset on identity change.
   */
  private initialBackfillPassRun = false;
  /**
   * FEA-1962: the source key the in-memory cursor was last hydrated for. `null`
   * means "not yet hydrated" (or hydrated for an unknown identity). When the
   * computed source key differs from this, the next sync clears cursor/queue
   * state and re-hydrates from the new key's persisted row.
   */
  private hydratedSourceKey: string | null = null;
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
  private readonly attributionCache: SessionAttributionResolverCache = {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
  /** Consecutive timeout count per session ID for dead-letter detection. */
  private readonly timeoutCountById = new Map<string, number>();
  /**
   * FEA-1461: consecutive `rate_limited` count per session ID. Parallel to
   * `timeoutCountById` — kept separate so the existing timeout dead-letter
   * threshold and the new rate-limit threshold do not contaminate each other.
   */
  private readonly rateLimitedCountById = new Map<string, number>();
  /** Consecutive `ingestion_failed` count per session ID. */
  private readonly ingestionFailedCountById = new Map<string, number>();
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
   * FEA-3364: consecutive THROWN-transport-error count per session ID. A thrown
   * `sendBatch` (dropped socket / serialization failure) never produced an ack,
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
  /**
   * Session IDs removed from the queue after exceeding a retry threshold, mapped
   * to their retry-after deadline (ms since epoch). FEA-3363: the deadline lets
   * `recoverExpiredDeadLetters` re-enqueue an id once its window elapses so a
   * dead-letter is a deferral, not a permanent strand. `.size` still reflects the
   * live dead-letter count for `getSyncProgress`, the persist block, and logs.
   */
  private readonly deadLetteredIds = new Map<string, number>();
  /**
   * FEA-3795 (PRD-536 E2): consecutive dead-letter count per session ID, driving
   * the PROGRESSIVE retry backoff (`deadLetterRetryDelayMs`). Incremented each
   * time an id is dead-lettered (recoverable class), so the first dead-letter
   * gets the short base window and each subsequent re-dead-letter of the same id
   * doubles it toward the 24h cap. Unlike the per-class retry counters, this is
   * DELIBERATELY NOT cleared by `clearFailureStateForId` (the recovery path):
   * clearing it would reset a persistently-failing id back to the short window on
   * every recovery, defeating the escalation. It is cleared only on a verified
   * server ack (genuine forward progress). Scoped to a running process: a cold
   * restart re-derives it from zero (the durable recovery machinery — FEA-3697 —
   * still re-drives every dead-letter to the cloud; the escalation just restarts
   * at the base, which is harmless and avoids a schema change).
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
   * cleared only by a verified ack, evicted by `enforceDeadLetterCap`. The same
   * cold-restart KNOWN GAP applies, with the same guarantee: each process spends
   * one capped allowance, then the class goes terminal.
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

  constructor(options: AgentSessionSyncServiceOptions) {
    this.options = options;
    this.componentLane = new AgentComponentSyncLane(options, {
      getSourceStateGeneration: () => this.sourceStateGeneration,
      isStarted: () => this.started,
    });
    this.preparePayloads =
      options.preparePayloads ??
      ((sessions, maxBytes, compress, activityChunkingSupported) => {
        const sizer = syncPayloadSizerFor(compress === true);
        return Promise.resolve(
          sessions.map((session) =>
            prepareAgentSessionPayload(
              session,
              maxBytes,
              sizer,
              undefined,
              activityChunkingSupported === true
            )
          )
        );
      });
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

  /**
   * FEA-2733: content-blind snapshot of local→cloud sync progress for the
   * renderer "syncing your history" indicator. Reads in-memory queue state only
   * (no DB access, no ids) so it is cheap to poll on the runtime-status cadence.
   * `caughtUp` is gated on `initialBackfillPassRun` so it never reports "up to
   * date" before the first-connect walk has enumerated local history.
   */
  getSyncProgress(): AgentSessionSyncProgress {
    const pendingBackfillSessions = this.backfillQueue.length;
    const pendingIncrementalSessions = this.incrementalQueue.length;
    const hasPendingParts = this.pendingChunks !== null;
    const sourceKey = SessionSyncCapability.sourceKey(this.options);
    const identified = sourceKey !== null;
    // FEA-2733: the in-memory queue/flag state belongs to `hydratedSourceKey`.
    // Between a compute-target (account) switch and the next sync tick that
    // re-hydrates, the current source key differs from the hydrated one, so the
    // drained queues actually describe the PRIOR identity. Gate `caughtUp` on
    // the keys matching so a freshly-switched target never inherits the old
    // account's "up to date" before its own walk has run.
    const sourceMatchesHydrated =
      identified && sourceKey === this.hydratedSourceKey;
    const queuesDrained =
      pendingBackfillSessions === 0 &&
      pendingIncrementalSessions === 0 &&
      !hasPendingParts;
    return {
      identified,
      pendingBackfillSessions,
      pendingIncrementalSessions,
      backfilling: pendingBackfillSessions > 0,
      caughtUp:
        sourceMatchesHydrated && this.initialBackfillPassRun && queuesDrained,
      deadLetteredSessions: this.deadLetteredIds.size,
      deadLetteredComponents: this.componentLane.deadLetteredCount,
    };
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
    this.attributionCache.attributionByCwd.clear();
    this.attributionCache.launchMetadataRootByCwd.clear();
    this.attributionCache.repoFullNameByPath.clear();
    this.timeoutCountById.clear();
    this.rateLimitedCountById.clear();
    this.ingestionFailedCountById.clear();
    this.validationFailedCountById.clear();
    // Goal stage 2: drop the ack-omitted budget with the other per-row counters.
    this.ackOmittedCountById.clear();
    // FEA-4375: drop pending validation-bisection flags on identity change/stop.
    this.validationBisectIds.clear();
    this.transportErrorCountById.clear();
    // ISS-5088: drop the client-abort budget on identity change / hard reset too.
    this.transportTimeoutBudget.clearAll();
    this.nextRetryAfterMs.clear();
    this.deadLetteredIds.clear();
    // FEA-3795: drop the progressive-backoff escalation counters too.
    this.deadLetterCountById.clear();
    this.chunkValidationCycleById.clear();
    this.ackOmittedCycleById.clear();
    this.deadLetterRevisitedThisIdleCycle = false;
    this.pendingChunks = null;
    this.timers.clearDrain();
    // T-8.7 / ISS-4542: reset the component lane's keyset cursor and drop its
    // dead-letter tracker so the next tick re-hydrates from the persisted
    // position and no prior account's dead-lettered ids leak into the next
    // identity's lane.
    this.componentLane.clearCursorState();
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
    if (!this.shouldRun()) {
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
    if (!(this.started && this.shouldRun())) {
      // Not startable right now (stopped, consent off, transport down). The
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
        this.recordOutboxReEnqueue(id);
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
      this.pickReadyCandidates(this.backfillQueue, 1, nowMs).length > 0 ||
      this.pickReadyCandidates(this.incrementalQueue, 1, nowMs).length > 0;
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
   * flush count (FEA-2399 determinism / shafty023 review). It never throws (the
   * lane's awaits are all try/caught internally). The mechanics live on the lane
   * (ISS-4676); this stays the public name callers and tests use.
   */
  whenComponentSyncSettled(): Promise<void> {
    return this.componentLane.whenSettled();
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
   * FEA-4375: the SESSION-ONLY sync pass — the session backfill/incremental lane
   * WITHOUT the component inventory lane. The immediate self-continue drain and
   * the chunk-drain continuation drive THIS (not `syncOnce`) so a large backfill
   * advances the session queue back-to-back without re-entering the component
   * lane per batch; the component lane keeps its own 5s `setInterval` tick so a fast
   * component-lane failure retries on that cadence, not once per session batch
   * (wongk review). `syncOnce` above is the only caller that also runs components.
   */
  private syncSessionsOnce(): Promise<void> {
    // The gate is evaluated here, exactly once per tick, and a bounced tick still
    // resolves immediately — the historical semantics. Only a tick that actually
    // STARTS a pass publishes `sessionSyncPromise`, so the settled signal below
    // can never be clobbered by a bounced tick's already-resolved promise.
    if (this.syncing || !this.shouldRun()) {
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
    const isCurrentSourceState = () =>
      this.activeSyncToken === syncToken &&
      this.sourceStateGeneration === sourceStateGeneration &&
      this.started &&
      this.shouldRun();
    this.currentPassGuard = isCurrentSourceState;

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
      // ISS-4541: is THIS tick draining a chunk off an already-open pending tail
      // (vs. shipping chunk 0 of a fresh sequence)? A thrown transport error on a
      // mid-sequence chunk must discard the whole remaining tail rather than let
      // later chunks drain and dequeue the session with the thrown chunk missing
      // (shafty023 P1) — the shifted chunk is already gone from the tail, so the
      // only safe recovery is to re-prepare the session from chunk 0 next tick,
      // exactly as the capability-downgrade discard path already does.
      let drainingPendingChunkTail = false;
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
      const monitoredActivitySupported = syncCapabilities.monitoredActivity;

      const pendingTransition = resolvePendingChunkTransition(
        this.pendingChunks,
        syncCapabilities.compression,
        activityChunkingSupported,
        monitoredActivitySupported
      );
      if (pendingTransition.kind === "discard-downgrade") {
        // FEA-4152 / ISS-4541: the pinned chunks can't ship — the server no
        // longer negotiates decompression, OR no longer merges multi-part
        // tilings additively (shipping an activity-chunked tail to an old
        // REPLACE-ALL server would store a partial tiling). Drop the tail and
        // skip the send; the session stays queued and re-prepares (identity
        // encoding / tiling-in-base) on the next tick.
        gatewayLog.info(
          TAG,
          `discarding ${pendingTransition.chunkCount} sized chunk(s) for session ${pendingTransition.sessionId} after a sync capability downgrade (compression/activity-chunking); ` +
            "re-preparing under the current capabilities on the next tick"
        );
        this.pendingChunks = null;
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
        sendCompress = pendingTransition.compress;
        batch = pendingTransition.batch;
        accumulatedBytes = pendingTransition.accumulatedBytes;
        syncMode = pendingTransition.syncMode;
        syncIds = [pendingTransition.sessionId];
        gatewayLog.info(
          TAG,
          `sending chunked session ${pendingTransition.sessionId} (~${formatBytes(accumulatedBytes)}); ` +
            `${pendingTransition.remainingChunks} chunk(s) remaining`
        );
        // Skip DB access — go straight to send.
      } else {
        const source = injectedSource;
        try {
          // FEA-1962: hydrate the persisted cursor BEFORE deciding backfill vs
          // incremental. A hydrated watermark makes initializeBackfillQueueIfNeeded
          // short-circuit (no full re-upload); a fresh/absent row leaves it null
          // → full backfill as today.
          await this.hydratePersistedCursorIfNeeded(source);
          await this.initializeBackfillQueueIfNeeded(source);
          await this.enqueueIncrementalUpdates(source);

          const nowMs = Date.now();
          // FEA-3363: give any dead-lettered session whose retry-after window has
          // elapsed a fresh path back onto the backfill queue before selecting
          // this tick's candidates, so it can eventually reach the cloud without
          // requiring an app restart.
          this.recoverExpiredDeadLetters(nowMs);
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
          this.promoteDeadLetterIfIdle();
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
              this.pickReadyCandidates(queue, limit, at),
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
          const candidateIds = selection.candidateIds;

          const hydratableCandidateIds =
            await this.selectHydratableCandidateIds(
              source,
              syncMode,
              candidateIds,
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

          // FEA-3287: withhold "phantom" sessions from cloud sync AT THE SOURCE.
          // The desktop live-hook INSERTs a `sessions` row on `SessionStart`
          // (and bumps `updated_at`) before any real turn/token/tool-use, so an
          // idle row lands in the incremental cursor and would sync as a 0-turn /
          // 0-token / abandoned phantom. Split the hydrated batch into
          // substantive (uploaded) and idle (deferred) using the FEA-3284 SSOT
          // predicate applied identically to the read path. Idle rows are
          // DEQUEUED WITHOUT dead-lettering (unlike unhydratable/oversized rows),
          // so the cursor advances past them this pass but they are NOT
          // permanently skipped: the instant a real event arrives the live hook
          // bumps `sessions.updated_at`, re-selecting the now-substantive session
          // via `enqueueIncrementalUpdates` on the next pass. No real session is
          // lost, and the local live-Kanban still shows the row as "Waiting on
          // start" (that read never routes through this sync boundary).
          const idleCandidateIds: string[] = [];
          candidateSessions = candidateSessions.filter((session) => {
            if (syncedSessionIsSubstantive(session)) {
              return true;
            }
            // The sync queues + cursor key sessions by `externalSessionId` (the
            // desktop stores the external id AS the local `sessions.id` primary
            // key, and `preparePayloads` dequeues by `sanitized.externalSessionId`
            // after a send), so dequeue the idle rows by that same key.
            idleCandidateIds.push(session.externalSessionId);
            return false;
          });
          if (idleCandidateIds.length > 0) {
            dropIdleCandidates(
              { syncMode, ids: idleCandidateIds },
              this.dispositionDeps()
            );
          }
          if (candidateSessions.length === 0) {
            // Every hydrated candidate this pass was idle — nothing to upload.
            // dropIdleCandidates already dequeued them and persisted the cursor
            // if both queues drained, so just return (mirrors the unhydratable
            // all-dropped path above).
            return;
          }

          const sessions: SyncedAgentSession[] = [];
          syncIds = [];
          const batchId = randomUUID();
          const selectedSyncMode = syncMode;
          const buildBatch = (
            batchSessions: SyncedAgentSession[]
          ): AgentSessionSyncBatch => ({
            schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
            batchId,
            syncMode: selectedSyncMode,
            sessionCount: batchSessions.length,
            sessions: batchSessions,
            ...(sendCompress ? { encoding: SyncPayloadEncoding.Gzip } : {}),
            // Goal stage 2: request the per-session ack echo (additive in both
            // skew directions — an old server strips it and answers whole-batch).
            wantsAcceptedSessionIds: true,
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
              activityChunkingSupported
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
          const acc = {
            sessions,
            syncIds,
            accumulatedBytes,
            pendingChunks: this.pendingChunks,
          };
          accumulatePreparedPayloads(acc, preparedPayloads, {
            syncMode: selectedSyncMode,
            sendCompress,
            activityChunked: activityChunkingSupported,
            monitoredActivityIncluded: monitoredActivitySupported,
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
          if (!batch) {
            batch = buildBatch(sessions);
          }
        } finally {
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

      // FEA-4152: a FRESH batch captured `sendCompress` at the top of the tick,
      // then awaited hydration + worker prep. If the server reconnected without
      // gzip during those awaits, the batch was built + sized under the gzip cap
      // and stamps `Content-Encoding: gzip`, but posting it now would 400
      // (`Invalid compressed body`) on a server that no longer decompresses.
      // Re-read the capability and skip the send: the candidates were never
      // dequeued (only an ack advances them), so the next tick re-prepares them
      // under identity. A pending-chunk drain is exempt — its encoding was
      // re-checked in `resolvePendingChunkTransition` and pinned intentionally.
      if (
        pendingTransition.kind !== "send" &&
        sendCompress &&
        !SessionSyncCapability.capture(this.options).compression
      ) {
        logCompressionDowngradeDeferral(TAG, syncIds.length);
        return;
      }
      // ISS-4578 (shafty023 P1): mirror the gzip freshness guard for ACTIVITY
      // CHUNKING. A FRESH batch captured `activityChunkingSupported` at the top of
      // the tick, then awaited hydration + worker prep. If the socket reconnected
      // to an OLDER server (one that REPLACE-ALLs the tiling on every chunk and
      // never negotiated additive merge) during those awaits, sending chunk 0 of a
      // split tiling would leave that server holding a PARTIAL tiling — the exact
      // silent loss this ticket fixes. Re-read the capability and skip the send:
      // the candidates were never dequeued (only an ack advances them), so the
      // next tick re-prepares them with the tiling whole in the base (fits or
      // dead-letters, never partial). A pending-chunk drain is exempt — its tail
      // was already re-checked in `resolvePendingChunkTransition`.
      if (
        pendingTransition.kind !== "send" &&
        activityChunkingSupported &&
        !SessionSyncCapability.capture(this.options).activityChunking
      ) {
        logActivityChunkingDowngradeDeferral(TAG, syncIds.length);
        return;
      }
      if (
        pendingTransition.kind !== "send" &&
        monitoredActivitySupported !==
          (this.options.isSyncMonitoredActivitySupported?.() ?? false)
      ) {
        return;
      }

      const sendStartedMs = Date.now();
      // Goal stage 3: a batch reached the wire — productive work whatever the
      // ack says (trace outcome only; ack handling is unchanged).
      pass.noteOutcome(SyncPassOutcome.Sent);
      let ack: DesktopAgentSessionsAck;
      try {
        ack = await this.options.sendBatch(batch, { compress: sendCompress });
      } catch (sendError) {
        // A thrown transport error (socket drop, serialization failure) is
        // itself a batch failure. FEA-3364: unlike an ack rejection it used to
        // increment no counter, so the batch stayed queued at retry-count 0 and
        // re-sent every 5s forever (a persistent transport/serialization fault =
        // infinite retry, never dead-lettered). Bound it here: a local
        // serialization bug dead-letters immediately, a transient socket throw
        // after MAX_CONSECUTIVE_TRANSPORT_ERRORS. Emit the batch outcome so the
        // dashboard counts it (dead_letter when the throw stranded a session,
        // else failure) instead of silently undercounting — the outer catch only
        // logs. Rethrow so the existing "sync failed" log and finally-block
        // cleanup still run.
        const deadLettered = this.handleTransportError(
          syncMode,
          syncIds,
          accumulatedBytes,
          sendError
        );
        this.options.onSyncBatchTelemetry?.({
          outcome: deadLettered
            ? DesktopSyncBatchOutcome.DeadLetter
            : DesktopSyncBatchOutcome.Failure,
          payloadBytes: accumulatedBytes,
          latencyMs: Math.max(0, Date.now() - sendStartedMs),
          reason: SyncReason.TransportError,
        });
        if (drainingPendingChunkTail) {
          // ISS-4541 (shafty023 P1): this throw stranded a chunk that
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
      if (
        this.activeSyncToken !== syncToken ||
        this.sourceStateGeneration !== sourceStateGeneration ||
        !this.started
      ) {
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
        isMultiPartSyncEnvelope(batch)
      );
    } catch (error) {
      // ISS-5262: a graceful db-host teardown is abandonment, not failure — the
      // trace must keep the same distinction as the failure log below, or a
      // normal quit would print an INFO `outcome=failed` right after a clean
      // shutdown verdict (the exact lie ISS-5262 removed).
      pass.noteOutcome(
        isDbHostShutdownError(error)
          ? SyncPassOutcome.Abandoned
          : SyncPassOutcome.Failed
      );
      logSyncTickFailure(TAG, error);
    } finally {
      if (this.activeSyncToken === syncToken) {
        this.activeSyncToken = null;
        this.syncing = false;
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

  private async initializeBackfillQueueIfNeeded(
    source: AgentSessionSyncSource
  ): Promise<void> {
    if (this.observedTopUpdatedAt !== null) {
      // FEA-2733: a cursor is already established for this identity — either a
      // prior tick's walk (which set the flag below) or a persisted cursor that
      // `hydratePersistedCursorIfNeeded` just resumed on an already-synced
      // restart (it sets `observedTopUpdatedAt` and skips this walk). Mark the
      // initial pass complete so a resumed session settles to "up to date"
      // instead of latching on "checking" forever.
      this.initialBackfillPassRun = true;
      return;
    }

    const rows = await this.listInitialCursorRows(source);
    // FEA-2733: the initial enumeration has now run for this identity — even on
    // an empty store (no rows) — so `getSyncProgress()` can report "caught up"
    // rather than latching on a pre-walk "checking" state.
    this.initialBackfillPassRun = true;
    if (rows.length === 0) {
      return;
    }

    this.observedTopUpdatedAt = rows[0].updated_at;
    this.observedIdsAtTopUpdatedAt = collectIdsAtTimestamp(
      rows,
      this.observedTopUpdatedAt
    );
    if (!this.historicalBackfillEnabled) {
      gatewayLog.info(
        TAG,
        `deferred historical backfill; initialized incremental cursor at ${this.observedTopUpdatedAt} with ${this.observedIdsAtTopUpdatedAt.size} top session(s)`
      );
      return;
    }

    const newlyQueued: string[] = [];
    for (const row of rows) {
      if (this.backfillQueuedIds.has(row.id)) {
        continue;
      }
      this.backfillQueuedIds.add(row.id);
      this.backfillQueue.push(row.id);
      newlyQueued.push(row.id);
    }
    // FEA-3473: durably seed the outbox for the initial full-corpus backfill
    // walk, then persist the cursor so a cold restart resumes from the pending
    // outbox (loadPendingOutboxIds) instead of re-walking the whole corpus and
    // resurrecting already-synced sessions. AWAIT the seed (not fire-and-forget)
    // so the cursor is persisted ONLY AFTER the outbox is a complete ledger of
    // remaining work — a crash mid-seed leaves the cursor unpersisted and the
    // safe full re-walk runs next start (anti-stranding invariant, see
    // persistInitialBackfillCursor).
    const sourceKey =
      this.hydratedSourceKey ?? SessionSyncCapability.sourceKey(this.options);
    let seeded = false;
    if (sourceKey && newlyQueued.length > 0) {
      seeded = await this.seedBackfillOutboxDurably(sourceKey, newlyQueued);
    }
    // Genuinely-new backfill work preempts dead-letter retries: reset the
    // idle-cycle revisit guard so the whole backfill drains before any
    // dead-letter is revisited.
    this.deadLetterRevisitedThisIdleCycle = false;

    gatewayLog.info(
      TAG,
      `queued historical backfill for ${rows.length} agent sessions`
    );

    if (sourceKey && seeded) {
      await this.persistInitialBackfillCursor(sourceKey);
    }
  }

  private async listInitialCursorRows(
    source: AgentSessionSyncSource
  ): Promise<SessionCursorRow[]> {
    if (this.historicalBackfillEnabled || !source.listTopSessionCursorRows) {
      return await source.listAllSessionCursorRows();
    }
    return await source.listTopSessionCursorRows();
  }

  private async enqueueIncrementalUpdates(
    source: AgentSessionSyncSource
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
    // LOWER-sorting id (a historical-import row stamped `updated_at = endedAt`,
    // or two same-millisecond writes) — the previous `id > maxId` boundary
    // silently skipped such a row forever (data loss), since it is neither
    // `> maxId` nor at a strictly-greater timestamp. Already-seen ids stay
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
    this.recordOutboxEnqueue(newlyQueued, AgentSessionSyncClass.Incremental);

    this.observedTopUpdatedAt = nextTopUpdatedAt;
    this.observedIdsAtTopUpdatedAt = nextTopIds;
  }

  /**
   * FEA-1962: load the persisted cursor for the current principal/target the
   * first time we sync for it (and re-load after an identity change). A present
   * watermark resumes incremental sync from the last uploaded position; an
   * absent one leaves the cursor null so `initializeBackfillQueueIfNeeded`
   * performs a full backfill exactly as before. Runs at most once per identity
   * (guarded by `hydratedSourceKey`) so it never re-queries mid-stream.
   */
  private async hydratePersistedCursorIfNeeded(
    source: AgentSessionSyncSource
  ): Promise<void> {
    const sourceKey = SessionSyncCapability.sourceKey(this.options);
    if (sourceKey === this.hydratedSourceKey) {
      return;
    }
    // Identity changed (account / compute-target switch) or first hydration:
    // drop cursor/queue state derived from a different principal so we never
    // upload the new account's sessions against the old account's watermark.
    if (this.hydratedSourceKey !== null) {
      this.clearSourceDerivedState();
    }
    if (!(sourceKey && source.loadSyncState)) {
      // No identity yet, or a source without persistence → in-memory only,
      // which means today's full-backfill-on-restart behavior. Nothing async
      // can fail here, so mark the identity hydrated immediately.
      this.hydratedSourceKey = sourceKey;
      return;
    }
    // Mark the identity hydrated only AFTER a successful load. If loadSyncState
    // throws (e.g. the sync_state table is transiently unavailable), leaving
    // hydratedSourceKey unchanged lets the next sync tick retry the load instead
    // of the early-return guard permanently wedging the session on a full
    // backfill and ignoring the persisted watermark until restart.
    const persisted = await source.loadSyncState(sourceKey);
    this.hydratedSourceKey = sourceKey;
    if (persisted?.observedTopUpdatedAt) {
      this.observedTopUpdatedAt = persisted.observedTopUpdatedAt;
      this.observedIdsAtTopUpdatedAt = new Set(
        persisted.observedIdsAtTopUpdatedAt
      );
      // Seed the recorded dead-letters SET ASIDE — do NOT push them onto the
      // backfill queue. They are revisited last (only once both queues are drained,
      // via promoteDeadLetterIfIdle), so a resumed session settles to the persisted
      // watermark without re-walking the whole corpus and without eagerly retrying
      // the abandoned rows. INFINITE deadline keeps recoverExpiredDeadLetters from
      // re-enqueueing them ahead of live work; the idle-cycle revisit is their path
      // back. Absent/legacy cursors carry `deadLetteredIds: []`.
      const deadLetteredIds = persisted.deadLetteredIds ?? [];
      for (const id of deadLetteredIds) {
        if (!this.deadLetteredIds.has(id)) {
          this.deadLetteredIds.set(id, Number.POSITIVE_INFINITY);
        }
      }
      // Bound the seeded set (a legacy cursor persisted before the cap could
      // carry more than MAX_DEAD_LETTERED_IDS); the next persist rewrites it
      // capped.
      this.enforceDeadLetterCap();
      const deadLetterSuffix =
        deadLetteredIds.length > 0
          ? ` and set ${deadLetteredIds.length} dead-lettered session(s) aside for later`
          : "";
      gatewayLog.info(
        TAG,
        `resumed agent-session sync from persisted cursor (${persisted.observedIdsAtTopUpdatedAt.length} id(s) at top) — skipping full backfill${deadLetterSuffix}`
      );
    }

    // FEA-3473 (AC-1): re-enqueue the sessions that were enqueued but not acked
    // before a kill/restart. Their durable `pending` outbox rows survived the
    // crash; an acked session's row was cleared on ack, so this re-uploads ONLY
    // the un-acked prefix (bounded by the outbox size), NOT the whole corpus.
    // Runs even when no cursor was persisted (a kill mid-first-backfill leaves a
    // populated outbox but no cursor yet). Skipped for legacy/fake sources
    // without the delegate. A pending id already set aside as a resumed
    // dead-letter is left alone (the dead-letter revisit is its path back).
    if (sourceKey && source.loadPendingOutboxIds) {
      let pendingIds: string[] = [];
      try {
        pendingIds = await source.loadPendingOutboxIds(sourceKey);
      } catch (error) {
        gatewayLog.warn(
          TAG,
          `failed to load pending outbox on resume: ${errorMessage(error)}`
        );
      }
      // ISS-4546 (PR #4098 review, wongk): route the hydration re-enqueue through
      // the SAME `feedIdsIntoBackfillQueue` helper the live `injectBackfillIds`
      // path uses, so the dedup discipline (skip an id already tracked on the
      // backfill/incremental queues or set aside as a dead-letter) cannot drift
      // between the restart-hydration path and the live-inject path.
      const requeued = feedIdsIntoBackfillQueue(
        this.backfillQueueFeedState(),
        pendingIds
      );
      if (requeued > 0) {
        // New durable work to drain preempts dead-letter revisits.
        this.deadLetterRevisitedThisIdleCycle = false;
        // FEA-3473 (AC-1): the outbox re-enqueue above recovers only the un-acked
        // prefix — the ids that were enqueued but not yet acked. It is NOT proof
        // that every earlier row is either acked or represented in the outbox.
        // When a cursor WAS persisted, `observedTopUpdatedAt` is already set (by
        // hydratePersistedCursorIfNeeded) and the drain-gated persist guarantees
        // everything up to that watermark was acked, so the corpus re-walk stays
        // correctly skipped. When NO cursor was persisted (a kill mid-first-
        // backfill), we deliberately leave `observedTopUpdatedAt === null` so
        // `initializeBackfillQueueIfNeeded` still runs its full enumeration. Do
        // NOT seed the watermark from the current top here: a partially-written
        // outbox can be missing sessions that were never enqueued, and those rows
        // also fall below the incremental `updated_at >= watermark` scan, so a
        // seed would drop them permanently. The full walk re-queues the whole
        // corpus (dedup-safe against the ids already queued above; the server
        // dedupes any already-acked rows per recordOutboxEnqueue), guaranteeing no
        // locally-captured session is stranded.
        gatewayLog.info(
          TAG,
          `re-enqueued ${requeued} un-acked agent session(s) from the durable outbox on resume`
        );
      }
    }

    // FEA-3659: rehydrate the in-memory retry budget + deferred-retry deadline
    // from the durable outbox. Re-enqueuing the pending ids above is not enough:
    // the per-session counters (`ingestionFailedCountById`, …) and
    // `nextRetryAfterMs` start empty on a fresh process, so without this a row
    // that was mid-backoff (e.g. `attempt_count=4`) would be retried IMMEDIATELY
    // and its next rejection would recompute `(0 + 1) = 1`, overwriting the
    // persisted budget back to 1 and letting an outage that spans restarts dodge
    // the intended dead-letter cap. Seeding the counters preserves the budget and
    // seeding `nextRetryAfterMs` re-arms the backoff so `pickReadyCandidates`
    // keeps deferring the row until its persisted `next_attempt_at` elapses.
    if (sourceKey && source.loadPendingOutboxRetryState) {
      let retryRows: OutboxRetryState[] = [];
      try {
        retryRows = await source.loadPendingOutboxRetryState(sourceKey);
      } catch (error) {
        gatewayLog.warn(
          TAG,
          `failed to load pending outbox retry state on resume: ${errorMessage(error)}`
        );
      }
      let seeded = 0;
      for (const row of retryRows) {
        // A row set aside as a resumed dead-letter is revisited via its own
        // deadline path; don't also seed a live retry budget for it.
        if (row.attemptCount <= 0 || this.deadLetteredIds.has(row.id)) {
          continue;
        }
        const counter = this.retryCounterMapForReason(row.lastError);
        if (counter) {
          counter.set(row.id, row.attemptCount);
        }
        const deadlineMs = row.nextAttemptAt
          ? Date.parse(row.nextAttemptAt)
          : Number.NaN;
        if (Number.isFinite(deadlineMs)) {
          this.nextRetryAfterMs.set(row.id, deadlineMs);
        }
        seeded += 1;
      }
      if (seeded > 0) {
        gatewayLog.info(
          TAG,
          `rehydrated retry budget/backoff for ${seeded} agent session(s) from the durable outbox on resume`
        );
      }
    }
  }

  /**
   * FEA-3659: map a persisted outbox `last_error` reason to the in-memory
   * consecutive-failure counter it belongs to, so resume seeds the SAME budget
   * the original failure was accruing. Only the transient classes that defer with
   * backoff have a counter; an unrecognized/absent reason returns null (the
   * `next_attempt_at` deadline is still re-armed class-agnostically by the
   * caller). Today only `ingestion_failed` persists a retry, but routing by
   * reason keeps this correct if the other transient classes start persisting.
   */
  private retryCounterMapForReason(
    reason: string | null
  ): Map<string, number> | null {
    switch (reason) {
      case "ingestion_failed":
        return this.ingestionFailedCountById;
      case "rate_limited":
        return this.rateLimitedCountById;
      case SyncReason.AckOmitted:
        // Goal stage 2: recorded durably on defer, so resume re-seeds it too.
        return this.ackOmittedCountById;
      default:
        // ISS-5090: every validation-rejection reason (row-attributable,
        // envelope-attributable, envelope-exhausted) shares ONE budget, so all
        // three seed the same counter.
        return isValidationFailureReason(reason)
          ? this.validationFailedCountById
          : null;
    }
  }

  /**
   * The resolved durable-outbox write target (identity + source) the outbox-writer
   * helpers need. Resolves the source key with the same
   * `hydratedSourceKey ?? resolveSyncSourceKey()` precedence every writer used.
   */
  private outboxWriteTarget(): {
    sourceKey: string | null;
    source: AgentSessionSyncSource | null;
  } {
    return {
      sourceKey:
        this.hydratedSourceKey ?? SessionSyncCapability.sourceKey(this.options),
      source: this.options.getSource?.() ?? null,
    };
  }

  private recordOutboxEnqueue(
    ids: string[],
    syncClass: AgentSessionSyncClass
  ): void {
    recordOutboxEnqueueWrite(this.outboxWriteTarget(), ids, syncClass);
  }

  /** Goal stage 2: awaited + success-reporting (see the writer's doc). */
  private clearOutboxOnAck(ids: string[]): Promise<boolean> {
    return clearOutboxOnAckWrite(this.outboxWriteTarget(), ids);
  }

  private recordOutboxDeadLetter(
    id: string,
    reason: string,
    attemptCount = 0
  ): void {
    recordOutboxDeadLetterWrite(
      this.outboxWriteTarget(),
      id,
      reason,
      attemptCount
    );
  }

  private recordOutboxReEnqueue(id: string): void {
    recordOutboxReEnqueueWrite(this.outboxWriteTarget(), id);
  }

  private recordOutboxRetry(
    id: string,
    attemptCount: number,
    nextAttemptAtMs: number,
    reason: string
  ): void {
    recordOutboxRetryWrite(
      this.outboxWriteTarget(),
      id,
      attemptCount,
      nextAttemptAtMs,
      reason
    );
  }

  /**
   * FEA-1962: persist the durable cursor once the client is fully caught up —
   * both queues drained and no pending chunks. At that moment every NON-dead row
   * up to `observedTopUpdatedAt` has been accepted, so it is a safe resume point.
   * Persisting only when the queues are drained is the acked-contiguous rule: we
   * never record a watermark ahead of an unaccepted/queued/retrying row, so a
   * restart can never skip a row that was not yet uploaded. Fire-and-forget:
   * a failed write just means the next cold start re-backfills (no data loss).
   *
   * Dead-lettered rows do NOT block persistence — they are RECORDED. A
   * dead-lettered session is one this run intentionally abandoned (locally
   * oversize / validation_failed / exhausted-retry); it was dropped from the
   * queues, so leaving the watermark blocked kept the cursor pinned forever and
   * forced a full re-walk of every local session on every restart (the observed
   * `queued historical backfill for 3456` + `deadLettered=21` loop). Recording
   * the dead ids in `deadLetteredIds` lets the watermark advance past them while
   * remembering exactly which rows were abandoned: nothing un-uploaded is skipped
   * (every non-dead row up to the watermark was acked before we got here, since
   * both queues are empty), and on resume the dead ids are set aside and revisited
   * last instead of re-walking the whole corpus.
   */
  private persistCursorIfCaughtUp(): void {
    if (
      !this.historicalBackfillEnabled ||
      this.incrementalQueue.length > 0 ||
      this.backfillQueue.length > 0 ||
      this.pendingChunks !== null
    ) {
      return;
    }
    const sourceKey = this.hydratedSourceKey;
    const source = this.options.getSource?.() ?? null;
    if (!(sourceKey && source?.advanceSyncState && this.observedTopUpdatedAt)) {
      return;
    }
    void Promise.resolve(
      source.advanceSyncState(sourceKey, this.buildCursorState())
    ).catch((error) => {
      gatewayLog.warn(
        TAG,
        `failed to persist agent-session sync cursor: ${errorMessage(error)}`
      );
    });
  }

  /**
   * FEA-1962/FEA-3473: build the durable cursor snapshot from the current
   * in-memory watermark, tied-top ids, and dead-letter set. Single source of
   * truth shared by `persistCursorIfCaughtUp` (drained-queues persist) and
   * `persistInitialBackfillCursor` (post-initial-seed persist).
   */
  private buildCursorState(): PersistedSyncState {
    return {
      observedTopUpdatedAt: this.observedTopUpdatedAt,
      // FEA-3473 (G6): cap the tied-top id set in the PERSISTED JSON only — the
      // in-memory working set stays complete (so incremental dedup is exact),
      // but a pathological cluster of same-`updated_at` sessions can never bloat
      // the `observed_ids_at_top_updated_at` column without bound. On overflow
      // the serialized set is truncated and a restart falls back to
      // re-scan-from-timestamp: an empty observed set omits the incremental
      // query's `id NOT IN (...)` exclusion, so `updated_at = watermark`
      // re-selects the whole tied-top group and the outbox + server idempotently
      // dedupe the re-enqueue — nothing un-uploaded is skipped.
      observedIdsAtTopUpdatedAt: capPersistedTopIds(
        this.observedIdsAtTopUpdatedAt,
        (message) => gatewayLog.warn(TAG, message)
      ),
      deadLetteredIds: [...this.deadLetteredIds.keys()],
    };
  }

  /**
   * FEA-3473: AWAIT the durable outbox seed for the initial full-corpus backfill
   * walk. Unlike the fire-and-forget `recordOutboxEnqueue`, the caller must know
   * the seed COMMITTED before persisting the cursor: the anti-stranding
   * invariant requires the outbox to be a complete ledger of remaining work
   * before a restart is allowed to skip the full re-walk. Returns true on a
   * committed seed, false on throw or an absent delegate (warn-log on throw,
   * mirroring `recordOutboxEnqueue`).
   */
  private async seedBackfillOutboxDurably(
    sourceKey: string,
    ids: string[]
  ): Promise<boolean> {
    if (ids.length === 0) {
      return false;
    }
    const source = this.options.getSource?.() ?? null;
    if (!source?.enqueueOutboxEntries) {
      return false;
    }
    const entries: AgentSessionOutboxEntry[] = ids.map((externalSessionId) => ({
      externalSessionId,
      syncClass: AgentSessionSyncClass.Backfill,
    }));
    try {
      await source.enqueueOutboxEntries(sourceKey, entries);
      return true;
    } catch (error) {
      gatewayLog.warn(
        TAG,
        `failed to record ${entries.length} outbox enqueue(s): ${errorMessage(error)}`
      );
      return false;
    }
  }

  /**
   * FEA-3473: persist the durable cursor immediately after the initial backfill
   * walk's outbox seed has committed — WITHOUT the both-queues-empty gate of
   * `persistCursorIfCaughtUp`. Once the full-corpus seed durably commits, the
   * outbox is a complete ledger of remaining work (acked→deleted, dead→marked,
   * pending→remaining), so a cold restart can safely resume from
   * `loadPendingOutboxIds` and skip the full re-walk. Called ONLY after
   * `seedBackfillOutboxDurably` returns true, preserving the anti-stranding
   * ordering: a crash mid-seed leaves the cursor unpersisted so the next start
   * runs the safe full re-walk. Warn-log on throw.
   */
  private async persistInitialBackfillCursor(sourceKey: string): Promise<void> {
    const source = this.options.getSource?.() ?? null;
    if (!(source?.advanceSyncState && this.observedTopUpdatedAt)) {
      return;
    }
    try {
      await source.advanceSyncState(sourceKey, this.buildCursorState());
    } catch (error) {
      gatewayLog.warn(
        TAG,
        `failed to persist initial backfill cursor: ${errorMessage(error)}`
      );
    }
  }

  /**
   * FEA-1461: pick up to `limit` session IDs from `queue`, skipping any whose
   * deferred-retry deadline (set by a prior `rate_limited` failure) is still
   * in the future. Order is preserved for selected IDs so the queue remains
   * stable; only the backed-off entries are skipped, not reordered.
   */
  private pickReadyCandidates(
    queue: readonly string[],
    limit: number,
    nowMs: number
  ): string[] {
    const result: string[] = [];
    for (const id of queue) {
      const deadline = this.nextRetryAfterMs.get(id);
      if (deadline !== undefined && deadline > nowMs) {
        continue;
      }
      result.push(id);
      if (result.length >= limit) {
        break;
      }
    }
    return result;
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
    multiPartEnvelope: boolean
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
        {
          syncMode,
          ids,
          sessionCount,
          payloadBytes,
          latencyMs,
          hasMoreChunks,
          remainingChunks: hasMoreChunks
            ? (this.pendingChunks?.chunks.length ?? null)
            : null,
          ...(ack.acceptedSessionIds
            ? { acceptedSessionIds: ack.acceptedSessionIds }
            : {}),
        },
        {
          rowState: {
            timeoutCountById: this.timeoutCountById,
            rateLimitedCountById: this.rateLimitedCountById,
            ingestionFailedCountById: this.ingestionFailedCountById,
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
          },
          clearOutboxDurably: (ackedIds) => this.clearOutboxOnAck(ackedIds),
          sourceStateGeneration: () => this.sourceStateGeneration,
          isStarted: () => this.started,
          dequeue: (mode, ackedIds) => this.dequeue(mode, ackedIds),
          persistCursorIfCaughtUp: () => this.persistCursorIfCaughtUp(),
          applyBoundedFold: (config) => this.applyBoundedFailureFold(config),
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
          logInfo: (message) => gatewayLog.info(TAG, message),
          logError: (message) => gatewayLog.error(TAG, message),
        }
      );
      return;
    }

    // On any failure, discard remaining chunks for this session — partial
    // chunk sequences are not useful without server-side reassembly.
    //
    // FEA-1461: the next retry will re-fetch + re-chunk the source session
    // from the dashboard sync source. That re-chunk work is bounded for transient failures
    // (rate_limited) by the per-session backoff added below — the same
    // session is not re-attempted within RATE_LIMIT_BACKOFF_MS — and by the
    // MAX_CONSECUTIVE_RATE_LIMITED dead-letter trip. True resume-from-chunk-N
    // would eliminate the re-chunk work entirely but requires server-side
    // partial-payload reassembly that does not exist today; tracked as out
    // of scope on FEA-1461.
    if (this.pendingChunks && ids.includes(this.pendingChunks.sessionId)) {
      gatewayLog.warn(
        TAG,
        `discarding ${this.pendingChunks.chunks.length} remaining chunk(s) for session ${this.pendingChunks.sessionId} after batch failure (${ack.reason})`
      );
      this.pendingChunks = null;
    }

    // FEA-1995: a batch is a `dead_letter` for sync.* telemetry when this ack
    // permanently removes one or more sessions — validation_failed,
    // ack-timeout, and rate-limit trips all grow `deadLetteredIds`.
    // Transient outcomes (retryable timeout, deferred rate-limit, deferred
    // validation-retry (FEA-3366), feature disabled, unknown reason) leave the
    // set unchanged and report `failure`.
    const deadLetteredCountBefore = this.deadLetteredIds.size;

    if (ack.reason === DesktopAgentSessionsAckReason.ValidationFailed) {
      // ISS-5090: which budget this rejection may spend depends on what was
      // actually rejected — a multi-id envelope, one part of a multi-part chunk
      // sequence, or a whole session. See
      // `agent-session-sync-validation-failure.ts`.
      applyValidationFailure(
        {
          syncMode,
          ids,
          payloadBytes,
          multiPartEnvelope,
          ...(ack.detail ? { detail: ack.detail } : {}),
        },
        {
          counter: this.validationFailedCountById,
          recoverableDeadLetterCountFor: (id) =>
            this.chunkValidationCycleById.get(id) ?? 0,
          markForBisection: (bisectIds, retryDeadlineMs) => {
            for (const id of bisectIds) {
              this.validationBisectIds.add(id);
              this.nextRetryAfterMs.set(id, retryDeadlineMs);
            }
          },
          clearBisectionFlag: (id) => this.validationBisectIds.delete(id),
          applyBoundedFold: (config) => this.applyBoundedFailureFold(config),
          logInfo: (message) => gatewayLog.info(TAG, message),
          formatBytes,
        }
      );
    } else if (ack.reason === DesktopAgentSessionsAckReason.FeatureDisabled) {
      this.featureDisabledForSession = true;
      this.timers.stopPoll();
      gatewayLog.info(
        TAG,
        "pausing agent-session sync until readiness is regained because the server rejected agent-session batches with feature_disabled"
      );
    } else if (ack.reason === DesktopAgentSessionsAckReason.Unauthenticated) {
      // FEA-3425: auth loss from the HTTP transport. Defer WITHOUT touching any
      // failure counter (the same no-budget-burn class as the FEA-3792
      // `transport_unavailable` no-target defer below): the batch stays queued,
      // every budget stays intact, and the lane resumes when the desktop
      // session refreshes. Since Phase 4a there is no socket write path to fall
      // back to — the HTTP transport is the only path.
      this.deferWithBudgetsIntact(ids, UNAUTHENTICATED_BACKOFF_MS);
      gatewayLog.info(
        TAG,
        `agent-session batch (${syncMode}, ~${formatBytes(payloadBytes)}) rejected as unauthenticated; ` +
          `deferring ${ids.length} session(s) for ${Math.round(UNAUTHENTICATED_BACKOFF_MS / 1000)}s ` +
          "with retry budgets intact until the desktop session refreshes"
      );
    } else if (ack.reason === DesktopAgentSessionsAckReason.TargetNotOwned) {
      // FEA-3425: the server's ownership check refused the sent computeTargetId.
      // Waiting cannot fix a wrong id, and dead-lettering would strand good
      // sessions — defer with budgets intact and surface loudly; identity
      // re-resolves via the normal hello/refresh path.
      this.deferWithBudgetsIntact(ids, TARGET_NOT_OWNED_BACKOFF_MS);
      gatewayLog.warn(
        TAG,
        `agent-session batch (${syncMode}, ~${formatBytes(payloadBytes)}) rejected: computeTargetId not owned by the authenticated identity; ` +
          `deferring ${ids.length} session(s) for ${Math.round(TARGET_NOT_OWNED_BACKOFF_MS / 1000)}s ` +
          "(budgets intact) awaiting identity re-resolution"
      );
    } else if (ack.reason === DesktopAgentSessionsAckReason.AckTimeout) {
      // Ack timeouts are transient (oversized/slow round-trip) → eligible for
      // live retry-after recovery. A deferred timeout just re-attempts on the
      // next tick (no backoff deadline), so `backoffMs: null`.
      this.applyBoundedFailureFold({
        ids,
        syncMode,
        payloadBytes,
        counter: this.timeoutCountById,
        maxConsecutive: MAX_CONSECUTIVE_TIMEOUTS,
        reason: "ack_timeout",
        recoverable: true,
        backoffMs: null,
        recordOutboxOnDefer: false,
      });
    } else if (ack.reason === DesktopAgentSessionsAckReason.TransportTimeout) {
      // ISS-5088: the local request deadline fired with no server answer — an
      // ambiguous failure the `TransportTimeoutBudget` resolves by suppressing
      // the charge inside a known outage and refunding earlier ones, while
      // still bounding a genuinely undeliverable row.
      this.applyBoundedFailureFold({
        ids,
        syncMode,
        payloadBytes,
        ...this.transportTimeoutBudget.foldPolicy(),
      });
    } else if (ack.reason === DesktopAgentSessionsAckReason.RateLimited) {
      // FEA-3792 (PRD-536 D9): `RateLimited` is now UNAMBIGUOUSLY a genuine
      // server-side throttle (the HTTP wiring returns `TransportUnavailable`
      // when the compute target is not yet known — offline or the socket hello
      // is pending — handled in its own branch below). No more racy post-hoc
      // `isHttpReady()` re-read to guess the cause: a server throttle always
      // increments the per-session counter and dead-letters once the budget is
      // spent.
      this.handleThrottleAck({
        ids,
        syncMode,
        payloadBytes,
        countsById: true,
      });
    } else if (
      ack.reason === DesktopAgentSessionsAckReason.TransportUnavailable
    ) {
      // FEA-3792 (PRD-536 D9): local transport unavailability (no compute target
      // yet — offline, or the socket hello landed after the batch was prepared).
      // A missing target is not a session-payload problem, so defer with backoff
      // but NEVER increment the dead-letter counter — treating it as a throttle
      // would dead-letter perfectly good sessions after MAX_CONSECUTIVE_RATE_LIMITED
      // no-target defers (the FEA-1461 regression this split makes structural
      // instead of racy).
      //
      // ISS-5088: reaching here is unambiguous proof the cloud connection is
      // down (no live compute target). Any `transport_timeout` charge taken
      // before this ack was therefore taken during a lane-wide outage window —
      // hand it back before it can dead-letter a healthy session.
      this.noteTransportLoss("cloud transport unavailable");
      this.handleThrottleAck({
        ids,
        syncMode,
        payloadBytes,
        countsById: false,
      });
    } else if (ack.reason === DesktopAgentSessionsAckReason.IngestionFailed) {
      // ingestion_failed is transient server-side backpressure → eligible for
      // live recovery. FEA-3659: the deferred retry is durably recorded in the
      // outbox (attempt_count / next_attempt_at) and the exhausted count is
      // stamped at dead-letter time, so a transient burst dead-letters only once
      // its full backoff budget is spent (the 179-row-burst fix).
      this.applyBoundedFailureFold({
        ids,
        syncMode,
        payloadBytes,
        counter: this.ingestionFailedCountById,
        maxConsecutive: MAX_CONSECUTIVE_INGESTION_FAILED,
        reason: "ingestion_failed",
        recoverable: true,
        backoffMs: INGESTION_FAILED_BACKOFF_MS,
        recordOutboxOnDefer: true,
      });
    } else {
      gatewayLog.debug(
        TAG,
        `agent-session batch rejected by server (${syncMode}): ${ack.reason}`
      );
    }

    this.options.onBatchOutcome?.({
      outcome: DesktopSyncBatchOutcome.Failure,
      reason: ack.reason,
      syncMode,
      sessionCount,
      payloadBytes,
    });
    this.options.onSyncBatchTelemetry?.({
      outcome:
        this.deadLetteredIds.size > deadLetteredCountBefore
          ? DesktopSyncBatchOutcome.DeadLetter
          : DesktopSyncBatchOutcome.Failure,
      payloadBytes,
      latencyMs,
      // The server ack reason (ack_timeout / rate_limited / ingestion_failed /
      // validation_failed / feature_disabled) is the failure/dead-letter cause;
      // surfacing it here is the whole point of FEA-3426 (the SLO can now split
      // by reason instead of inferring from payload_bytes/latency_ms).
      reason: ack.reason,
    });

    // A dead-letter dequeues its rows and may have just drained both queues
    // without any accepted batch to trigger the persist. Recording the dead ids
    // and advancing the watermark here is what stops the full re-walk on the
    // next restart (the accepted path persists via handleBatchAck's success
    // branch; this covers the "only remaining rows dead-lettered" case).
    if (this.deadLetteredIds.size > deadLetteredCountBefore) {
      this.persistCursorIfCaughtUp();
      // FEA-4375: a terminal rejection that dead-letters rows is forward progress
      // — self-continue so a failure-heavy corpus behind repeatedly-rejected
      // batches does not pay the 5s poll per terminal batch (shafty023 / wongk).
      // Gated on a genuine dead-letter THIS ack: a purely-deferred rejection or a
      // lane-wide pause (feature_disabled / unauthenticated / transport_unavailable)
      // leaves the set unchanged and does NOT self-continue, and the rescheduler
      // itself only fires on a READY neighbor, so deferred backoff never spins.
      this.scheduleImmediateDrainIfReadyWorkRemains();
    }
  }

  /**
   * FEA-3425: park a batch's ids behind a retry deadline WITHOUT touching any
   * failure counter — the shared shape of the no-budget-burn ack classes
   * (`unauthenticated`, `target_not_owned`), whose precondition is external
   * (auth/identity state) and can only be fixed by waiting, never by burning
   * retry budget toward dead-letter. Call sites own their log line.
   */
  private deferWithBudgetsIntact(ids: string[], backoffMs: number): void {
    const retryDeadline = Date.now() + backoffMs;
    for (const id of ids) {
      this.nextRetryAfterMs.set(id, retryDeadline);
    }
  }

  /**
   * FEA-3792 (PRD-536 D9): the two throttle-shaped acks the batch can receive,
   * routed through the shared bounded fold (FEA-4375):
   *
   * - `RateLimited` (server payload throttle, `countsById: true`): counts toward
   *   `rateLimitedCountById` and dead-letters at `MAX_CONSECUTIVE_RATE_LIMITED` —
   *   a persistently-throttled session must eventually be set aside.
   * - `TransportUnavailable` (no compute target yet, `countsById: false`): defers
   *   with the same backoff but NEVER counts or dead-letters (`countsToward:
   *   false`) — a missing target is not a payload problem, so offline/hello-pending
   *   ticks must not burn a good session's budget.
   */
  private handleThrottleAck(params: {
    ids: string[];
    syncMode: AgentSessionSyncMode;
    payloadBytes: number;
    countsById: boolean;
  }): void {
    const { ids, syncMode, payloadBytes, countsById } = params;
    this.applyBoundedFailureFold({
      ids,
      syncMode,
      payloadBytes,
      counter: this.rateLimitedCountById,
      maxConsecutive: MAX_CONSECUTIVE_RATE_LIMITED,
      reason: "rate_limited",
      recoverable: true,
      backoffMs: RATE_LIMIT_BACKOFF_MS,
      recordOutboxOnDefer: false,
      countsToward: countsById,
      deferLabel: countsById
        ? "rate_limited (server payload throttle)"
        : "transport_unavailable (no compute target)",
    });
  }

  /**
   * FEA-4375: shared bounded-retry-then-dead-letter fold for the per-session
   * ack-reason classes with the identical shape (`validation_failed`,
   * `ack_timeout`, `ingestion_failed`). Delegates to the pure
   * `applyBoundedFailureFold` in `agent-session-sync-ack-fold.ts`, wiring this
   * service's counters/queues/outbox as the collaborator so the three call sites
   * are one line each and the fold shape cannot drift between reasons.
   */
  private applyBoundedFailureFold(config: BoundedFailureFoldConfig): void {
    applyBoundedFailureFold(config, {
      nextRetryAfterMs: this.nextRetryAfterMs,
      clearFailureStateForId: (id) => this.clearFailureStateForId(id),
      markDeadLettered: (id, recoverable, reason, attemptCount) =>
        this.markDeadLettered(id, recoverable, reason, attemptCount),
      dequeue: (syncMode, ids) => this.dequeue(syncMode, ids),
      recordOutboxRetry: (id, attemptCount, nextAttemptAt, reason) =>
        this.recordOutboxRetry(id, attemptCount, nextAttemptAt, reason),
      queueSizes: () => ({
        incremental: this.incrementalQueue.length,
        backfill: this.backfillQueue.length,
        deadLettered: this.deadLetteredIds.size,
      }),
      logWarn: (message) => gatewayLog.warn(TAG, message),
      logInfo: (message) => gatewayLog.info(TAG, message),
      formatBytes,
    });
  }

  /**
   * FEA-3364: bound retries on a THROWN `sendBatch` (dropped socket /
   * serialization failure), which produces no ack and so cannot ride the
   * ack-reason fold. Delegates to the pure `applyTransportErrorFold`, wiring
   * this service's counters/queues/chunks as the collaborator. Returns whether
   * any id was dead-lettered so the caller can pick the batch telemetry outcome
   * (`dead_letter` vs `failure`); the classification itself is documented on the
   * fold module.
   */
  private handleTransportError(
    syncMode: AgentSessionSyncMode,
    ids: string[],
    payloadBytes: number,
    error: unknown
  ): boolean {
    const isSerialization = isLocalSerializationError(error);
    if (!isSerialization) {
      // ISS-5088: a thrown (non-serialization) send is the HTTP analogue of a
      // dropped socket — in a network blackout it is the signal that arrives
      // FIRST and most often. Treat it as the same unambiguous connectivity
      // loss the `transport_unavailable` ack and a readiness drop record, so a
      // blackout can never quietly spend a healthy session's abort budget.
      this.noteTransportLoss("thrown transport error");
    }
    return applyTransportErrorFold(
      {
        syncMode,
        ids,
        payloadBytes,
        error,
        isSerialization,
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
        persistCursorIfCaughtUp: () => this.persistCursorIfCaughtUp(),
        scheduleImmediateDrainIfReadyWorkRemains: () =>
          this.scheduleImmediateDrainIfReadyWorkRemains(),
        logWarn: (message) => gatewayLog.warn(TAG, message),
        logError: (message) => gatewayLog.error(TAG, message),
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
    this.ingestionFailedCountById.delete(id);
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
   * a `transport_unavailable` ack, a thrown non-serialization send, or
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
    attemptCount = 0
  ): void {
    markDeadLettered(
      id,
      recoverable,
      reason,
      attemptCount,
      this.deadLetterLifecycleDeps()
    );
  }

  /**
   * Delegates to `enforceDeadLetterCap` in
   * `agent-session-sync-dead-letter-lifecycle.ts`, which bounds the in-memory
   * set and — because `persistCursorIfCaughtUp` serializes its keys — the
   * persisted `dead_lettered_ids` JSON with it.
   */
  private enforceDeadLetterCap(): void {
    enforceDeadLetterCap(this.deadLetterLifecycleDeps());
  }

  /**
   * Delegates to `recoverExpiredDeadLetters` in
   * `agent-session-sync-dead-letter-lifecycle.ts` — the TRANSIENT
   * (finite-deadline) recovery door.
   */
  private recoverExpiredDeadLetters(nowMs: number): void {
    recoverExpiredDeadLetters(nowMs, this.deadLetterLifecycleDeps());
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
        loadPendingIds: (key) => source.loadPendingOutboxIds?.(key) ?? [],
      },
      this.dispositionDeps()
    );
  }

  /**
   * Delegates to `promoteDeadLetterIfIdle` in
   * `agent-session-sync-dead-letter-lifecycle.ts` — the PERMANENTLY-STUCK
   * (infinite-deadline) revisit door, at most once per idle cycle.
   */
  private promoteDeadLetterIfIdle(): void {
    promoteDeadLetterIfIdle(this.deadLetterLifecycleDeps());
  }

  /**
   * The service-owned state and collaborators the dead-letter lifecycle reads
   * and mutates. Collections go by REFERENCE (same discipline as
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
      recordOutboxDeadLetter: (id, reason, attemptCount) =>
        this.recordOutboxDeadLetter(id, reason, attemptCount),
      recordOutboxReEnqueue: (id) => this.recordOutboxReEnqueue(id),
      logInfo: (message) => gatewayLog.info(TAG, message),
      logWarn: (message) => gatewayLog.warn(TAG, message),
    };
  }

  /**
   * ISS-6031: an EMPTY `loadSyncedSessions` result is a read result, not a
   * cause. Delegated so the decision and its two outcomes live in one tested
   * module (`agent-session-hydration-absence.ts`).
   *
   * The probe is invoked as a MEMBER call, never through a detached reference:
   * in the db-host build `source` is the FEA-2038 forwarding Proxy, whose `get`
   * trap answers `call`/`apply`/`bind` with `undefined`, so a detached
   * `probe.call(source, ids)` would throw and permanently degrade the probe to
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
        probe: () => source.findExistingSessionIds?.(ids),
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
      logWarn: (message) => gatewayLog.warn(TAG, message),
      logInfo: (message) => gatewayLog.info(TAG, message),
      emitDeadLetterTelemetry: (input) =>
        this.options.onSyncBatchTelemetry?.(input),
      persistCursorIfCaughtUp: () => this.persistCursorIfCaughtUp(),
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
      isCurrentSourceState: this.currentPassGuard,
      readSourceKey: () => this.hydratedSourceKey,
    };
  }

  private dequeue(syncMode: AgentSessionSyncMode, ids: string[]): void {
    const removeIds = new Set(ids);
    if (syncMode === AgentSessionSyncMode.Incremental) {
      this.incrementalQueue = this.incrementalQueue.filter(
        (id) => !removeIds.has(id)
      );
      for (const id of removeIds) {
        this.incrementalQueuedIds.delete(id);
      }
      return;
    }

    this.backfillQueue = this.backfillQueue.filter((id) => !removeIds.has(id));
    for (const id of removeIds) {
      this.backfillQueuedIds.delete(id);
    }
  }
}
