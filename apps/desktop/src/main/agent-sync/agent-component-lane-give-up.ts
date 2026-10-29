/**
 * @file agent-component-lane-give-up.ts
 * @description ISS-9418, PLN-2028 (ISS-10053, ISS-9963): what the
 * component-inventory lane RECORDS about its environmental run — the durable
 * half (the four `sync_state` lane-run columns, read back into the gate on
 * hydration and written back when they change) and the observable half (the
 * `sync.lane.gave_up` / `sync.lane.rearmed` pair).
 *
 * The run ORIGIN is what makes the 24h ceiling reachable across a relaunch
 * ({@link ComponentLaneGiveUp.adoptPersisted}), and the cause and producer beside
 * it are what let a resumed give-up say why it is held (ISS-9963) instead of
 * reporting silence.
 *
 * Both halves belong together because both are "what outlives this tick about a
 * give-up the gate decided", and both are driven off the same two seams: the
 * state `noteEnvironmentalFailure` returns, and `reArmTrigger`. Splitting them
 * would mean two collaborators reading one gate and two chances for a stamp and
 * an announcement to disagree about whether the lane is terminal — which is the
 * same argument that kept the give-up decision inside
 * `noteEnvironmentalFailure` instead of a separate announce method.
 *
 * Extracted rather than inlined because `agent-session-sync-component-lane.ts`
 * is not grandfathered and was at 1,035 logical lines with this in it, past the
 * 1,000 ceiling. It is a real seam and not a line-count slice: everything here
 * is about ONE record and nothing here touches the cursor, the batch, or the
 * dead-letter tracker.
 *
 * The lane keeps the two things that are genuinely its own: the gate (which the
 * whole tick consults) and the `hydratedSourceKey` guard that decides whether
 * the durable row has been consulted yet.
 */

