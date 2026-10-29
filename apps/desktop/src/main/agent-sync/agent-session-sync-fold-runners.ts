/**
 * @file agent-session-sync-fold-runners.ts
 * @description The session lane's REJECTION-FOLD WIRING: the four ways a failed
 * batch is folded back into per-row state, bound once to the service's counters,
 * queues, and outbox.
 *
 * Extracted from `agent-session-sync-service.ts` (a shrink-only grandfathered
 * hotspot — root `AGENTS.md`) by ISS-7730, which had to touch all four to add a
 * fifth. It follows the precedent that file already set with
 * `agent-session-outbox-writers.ts`: one collaborator built from a narrow view,
 * rather than N pass-through private methods each re-declaring the same eight
 * dependencies. The two fold-dep objects were 90% identical by line before this;
 * they are now built from one {@link SessionFoldRunnerView}, so the shared half
 * cannot drift between them.
 *
 * Behaviour is unchanged from the methods this replaced — the per-reason budget
 * choices, the log wording, and the branch semantics all moved verbatim.
 *
 * The view is CAPTURED, not resolved per call, and that is safe only because
 * every member is either a stable `readonly` Map reference or a closure over
 * `this`: the queues are reassigned on an identity change, so `queueSizes` reads
 * them through a getter rather than closing over the array.
 */