import {
  type LaneGiveUpSource,
  SyncLane,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { LaneGiveUpStampDefect } from "../../shared/lane-give-up.js";
import type { createTransitionLogger } from "../diagnostics/component-sync-diagnostics.js";
import type {
  LaneEnvironmentalDeferGate,
  LaneEnvironmentalDeferState,
} from "../sync/lane-environmental-defer.js";
import {
  laneGateGiveUpSource,
  laneRunDefectNotes,
  laneRunResumesHold,
  type PersistedLaneRunRead,
  readLaneRunRecord,
} from "../sync/lane-run-policy.js";
import {
  LaneRunRecord,
  sourceLaneRunPersist,
} from "../sync/lane-run-record.js";
import {
  clearSyncLaneGiveUpAnnouncement,
  reportSyncLaneGaveUp,
  reportSyncLaneReArmed,
} from "../telemetry/sync-lane-give-up-telemetry.js";
import type { AgentSessionSyncSource } from "./agent-session-sync-source.js";

export type ComponentLaneGiveUpOptions = {
  /** The gate whose give-up state this mirrors to and from disk. */
  gate: LaneEnvironmentalDeferGate;
  /**
   * Re-resolved per write, never captured: the DB-host source proxy goes null
   * while the host restarts, and a null captured once silently disables the
   * durable write for the life of the lane (the ISS-5347 cursor freeze).
   */
  getSource: () => AgentSessionSyncSource | null;
  /**
   * The lane's give-up diagnostic, kept separate from its send and
   * cursor-persist loggers so one failing cannot rob another of its single line.
   */
  diag: ReturnType<typeof createTransitionLogger>;
};

/**
 * ISS-9418: the give-up a {@link ComponentLaneGiveUp} is holding.
 *
 * `reason` is the ENVIRONMENTAL cause, or `null` when the row this give-up was
 * RESUMED from could not supply one - a row written before migration 0091, which
 * recorded an instant and nothing else, or one naming a `SyncReason` this build
 * does not know. Reported as absent rather than guessed - `SyncReason` has no
 * member meaning "unknown", and naming one that means something else would send
 * an operator after a precondition that was never the problem.
 *
 * A wrapper object rather than a second boolean field beside the reason, so
 * "holding none" and "holding one with no known cause" cannot drift apart.
 *
 * PLN-2028 (ISS-10043): `source` travels with it for the same reason and with
 * the same `null`. It is what the announcement's SHAPE is derived from, so a
 * give-up resumed off a row that records no producer says the scope is unknown
 * rather than borrowing this lane's usual sentence.
 */
type HeldComponentGiveUp = {
  reason: SyncReason | null;
  source: LaneGiveUpSource | null;
};

/** One component lane's view of its four durable `sync_state` lane-run columns. */
export class ComponentLaneGiveUp {
  private readonly options: ComponentLaneGiveUpOptions;

  private readonly durableRun: LaneRunRecord;

  /**
   * ISS-9963: the cause of the give-up currently on record, as the durable
   * column carries it.
   *
   * Its own field rather than a read off {@link heldGiveUp}, because the two have
   * different lifetimes: `noteSendAttempt` clears the held ANNOUNCEMENT the
   * moment the lane commits to a send, while the stamp stays on record until
   * that send's outcome. Reading the cause off the latch would blank the column
   * on the tick the lane tried again, so the row would lose the reason for a
   * give-up it is still holding.
   */
  private giveUpReason: SyncReason | null = null;

  /**
   * ISS-9418: the give-up this lane is currently holding, or `null` when it is
   * not holding one.
   *
   * Kept because the announcement has to be RE-ATTEMPTED. The telemetry lane's
   * send gate is shut by exactly the sustained connectivity loss that drove the
   * run past its 24h ceiling, so the announcement at the crossing is the attempt
   * most likely to be dropped - and this lane's give-up is a ONE-SHOT
   * transition, so without something to replay there is no later call to make.
   *
   * Two levels of `null` and they say different things: a `null` HERE is "this
   * lane is holding no give-up, so there is nothing to announce", while a `null`
   * {@link HeldComponentGiveUp.reason} is "it is holding one and cannot say
   * why". Collapsing them is what made a relaunch mid-outage drop both halves of
   * the pair.
   */
  private heldGiveUp: HeldComponentGiveUp | null = null;

  constructor(options: ComponentLaneGiveUpOptions) {
    this.options = options;
    this.durableRun = new LaneRunRecord({
      getPersist: () => sourceLaneRunPersist(() => this.options.getSource()),
      onWriteFailed: (message) =>
        this.options.diag.note(
          "warn",
          "give-up-persist-failed",
          `durable lane run write failed: ${message}; this process still terminates the lane, but a relaunch before the next write restarts its 24h run`
        ),
      // The failure hook above is transition-logged, so without this reset a
      // second, genuinely new persist failure is swallowed by the first one's
      // outcome for the life of the process. Mirrors `persistDiag.set("ok")` on
      // the sibling cursor-persist diagnostic, which resets for this reason.
      onWriteSucceeded: () => this.options.diag.set("ok"),
      onPersistUnavailable: () =>
        this.options.diag.note(
          "warn",
          "give-up-persist-unavailable",
          "no durable lane run write available; the 24h ceiling is in-memory only and a relaunch restarts it"
        ),
    });
  }

  /**
   * Resume the whole lane RUN the previous process recorded for `sourceKey`, and
   * note that the columns are now current so the tick's reconcile does not write
   * back values that are already there.
   *
   * THE ORIGIN IS WHY THIS EXISTS. Resuming the give-up instant alone leaves the
   * ceiling in-memory, and an install that restarts inside a long outage re-opens
   * a 24h run on every launch and never terminates — the invariant-5 violation
   * PLN-2028 closes. With the origin restored, a 28h outage spread over four 7h
   * processes reaches the give-up in the fourth, which no single process saw
   * enough of to decide on its own.
   *
   * An unreadable value adopts NOTHING for its own field rather than giving up on
   * the spot: a column `Date.parse` cannot read is not evidence that anything
   * waited, which is exactly how `laneStallWindow` treats an unreadable run
   * origin.
   *
   * A value AHEAD of the clock — a corrupt row, or a backwards clock jump after
   * the run was written — is normalized to `nowMs` and the row is REPAIRED.
   * Adopting it as-is would leave the lane terminal with an unreachable widening
   * window for as long as the skew lasted, since a window measured from a future
   * anchor never elapses; only the event door would remain, and that door is the
   * one the window arm exists because we cannot count on.
   */
  adoptPersisted(
    sourceKey: string,
    persisted: PersistedLaneRunRead | null | undefined,
    nowMs: number
  ): void {
    const read = readLaneRunRecord(
      persisted ?? {},
      SyncLane.ComponentInventory,
      nowMs
    );
    for (const note of laneRunDefectNotes(read, persisted)) {
      this.options.diag.note("warn", note.name, note.message);
    }
    // The believed COLUMN values are the raw instants, never the normalized
    // anchors: that divergence is what makes the repair below a genuine write
    // rather than an equality-gated no-op. The producer is the RESOLVED one, so a
    // legacy row whose producer column is NULL (PLN-2028 D3) is not rewritten
    // just to spell out what the lane already knows it must be.
    this.durableRun.adopt(sourceKey, {
      stalledSinceMs: read.origin.storedMs,
      gaveUpAtMs: read.giveUp.storedMs,
      reason: read.reason,
      source: read.source,
    });
    // ISS-10043: only a producer whose give-up is LANE-wide may become a gate
    // hold. A row-ceiling stamp says individual rows exhausted their own budgets,
    // and holding the whole lane for it is the bounce. This lane writes none at
    // all (`produces: false`), so such a value is a corrupt or foreign row: the
    // origin still resumes, and the lane re-derives its own give-up from its own
    // gate rather than inheriting one it never made.
    const resumedGiveUpAtMs = laneRunResumesHold(
      SyncLane.ComponentInventory,
      read.source
    )
      ? read.giveUp.atMs
      : null;
    const adopted = this.options.gate.hydrateRun(
      { stalledSinceMs: read.origin.atMs, gaveUpAtMs: resumedGiveUpAtMs },
      nowMs
    );
    // PLN-2028 D4 governs everything a hydration touches, not only the gate. A
    // gate that REFUSED the record is still holding the run THIS process saw, so
    // taking the row's cause beside it would blank the reason for a give-up the
    // lane is still holding — and the next reconcile would write that null cause
    // onto the row. Reachable without a restart: a give-up whose persist failed
    // leaves the columns clear while `hydratedSourceKey` goes null, and the
    // re-armed tick re-enters hydration against a row that has no give-up on it
    // (marisolashgrove review). That is the ISS-9963 silence arriving through the
    // hydration door instead of the restart door.
    if (adopted) {
      this.takeResumedGiveUp(resumedGiveUpAtMs, read.reason, read.source);
    }
    if (
      read.origin.defect === LaneGiveUpStampDefect.Future ||
      read.giveUp.defect === LaneGiveUpStampDefect.Future
    ) {
      this.reconcile(sourceKey);
    }
  }

  /**
   * Hold the give-up a hydration just handed this process — its cause, and the
   * announcement it owes.
   *
   * ISS-9418: this process is now HOLDING a give-up it never saw happen, and it
   * has to be able to say so. The announcement is keyed off the held give-up, and
   * the re-arm is suppressed for a lane whose give-up was never announced — so a
   * relaunch that left this unset announced nothing for the rest of the hold AND
   * dropped the recovery that answered it, which is the whole outage reaching the
   * operator as silence.
   *
   * ISS-9963: the cause comes OFF THE ROW rather than being reported as unknown.
   * It is still `null` when the row cannot supply one — a legacy row written
   * before the column, or a value this build does not recognise — and that
   * absence is reported as absence, never guessed. Read the HOLD back off the
   * gate rather than from the record, so an unreadable or already-normalized
   * instant holds exactly what the gate accepted.
   */
  private takeResumedGiveUp(
    resumedGiveUpAtMs: number | null,
    reason: SyncReason | null,
    source: LaneGiveUpSource | null
  ): void {
    this.giveUpReason = resumedGiveUpAtMs === null ? null : reason;
    if (this.options.gate.giveUpStampMs() !== null) {
      this.heldGiveUp = { reason, source };
    }
  }

  /**
   * Bring the four columns into step with the gate. Writes only on a genuine
   * change — a healthy lane answers on every accepted batch and must not pay a
   * SQLite write for saying so again.
   *
   * The CALLER owns the precondition that the durable row has been consulted for
   * this key: the gate reads empty for a fresh identity, and writing that before
   * hydration would clobber a run the lane has not read yet.
   *
   * A cause and a producer are written ONLY beside a give-up. Enforced here
   * rather than trusted from the fields, because the same rule governs the read
   * (`readLaneRunRecord`) and a row that disagreed with it would let a later
   * process announce a give-up this lane is not holding.
   */
  reconcile(sourceKey: string): void {
    const gaveUpAtMs = this.options.gate.giveUpStampMs();
    this.durableRun.reconcile(sourceKey, {
      stalledSinceMs: this.options.gate.runOriginMs(),
      gaveUpAtMs,
      reason: gaveUpAtMs === null ? null : this.giveUpReason,
      source:
        gaveUpAtMs === null
          ? null
          : laneGateGiveUpSource(SyncLane.ComponentInventory),
    });
  }

  /**
   * Drop the identity - target switch, stop, or a hydration that could not reach
   * the durable row. That row belongs to a different (lane, target) pair.
   */
  clearIdentity(): void {
    this.durableRun.clearIdentity();
    this.heldGiveUp = null;
    this.giveUpReason = null;
    // ISS-9418: and what was ANNOUNCED about it. No `rearmed` is reported here -
    // the previous identity's outage did not end, this machine simply stopped
    // being the one collecting for it. Dropping the latch is still required, or
    // the new identity's first genuine give-up is swallowed as a duplicate of a
    // give-up that belonged to somebody else.
    clearSyncLaneGiveUpAnnouncement(SyncLane.ComponentInventory);
  }

  /**
   * ISS-9418: the TERMINAL gate for one tick. `true` means the lane must hold
   * it.
   *
   * It carries the give-up announcement's RE-ATTEMPT, because this is the only
   * thing that runs while the lane is held and that announcement is dropped
   * whenever the telemetry lane's send gate is shut - which is the same
   * connectivity loss that drove the run past its ceiling. See
   * {@link announceGiveUp}.
   *
   * It does NOT announce the re-arm, and that split is load-bearing: passing
   * this gate is not attempting. `sync.lane.rearmed` says the lane is collecting
   * again, so it belongs to {@link noteSendAttempt} at the send itself.
   */
  holdTick(nowMs: number): boolean {
    if (this.options.gate.isGivenUp(nowMs)) {
      this.announceGiveUp(this.options.gate.stallAgeMs(nowMs));
      return true;
    }
    if (this.options.gate.giveUpStampMs() === null) {
      // Never gave up, or the lane ANSWERED and the gate dropped the stamp with
      // the run. Either way nothing is held: keeping it would let a later send
      // announce a give-up the lane is no longer in.
      this.heldGiveUp = null;
      // And the cause goes with it, so the next reconcile cannot write a reason
      // beside a give-up that is no longer on record.
      this.giveUpReason = null;
    }
    return false;
  }

  /**
   * ISS-9418: the lane has cleared every gate and is COMMITTING to a send -
   * announce the recovery that belongs to that, once per transition.
   *
   * The announcement lives in this class rather than at the gate because the
   * gate's reads are deliberately pure - `isGivenUp` and `reArmTrigger` do not
   * clear the stamp, since the one attempt a re-arm buys belongs to the outcome
   * of that attempt and not to whoever asked. So neither can be an edge trigger.
   * This is where the transition from "holding" to "attempting" is seen while the
   * durable stamp is STILL ON RECORD: the stamp is dropped by `noteLaneAnswered`
   * from the send's outcome, which is strictly later than this.
   *
   * And it lives at the SEND rather than at {@link holdTick} because a tick that
   * passed the terminal gate can still attempt nothing. The PACING gate is a
   * different length - at a give-up the run is >=24h old, so the ladder is at its
   * 60min cap while the first re-arm window is 5min, which makes pacing the
   * longer of the two for the first four re-arms (see
   * `LaneEnvironmentalDeferGate.isDeferred`, "THE TWO COMPOSE AS A MAX") - and
   * past it a slow send can still hold the single-flight guard, the db-host
   * source can go null, and the cloud-sync tier or the compute target can close
   * mid-tick. `telemetry-category.ts` publishes the read "a give-up with no
   * re-arm is a lane that is still terminal right now", so announcing on a tick
   * that then returns tells an operator the lane is collecting while it is not,
   * AND releases the latch that would have carried the give-up. Waiting for the
   * send keeps that read true and makes `gaveUpForMs` the real held duration.
   *
   * `reportSyncLaneReArmed` is once-per-transition, so calling this before every
   * send is safe and is what keeps the caller free of edge detection.
   */
  noteSendAttempt(nowMs: number): void {
    const gaveUpAtMs = this.options.gate.giveUpStampMs();
    if (gaveUpAtMs === null) {
      // A healthy lane, which is nearly every send: there is no recovery to
      // report, and answering one would let it claim it came back from a state
      // it was never in.
      return;
    }
    // ISS-9418: the LAST chance to land the give-up half of the pair. A `rearmed`
    // is suppressed for a lane whose give-up was never announced, so if every
    // attempt made while held was dropped at a shut send gate and this attempt
    // SUCCEEDS, the whole outage would go unreported - the ordinary recovery,
    // since the event that re-arms the lane is often the same one that restores
    // delivery. A no-op once the give-up has landed.
    this.announceGiveUp(this.options.gate.stallAgeMs(nowMs));
    this.heldGiveUp = null;
    reportSyncLaneReArmed({
      lane: SyncLane.ComponentInventory,
      trigger: this.options.gate.reArmTrigger(nowMs),
      gaveUpForMs: Math.max(0, nowMs - gaveUpAtMs),
    });
  }

  /**
   * Announce the give-up this lane is holding - idempotent, and safe to call
   * from every tick and every send.
   *
   * `reportSyncLaneGaveUp` latches on ACCEPTANCE, so a repeat is free once the
   * event has landed and is a genuine re-attempt while the send gate is shut.
   *
   * THE ONE PLACE this event's shape is built. Both producers inside this class
   * differ only in where the duration comes from, and when they each built the
   * payload a field added to one was silently missing from the other - which is
   * how `deadLetteredCount` and the terminal wording both had to be hand-applied
   * twice in one change.
   *
   * `stalledForMs` is the CALLER's, because only the caller knows whether the
   * number it holds is a measurement: the held-tick path re-reads the run age
   * off the gate (the run origin is not reset by a re-give-up, so the current age
   * is what the field documents - "how long this install has been unable to
   * deliver"), and a `null` from either caller is "unmeasured" rather than zero.
   */
  private announceGiveUp(stalledForMs: number | null): void {
    if (this.heldGiveUp === null) {
      return;
    }
    reportSyncLaneGaveUp({
      lane: SyncLane.ComponentInventory,
      reason: this.heldGiveUp.reason,
      source: this.heldGiveUp.source,
      stalledForMs,
      itemsOwed: null,
      deadLetteredCount: null,
    });
  }

  /**
   * ISS-9418: announce a give-up this environmental failure caused.
   *
   * Driven by the state `noteEnvironmentalFailure` RETURNS, which is the only
   * place the decision is made - there is no separate announce path into the
   * gate, deliberately, because two ways to reach one piece of state is two
   * copies that can disagree about the stamp.
   *
   * `itemsOwed` and `deadLetteredCount` are `null` and not `0`: this lane has no
   * row queue at all, only a cursor position, so either count would be a
   * fabricated measurement on the exact event that says collection stopped.
   *
   * The duration is this failure's run age, EXCEPT when the failure opened the
   * run it is reporting. A relaunch inside an outage hydrates the give-up stamp
   * without a run origin, so the first failure after it opens a fresh window and
   * `elapsedMs` is `0` while the give-up is genuinely >24h old - the state that
   * made this event say "GAVE UP after 0min" for an install that had been unable
   * to deliver for a day. `opened` is exactly that case (a continued run is
   * measured from a real anchor), so it reports the duration as unmeasured
   * instead of as an instant.
   */
  noteEnvironmentalOutcome(
    state: LaneEnvironmentalDeferState,
    reason: SyncReason
  ): void {
    if (!state.givenUp) {
      return;
    }
    // Held for the re-attempt `holdTick` makes on every later tick that is still
    // holding: this announcement is the one most likely to be dropped, because
    // the send gate is shut by the same outage that produced the give-up.
    this.heldGiveUp = {
      reason,
      source: laneGateGiveUpSource(SyncLane.ComponentInventory),
    };
    // ISS-9963: and recorded durably beside the stamp, so the process that
    // resumes this give-up can say what it was rather than reporting silence.
    this.giveUpReason = reason;
    this.announceGiveUp(state.opened ? null : state.elapsedMs);
  }

  /**
   * ISS-10910 (whitlockk review), ISS-11389: a local store read failed. An
   * unreadable DB is lane-wide, so it charges the environmental run (pacing and
   * the 24h give-up) and no item budget (`main/sync/AGENTS.md` invariants 4
   * and 5).
   *
   * Charged only while `isCurrent` holds — the caller's identity check, for the
   * reason every other charge site in the lane has one (invariant 2).
   */
  noteLocalReadFailed(nowMs: number, isCurrent: () => boolean): void {
    if (!isCurrent()) {
      return;
    }
    this.noteEnvironmentalOutcome(
      this.options.gate.noteEnvironmentalFailure(nowMs),
      SyncReason.LocalReadFailed
    );
  }

  /**
   * {@link adoptPersisted} for the row's FIRST read since the gate was last
   * reset — the caller's precondition.
   *
   * Any run the gate holds then opened before the row was consulted (failed
   * reads of it, or sends while the source was down), so D4's "the row can only
   * lag" does not hold for it: the row may carry an older origin or a give-up.
   * That run is dropped so the row is adopted, and re-opened at its own origin
   * only when the row held neither. A give-up this process reached stays (D4).
   */
  adoptFirstRead(
    sourceKey: string,
    persisted: PersistedLaneRunRead | null | undefined,
    nowMs: number
  ): void {
    const gate = this.options.gate;
    const unreadRunOrigin =
      gate.giveUpStampMs() === null ? gate.runOriginMs() : null;
    if (unreadRunOrigin !== null) {
      gate.reset();
    }
    this.adoptPersisted(sourceKey, persisted, nowMs);
    if (unreadRunOrigin !== null) {
      // Refused when the row supplied a run or a give-up, which then stands.
      gate.hydrateRun(
        { stalledSinceMs: unreadRunOrigin, gaveUpAtMs: null },
        nowMs
      );
    }
  }
}