import type { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import type { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  LaneEnvironmentalDeferGate,
  type LaneEnvironmentalDeferState,
} from "../sync/lane-environmental-defer.js";
import type { PersistedLaneRunRead } from "../sync/lane-run-policy.js";
import type { SessionLaneRun } from "./agent-session-lane-run.js";
import {
  applyBoundedFailureFold,
  type BoundedFailureFoldConfig,
  type BoundedFailureFoldDeps,
} from "./agent-session-sync-ack-fold.js";
import {
  MAX_TRACKED_LANE_STALLS,
  SESSION_LANE_STALL_CEILING_MS,
} from "./agent-session-sync-backoff-policy.js";
import {
  applyLaneStallFold,
  type LaneStallFoldDeps,
  type OutboxStallWrite,
  SessionEnvironmentalDeferClass,
} from "./agent-session-sync-lane-stall-fold.js";
import { formatBytes } from "./agent-session-sync-service-helpers.js";
import { splitAgentSessionSyncSourceKey } from "./agent-session-sync-source.js";
import type { ValidationFailureDeps } from "./agent-session-sync-validation-failure.js";

/** The narrow slice of service state and collaborators the folds drive. */
export type SessionFoldRunnerView = {
  /**
   * ISS-8610: the LIVE lane identity `(account, compute target)`, re-read per
   * call. Live and not `hydratedSourceKey`, because the environmental hold has
   * to see a target switch on the tick it happens rather than on the tick the
   * hydration it is bouncing would have run.
   *
   * The environmental run compares only the TARGET half of this key — the rest
   * of it carries a negotiated capability revision that a reconnect can flip
   * without the lane changing at all.
   */
  sourceKey: () => string | null;
  /**
   * PLN-2028: this lane's four durable `sync_state` lane-run columns. Every
   * operation on it takes the environmental gate `createSessionFoldRunners`
   * owns — the record and the run it mirrors have one owner between them.
   */
  laneRun: SessionLaneRun;
  /** Per-session deferred-retry deadlines (ms since epoch). */
  nextRetryAfterMs: Map<string, number>;
  /** ISS-8605 (F1): the `rate_limited` attempt TALLY — no longer a budget. */
  rateLimitedCountById: Map<string, number>;
  /** ISS-8605 (F2): the `ack_timeout` attempt TALLY — no longer a budget. */
  timeoutCountById: Map<string, number>;
  /** ISS-8595: the attempt TALLY for an ack reason this build cannot name. */
  unknownAckReasonCountById: Map<string, number>;
  /** ISS-7730: the `ingestion_failed` attempt TALLY — never a terminal path. */
  ingestionFailedCountById: Map<string, number>;
  /** ISS-7730: per-session start of the current lane-wide run (ms since epoch). */
  laneStalledSinceMsById: Map<string, number>;
  /** FEA-3366: the single per-session `validation_failed` budget. */
  validationFailedCountById: Map<string, number>;
  /** ISS-5090: the chunk-envelope re-drive cycle count, its own bound. */
  chunkValidationCycleById: Map<string, number>;
  /** FEA-4375: ids the lane is re-sending singly to isolate a poison row. */
  validationBisectIds: Set<string>;
  clearFailureStateForId: (id: string) => void;
  markDeadLettered: (
    id: string,
    recoverable: boolean,
    reason: string,
    attemptCount?: number,
    permanentAttemptCount?: number | null
  ) => void;
  dequeue: (syncMode: AgentSessionSyncMode, ids: string[]) => void;
  /** The durable outbox retry write, `laneStalledSince` and all. */
  recordOutboxRetry: (
    id: string,
    attemptCount: number,
    nextAttemptAtMs: number,
    reason: string,
    laneStalledSince: string | null,
    permanentAttemptCount?: number | null
  ) => void;
  /**
   * ISS-8605: the ENVIRONMENTAL defer's durable write, acknowledged. Separate
   * from `recordOutboxRetry` because the two have different failure costs, not
   * because they hit different rows — see `agent-session-outbox-writers.ts`.
   */
  recordOutboxStall: (write: OutboxStallWrite) => Promise<boolean>;
  /** ISS-7730: the durable lane-stall clear. */
  clearOutboxLaneStall: (ids: string[]) => void;
  queueSizes: () => {
    incremental: number;
    backfill: number;
    deadLettered: number;
  };
  logWarn: (message: string) => void;
  logInfo: (message: string) => void;
};

export type LaneStallFoldInput = {
  ids: string[];
  syncMode: AgentSessionSyncMode;
  payloadBytes: number;
  deferClass: SessionEnvironmentalDeferClass;
  /** ISS-10014: the server's `Retry-After`, absent when it sent none. */
  retryAfterMs?: number;
};

/** Every rejection fold the session lane performs, bound to one view. */
export type SessionFoldRunners = {
  /**
   * ISS-8610: fold one LANE-WIDE environmental rejection — `unauthenticated`
   * (401), `target_not_owned` (403), `transport_unavailable` (no compute
   * target), or a send that failed at the network (ISS-10602). Returns the
   * gate's state so the caller can log the wait it is actually taking and name
   * a give-up.
   */
  deferLaneEnvironmental: (
    ids: readonly string[],
    reason: SyncReason,
    retryAfterMs?: number
  ) => LaneEnvironmentalDeferState;
  /**
   * ISS-8610: must the lane hold this tick — either inside the environmental
   * backoff window, or in the durable give-up?
   *
   * The hold is BOUNCED, never stopped: the 5s poll keeps re-asking, which is
   * what releases the lane when the ladder or the re-arm window elapses with
   * nothing else having to notice. It owns its own clock rather than taking one,
   * because it is also the lane's earliest sight of an IDENTITY switch — a
   * bounced tick never reaches the pass, so the hydration path's
   * `clearSourceDerivedState` cannot be what drops a previous target's run
   * (invariant 2). A key that no longer matches the open run drops it here.
   */
  heldEnvironmentally: () => boolean;
  /**
   * ISS-8610: a precondition these classes were blocked on changed (org-policy
   * transition, genuine account switch). Buy ONE immediate attempt.
   */
  noteLaneRecoverySignal: () => void;
  /**
   * ISS-8610: the access token was re-minted for the SAME account — the one
   * ordinary event that actually fixes a 401, and what makes moving that class
   * off its flat 30s safe. PACING ONLY, deliberately: it must not re-arm a
   * give-up, because a routine renewal is no evidence a day-long outage ended.
   */
  noteCredentialsRefreshed: () => void;
  /**
   * PLN-2028 (ISS-10053): adopt the whole lane RUN read back off the durable
   * columns — into the lane's own record AND the gate, so a relaunch RESUMES the
   * run rather than reopening it. Composed here and not at the call site so the
   * two adoptions cannot be wired to different identities.
   *
   * The ORIGIN is what ISS-8610's stamp-only adoption could not restore, and it
   * is the 24h ceiling's only bound across a relaunch.
   */
  adoptLaneRun: (persisted: PersistedLaneRunRead | null | undefined) => void;
  /**
   * ISS-8610: drop everything this identity's folds accumulated — the
   * environmental run, the per-row stall clocks, every attempt tally, the
   * bisection flags and the retry deadlines. The previous account's outage and
   * the previous account's evidence are not this one's (invariant 2).
   *
   * One call rather than a list the owning service maintains by hand: a tally
   * added to {@link SessionFoldRunnerView} is reset by construction here, where
   * it is declared, instead of surviving an identity switch because a second
   * file was not updated.
   */
  resetForIdentity: () => void;
  /**
   * ISS-8610: the lane's one funnel for "the lane ANSWERED". It ends the run in
   * the gate as well as on the four durable columns, so a lane the server has
   * answered can never stay held by a gate holding a stamp nobody cleared.
   *
   * Clear-only: a give-up is written by the producer that made it — the gate
   * through {@link SessionFoldRunners.deferLaneEnvironmental}, the per-row
   * ceiling through {@link SessionFoldRunners.applyLaneStall} — each carrying
   * the cause and the producer a bare instant could not (PLN-2028).
   */
  clearLaneGiveUp: () => void;
  applyBoundedFold: (config: BoundedFailureFoldConfig) => void;
  /**
   * ISS-8605: settles once the durable stall clocks are confirmed. The in-memory
   * effects are applied before the first await, so a caller that only needs
   * those still sees them synchronously; the ack path awaits it because the
   * clock is what bounds the row.
   */
  applyLaneStall: (input: LaneStallFoldInput) => Promise<void>;
  noteLaneAnswered: (ids: readonly string[]) => void;
  /**
   * ISS-8710: the `validation_failed` collaborator, built once here so the two
   * producers of that verdict — the server's rejected ack, and the tail drain
   * proving locally that a part cannot fit the request cap — spend the same
   * budgets and reach the same terminal path. Two call sites assembling this
   * bag independently is how they would drift.
   */
  validationFailureDeps: () => ValidationFailureDeps;
};

/** The half of both fold-dep objects that is identical by construction. */
function sharedFoldDeps(
  view: SessionFoldRunnerView
): Omit<BoundedFailureFoldDeps, "recordOutboxRetry"> {
  return {
    nextRetryAfterMs: view.nextRetryAfterMs,
    clearFailureStateForId: view.clearFailureStateForId,
    markDeadLettered: view.markDeadLettered,
    dequeue: view.dequeue,
    queueSizes: view.queueSizes,
    logWarn: view.logWarn,
    logInfo: view.logInfo,
    formatBytes,
  };
}

function boundedFoldDeps(view: SessionFoldRunnerView): BoundedFailureFoldDeps {
  return {
    ...sharedFoldDeps(view),
    // ISS-7730: every class still routed through this fold is row-attributable,
    // so a defer it records ENDS any lane-wide stall run — the server answered.
    // Passing null is that clear, not an omission.
    //
    // The in-memory delete rides the SAME callback deliberately. The two halves
    // are one fact, and the deciding half is the map: `stallWindowFor` reads it,
    // not the column. Splitting them let `ack_omitted` — the one class that
    // reaches this callback rather than `noteLaneAnswered` — write the durable
    // null while the live run kept accruing, so a row answered by an accepted
    // ack could still dead-letter as `ingestion_failed_lane_stalled` on a
    // demonstrably healthy lane. No extra durable write is needed: the null
    // below IS the column half.
    recordOutboxRetry: (id, attemptCount, nextAttemptAt, reason) => {
      view.laneStalledSinceMsById.delete(id);
      view.recordOutboxRetry(
        id,
        attemptCount,
        nextAttemptAt,
        reason,
        null,
        attemptCount
      );
    },
  };
}

function laneStallFoldDeps(
  view: SessionFoldRunnerView,
  noteLaneGiveUp: (gaveUpAtMs: number, reason: SyncReason) => void
): LaneStallFoldDeps {
  return {
    ...sharedFoldDeps(view),
    markDeadLettered: (
      id,
      recoverable,
      reason,
      attemptCount,
      permanentAttemptCount = null
    ) =>
      view.markDeadLettered(
        id,
        recoverable,
        reason,
        attemptCount,
        permanentAttemptCount
      ),
    recordOutboxStall: (write) => view.recordOutboxStall(write),
    noteLaneGiveUp,
  };
}

/**
 * Bind every rejection fold to one service view.
 *
 * - `deferLaneEnvironmental` (ISS-8610, PRD-699 F8) folds the LANE-WIDE
 *   environmental classes — `unauthenticated` (401), `target_not_owned` (403),
 *   `transport_unavailable` (no compute target) and, since ISS-10602, a send
 *   that failed at the network with no HTTP answer. None of them is a payload
 *   problem and none may touch a failure counter (invariant 4); what they lacked
 *   was a clock. They now share ONE `LaneEnvironmentalDeferGate`, because an
 *   environmental failure means every row would fail identically, so there is
 *   nothing to schedule per row and no id-keyed clock to bound (invariant 10).
 *   The gate stages the wait off the run's own age and terminates it on the same
 *   24h ceiling, stamped durably so a relaunch resumes the give-up instead of
 *   reopening the run.
 *
 *   It replaced two shapes that had no clock at all. FEA-3425's
 *   `deferWithBudgetsIntact` parked 401/403 behind a flat 30s forever, and
 *   FEA-3792's `deferTransportUnavailable` routed a no-target defer through the
 *   bounded fold with `countsToward: false` and an infinite ceiling — invariant 4
 *   satisfied and invariant 5 violated in the same line, which is the shape
 *   `agent-session-sync-lane-stall-fold.ts`'s own header warns against.
 *
 *   The per-row deadline is still written, unchanged: `countReadyCandidates`
 *   divides a progress surface by that predicate, so a row the lane will not
 *   send has to keep reading as deferred. The gate is what paces; the deadlines
 *   are what the rest of the lane already understands, and a recovery signal
 *   drops both together so the one attempt it buys is actually taken.
 * - `applyBoundedFold` (FEA-4375) is the bounded-retry-then-dead-letter fold for
 *   the row-attributable classes with the identical shape.
 * - `applyLaneStall` (ISS-7730, widened by ISS-8605/ISS-8595) is the
 *   ENVIRONMENTAL fold: defer with every budget intact (invariant 4),
 *   dead-letter only on the durable wall clock (invariant 5). The caller names
 *   which class it is; the tally each class advances is picked here so no two
 *   classes can contaminate each other's evidence.
 * - `noteLaneAnswered` (ISS-7730) ends a lane-wide stall run because the server
 *   returned a verdict ABOUT THE ROW, which is proof the lane is reachable. It
 *   clears the in-memory clock and, only for ids that actually held one, the
 *   durable column: the row-attributable defer classes issue no other durable
 *   write, so without this a stale run would sit on disk and a relaunch would
 *   rehydrate it, abandoning the row on its next 5xx as if a day-long outage had
 *   just ended. Gating the write on in-memory presence keeps the healthy path
 *   free of writes — rehydration seeds the map from that same column, so
 *   presence tracks the column, EXCEPT past `MAX_TRACKED_LANE_STALLS`: a resume
 *   that hit the admission cap leaves stamped rows unseeded, and an answer to
 *   one of those skips the durable clear. That stamp is stale but not
 *   authoritative — the row's next lane-wide failure overwrites it with a fresh
 *   start once a slot frees — so the exposure is a restart landing inside that
 *   gap, whose worst outcome is one early RECOVERABLE lane-stall dead-letter
 *   that the FEA-3363 revisit re-drives.
 */
export function createSessionFoldRunners(
  view: SessionFoldRunnerView
): SessionFoldRunners {
  const applyBoundedFold = (config: BoundedFailureFoldConfig): void => {
    applyBoundedFailureFold(config, boundedFoldDeps(view));
  };
  // ISS-8610: ONE clock for the whole lane, on the default schedule (5-minute
  // floor, one-hour per-delay cap, the same 24h ceiling the per-row fold uses).
  const environmentalGate = new LaneEnvironmentalDeferGate();
  // The ids this gate parked, so a recovery signal can drop their deadlines and
  // the one attempt it buys is actually taken. Bounded by construction — a held
  // lane attempts one batch per re-arm, so this holds a handful of ids over an
  // outage — and admission-capped anyway, because invariant 10 asks for a cap
  // rather than for an argument about why one is not needed.
  const laneEnvironmentalDeferredIds = new Set<string>();
  // ISS-8610: the COMPUTE TARGET the OPEN environmental run belongs to. A run is
  // one lane's outage and a lane is (account, compute target), so a switch must
  // not inherit one (invariant 2). The pass's own identity reset cannot be what
  // enforces that any more: a held tick is bounced before hydration ever runs.
  //
  // The TARGET, and deliberately not the whole `sourceKey()`: that key also
  // carries the negotiated monitored-activity revision
  // (`buildAgentSessionSyncSourceKey`), so a reconnect that renegotiates that
  // capability against the SAME target changes the key without changing the
  // lane. Comparing keys would read every such renegotiation as a switch and
  // drop the run, resetting a climbing 24h ceiling to zero on a flapping link —
  // the unbounded-retry hole (invariant 5) this whole gate exists to close.
  let environmentalRunTargetId: string | null = null;
  // ISS-10014: until when a server `Retry-After` on a STALL-FOLD rejection holds
  // the whole lane. That fold paces only the rows in the rejected batch, but a
  // 429 is keyed per compute target, so without this the next tick sends the
  // next batch into the window the server just refused. Deliberately NOT the
  // gate's `noteEnvironmentalFailure`: that opens a lane run with the ISS-9418
  // give-up on the end of it, and ISS-8605 chose the durable per-row clock as
  // these classes' terminal bound. This is a pause, bound to the lane identity
  // like the run is, and cleared by the same "the lane answered" doors.
  let serverHoldUntilMs = 0;
  // The target half of the live lane identity. An unsplittable key belongs to
  // another lane or has no target segment at all; it carries no capability
  // segment to strip either, so comparing it whole loses nothing.
  const liveEnvironmentalTargetId = (): string | null => {
    const liveSourceKey = view.sourceKey();
    if (liveSourceKey === null) {
      return null;
    }
    return (
      splitAgentSessionSyncSourceKey(liveSourceKey)?.computeTargetId ??
      liveSourceKey
    );
  };
  const clearLaneEnvironmentalDeferrals = (): void => {
    for (const id of laneEnvironmentalDeferredIds) {
      view.nextRetryAfterMs.delete(id);
    }
    laneEnvironmentalDeferredIds.clear();
    serverHoldUntilMs = 0;
  };
  const endEnvironmentalRun = (): void => {
    environmentalGate.reset();
    environmentalRunTargetId = null;
    clearLaneEnvironmentalDeferrals();
    // PLN-2028: the durable record belongs to the same identity the run does, so
    // it is dropped with it. Its believed give-up is the previous target's, and
    // anchoring a new target's ceiling against it would suppress a write the new
    // lane owes (invariant 2).
    view.laneRun.clearIdentity();
    // ISS-7730/ISS-8610: the per-row lane-stall clocks measure the same outage
    // and belong to the same identity, so they end with the run rather than at a
    // second call site the next identity switch could forget.
    view.laneStalledSinceMsById.clear();
  };
  const clearLaneGiveUp = (): void => {
    // The lane ANSWERED. End the environmental run in the gate at the same
    // moment the columns are cleared: a gate still holding a stamp would keep
    // holding a lane the server has demonstrably just judged, and the two
    // would disagree about whether the lane is terminal.
    environmentalGate.noteLaneAnswered();
    environmentalRunTargetId = null;
    clearLaneEnvironmentalDeferrals();
    view.laneRun.clear();
  };
  return {
    applyBoundedFold,
    clearLaneGiveUp,
    deferLaneEnvironmental: (ids, reason, retryAfterMs) => {
      const nowMs = Date.now();
      environmentalRunTargetId = liveEnvironmentalTargetId();
      const state = environmentalGate.noteEnvironmentalFailure(
        nowMs,
        retryAfterMs
      );
      for (const id of ids) {
        view.nextRetryAfterMs.set(id, state.nextAttemptAtMs);
        if (laneEnvironmentalDeferredIds.size < MAX_TRACKED_LANE_STALLS) {
          laneEnvironmentalDeferredIds.add(id);
        }
      }
      view.laneRun.noteEnvironmentalOutcome(environmentalGate, state, reason);
      return state;
    },
    heldEnvironmentally: () => {
      // Both halves non-null: a live target that has gone MISSING (pre-hello, or
      // a dropped socket) is not a switch, and dropping the run on it would let a
      // flapping transport reopen a 24h ceiling from zero on every blip.
      const liveTargetId = liveEnvironmentalTargetId();
      if (
        environmentalRunTargetId !== null &&
        liveTargetId !== null &&
        environmentalRunTargetId !== liveTargetId
      ) {
        // A different lane. Drop the run rather than hold the new target behind
        // the old one's outage — and report NOT held, so this tick runs and
        // hydrates the new identity's own give-up off its own `sync_state` row.
        endEnvironmentalRun();
        return false;
      }
      if (environmentalRunTargetId === null && liveTargetId !== null) {
        // The `transport_unavailable` class opens its run with NO target — that
        // absence is what it is deferring on — so the switch arm above can never
        // fire for it, and without this the lane would keep sitting out a rung it
        // no longer owes once a target resolved.
        //
        // Adopt the target and end the PACING window only. NOT the run: a target
        // that flaps resolved/unresolved would otherwise reopen the 24h ceiling
        // from zero on every blip, which is the same hole the MISSING case above
        // is written to avoid. The give-up keeps its own door — `windowReArmed`
        // releases it on schedule — because a target appearing says nothing about
        // whether the outage that spent the ceiling has ended.
        environmentalRunTargetId = liveTargetId;
        environmentalGate.clearPacing();
        clearLaneEnvironmentalDeferrals();
      }
      const nowMs = Date.now();
      return (
        nowMs < serverHoldUntilMs ||
        environmentalGate.isDeferred(nowMs) ||
        environmentalGate.isGivenUp(nowMs)
      );
    },
    noteLaneRecoverySignal: () => {
      // Both doors, in this order. `noteRecoverySignal` re-arms a GIVE-UP and is
      // a no-op otherwise; `clearPacing` ends the backoff window a lane that has
      // not yet given up would otherwise sit out. Neither touches the run.
      environmentalGate.noteRecoverySignal();
      environmentalGate.clearPacing();
      clearLaneEnvironmentalDeferrals();
    },
    noteCredentialsRefreshed: () => {
      // The narrow half of the door above, and narrow on purpose. A same-account
      // renewal is frequent, so re-arming a give-up on it would make the 24h
      // ceiling a function of the refresh cadence — the defect
      // `AuthSessionLaneKicks.noteLaneRecoverySignal` keeps its identity diff to
      // avoid. Ending the PACING window is the part a new token earns: the
      // lane is blocked on credentials that demonstrably just changed, and
      // without this a 401 would sit out a rung up to an hour long where it used
      // to retry in 30 seconds.
      environmentalGate.clearPacing();
      clearLaneEnvironmentalDeferrals();
    },
    adoptLaneRun: (persisted) => {
      environmentalRunTargetId = liveEnvironmentalTargetId();
      view.laneRun.adopt(environmentalGate, persisted, Date.now());
    },
    resetForIdentity: () => {
      // ISS-8610 (whitlockk review): the environmental run belongs to the TARGET, and
      // this path also fires on a same-target capability REKEY — the
      // monitored-activity revision is part of `sourceKey` but not part of the
      // lane, and the hydration path compares whole keys. Ending the run there
      // would restart a climbing 24h ceiling on every renegotiation, which is
      // the same hole `heldEnvironmentally` compares targets to avoid. Everything
      // below IS derived from the payload revision and still goes.
      const liveTargetId = liveEnvironmentalTargetId();
      if (
        environmentalRunTargetId === null ||
        liveTargetId === null ||
        environmentalRunTargetId !== liveTargetId
      ) {
        endEnvironmentalRun();
      }
      view.timeoutCountById.clear();
      view.rateLimitedCountById.clear();
      view.unknownAckReasonCountById.clear();
      view.ingestionFailedCountById.clear();
      view.validationFailedCountById.clear();
      view.chunkValidationCycleById.clear();
      // FEA-4375: drop pending validation-bisection flags on identity change/stop.
      view.validationBisectIds.clear();
      view.nextRetryAfterMs.clear();
    },
    validationFailureDeps: () => ({
      counter: view.validationFailedCountById,
      recoverableDeadLetterCountFor: (id) =>
        view.chunkValidationCycleById.get(id) ?? 0,
      markForBisection: (bisectIds, retryDeadlineMs) => {
        for (const id of bisectIds) {
          view.validationBisectIds.add(id);
          view.nextRetryAfterMs.set(id, retryDeadlineMs);
        }
      },
      clearBisectionFlag: (id) => view.validationBisectIds.delete(id),
      applyBoundedFold,
      logInfo: view.logInfo,
      formatBytes,
    }),
    applyLaneStall: (input) => {
      if (input.retryAfterMs !== undefined) {
        // Bound to the live target so `heldEnvironmentally`'s identity checks
        // drop it on a switch and keep it across a merely-missing key, and
        // capped at the ceiling for the reason `laneStallDelayMs` caps: a hint
        // past the whole budget is not a schedule.
        environmentalRunTargetId = liveEnvironmentalTargetId();
        serverHoldUntilMs = Math.max(
          serverHoldUntilMs,
          Date.now() +
            Math.min(
              Math.max(0, input.retryAfterMs),
              SESSION_LANE_STALL_CEILING_MS
            )
        );
      }
      return applyLaneStallFold(
        {
          ...input,
          attemptsById: environmentalTallyFor(input.deferClass, view),
          stalledSinceMsById: view.laneStalledSinceMsById,
        },
        laneStallFoldDeps(view, (gaveUpAtMs, reason) =>
          view.laneRun.noteRowCeilingGiveUp(
            environmentalGate,
            gaveUpAtMs,
            reason
          )
        )
      );
    },
    noteLaneAnswered: (ids) => {
      const stalled = ids.filter((id) =>
        view.laneStalledSinceMsById.delete(id)
      );
      view.clearOutboxLaneStall(stalled);
      // ISS-9418: the server returned a verdict ABOUT A ROW, which is proof the
      // lane is reachable — so the LANE-level give-up ends here too, on the same
      // evidence and at the same moment the per-row clocks do. Unconditional,
      // unlike the per-row clear above: the lane stamp is one fact about the
      // lane, so it does not need an id to have held a clock, and clearing an
      // absent stamp is the no-op the writer's change-detection makes free.
      //
      // This is one of the lane's TWO answers, not the only one. A verified ack
      // is the other and clears the stamp from `processAcceptedAck`; a corpus
      // that recovers the normal way may never reject another row, so a lane
      // wired only to this path would stay stamped forever.
      clearLaneGiveUp();
    },
  };
}

/**
 * The attempt TALLY one environmental class advances. Exhaustive by type, so a
 * class added to {@link SessionEnvironmentalDeferClass} fails `tsc` here until
 * someone says which evidence it writes — a default branch would quietly file a
 * new class's attempts under an existing one's tally, which is the
 * conditional-counter defect this repo has shipped before.
 *
 * Each class gets its OWN map on purpose: sharing one across classes would
 * report a count the current failure did not cause. The tally is what
 * `loadPendingSessionOutboxEngineState` selects on (`attempt_count > 0`) to find a
 * stalled row and rehydrate its wall clock — true for all four classes.
 *
 * It ALSO feeds the ISS-7248 attempt number, but only for the three classes the
 * telemetry contract can name. `budgetForSyncReason` keys on `SyncReason`, a
 * closed enum with no member for an unrecognized wire value, so it returns null
 * for the unknown class and that diagnostic reports 0 attempts however many the
 * row actually made. Widening it would mean adding a `SyncReason` member in
 * `@closedloop-ai/telemetry-contract` — a cross-package contract change, not
 * this ticket's. The durable `attempt_count` is still written and still correct;
 * it is only the telemetry attribute that reads 0.
 */
function environmentalTallyFor(
  deferClass: SessionEnvironmentalDeferClass,
  view: SessionFoldRunnerView
): Map<string, number> {
  const tallies: Record<SessionEnvironmentalDeferClass, Map<string, number>> = {
    [SessionEnvironmentalDeferClass.IngestionFailed]:
      view.ingestionFailedCountById,
    [SessionEnvironmentalDeferClass.RateLimited]: view.rateLimitedCountById,
    [SessionEnvironmentalDeferClass.AckTimeout]: view.timeoutCountById,
    [SessionEnvironmentalDeferClass.UnknownAckReason]:
      view.unknownAckReasonCountById,
  };
  return tallies[deferClass];
}
