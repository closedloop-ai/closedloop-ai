/**
 * @file lane-environmental-defer.ts
 * @description PRD-699 F8 / ISS-8615: the lane-level environmental defer gate —
 * how a lane paces itself while the WORLD is broken, over the shared pure
 * primitives in `shared/lane-stall-clock.ts`.
 *
 * The component-inventory sweep had no answer to this at all. It pauses on a
 * `LaneFailure` "without advancing the cursor or charging the dead-letter
 * budget" — correct per invariant 4 — and then re-sent the identical batch on
 * the very next 5s tick, forever. That is the shape PRD-699 F8 names: an environmental class exempted from the retry budget and
 * left with no backoff at all, so a 401 or a 5xx becomes a request storm against
 * a cloud that is already failing.
 *
 * The gate is deliberately PER-LANE, not per-row, and that is the same claim the
 * classification standard makes: an environmental failure means every item would
 * fail identically, so there is nothing to schedule per row. One clock per lane
 * is also what keeps this free of the bounded-map problem invariant 10 exists
 * for — there is no id-keyed state here to grow.
 *
 * IT ALSO TERMINATES, since ISS-9418. It used to pace a run without ever ending
 * one, and said so here: invariant 5's terminal path needs a clock that survives
 * a relaunch, `main/sync/AGENTS.md` is explicit that an in-memory one is not a
 * substitute ("a desktop that keeps restarting inside a long outage would never
 * reach the terminal path"), and neither adopting lane had a durable column to
 * hang one on. Migration 0082 supplies it: `sync_state.lane_gave_up_at`, one row
 * per (lane, compute target) under each lane's own `source_key` prefix. So a
 * ceiling reached here is stamped, survives the relaunch, and is REACHABLE — a
 * gate given a durable stamp by its owner ({@link
 * LaneEnvironmentalDeferGate.hydrateGiveUp}) resumes the give-up rather than
 * restarting the run.
 *
 * WHAT IT STILL DOES NOT DO: decide what a given-up lane owes its items. Owed
 * items are never charged at the ceiling — an environmental give-up is not
 * item-attributable (invariant 4), and dead-lettering owed rows because the
 * world was broken is the ISS-6883 / ISS-7730 defect class that lost 40,634
 * events. What the terminal state MEANS per lane stays the lane's: the component
 * sweep stops and leaves its cursor where it is, while the session lane keeps its
 * existing recoverable per-row dead-letter (that dead-letter is what releases the
 * watermark) and carries this stamp alongside it.
 *
 */

import {
  type LaneGiveUpState,
  type LaneReArmTrigger,
  laneGiveUpState,
  laneReArmed,
} from "../../shared/lane-give-up.js";
import {
  DEFAULT_LANE_STALL_SCHEDULE,
  type LaneStallSchedule,
  laneStallDelayMs,
  laneStallWindow,
} from "../../shared/lane-stall-clock.js";

/** Where a lane stands in its current environmental run, after one failure. */
export type LaneEnvironmentalDeferState = {
  /** When the current unbroken environmental run opened. */
  stalledSinceMs: number;
  /** How long it has been open. */
  elapsedMs: number;
  /** The earliest instant the lane may attempt again. */
  nextAttemptAtMs: number;
  /** Whether this failure OPENED the run rather than continuing one. */
  opened: boolean;
  /**
   * ISS-9418: whether this failure put the lane into the GIVE-UP state — the
   * ceiling was crossed, or a re-armed lane spent its one attempt and failed
   * again.
   *
   * `gaveUpAtMs` is the stamp the owner must persist; it is the instant of the
   * FIRST give-up in this run, not of the failure that noticed it, so the re-arm
   * window measures the give-up rather than the attempt.
   */
  givenUp: boolean;
  /** The give-up stamp to persist, or `null` when the lane has not given up. */
  gaveUpAtMs: number | null;
};

/**
 * One lane's environmental backoff clock.
 *
 * Stateful by necessity — the run origin has to outlive a single failure — but
 * every decision it makes is delegated to the pure functions, so the schedule
 * itself stays testable without one of these.
 *
 * Scope it to the lane's IDENTITY, not to the process: an account or
 * compute-target switch is a different lane and must not inherit a run
 * (`main/sync/AGENTS.md` invariant 2). {@link reset} is that hook.
 */
export class LaneEnvironmentalDeferGate {
  private stalledSinceMs: number | null = null;

  private nextAttemptAtMs = 0;

  /** ISS-9418: the durable give-up stamp, or `null` when the lane has not. */
  private gaveUpAtMs: number | null = null;

  /**
   * ISS-9418: how many times this lane has given up in the current unbroken
   * outage, 1-indexed at the first. Drives the widening re-arm window so a lane
   * that keeps re-tripping the same failure backs off toward the 24h cap instead
   * of re-attempting on the 5-minute floor forever.
   *
   * In-memory and process-scoped, re-deriving from the floor on a cold restart —
   * the FEA-3795 `deadLetterCountById` shape, for the FEA-3795 reason: the
   * DURABLE stamp is what guarantees an eventual path, while the escalation
   * position is a politeness the next launch may safely forget. Making it
   * durable would mean a second column recording nothing a user or an operator
   * can act on.
   */
  private giveUpCount = 0;

  /**
   * ISS-9418: true once a precondition-change event bought this lane its ONE
   * post-give-up attempt, until that attempt is spent.
   *
   * The stamp is deliberately NOT cleared by the event. Clearing it would let
   * the next failure open a fresh 24h run, so a permanently-broken corpus would
   * churn a full ceiling on every sign-in — the churn `redriveOnStart`'s
   * harness+prefix scoping was added to avoid. Holding the stamp and flagging
   * the credit instead is what makes "a failure re-stamps immediately" true.
   */
  private eventReArmed = false;

  private readonly schedule: LaneStallSchedule;

  constructor(schedule: LaneStallSchedule = DEFAULT_LANE_STALL_SCHEDULE) {
    this.schedule = schedule;
  }

  /**
   * Charge one ENVIRONMENTAL failure: open the run if none is in progress, then
   * schedule the next attempt off the run's age.
   *
   * Keyed off the run clock and never off an attempt count, because the count is
   * exactly what invariant 4 forbids this class from advancing — a delay derived
   * from a frozen counter would not move.
   *
   * `retryAfterMs` is honored as a MINIMUM (never scheduling earlier than the
   * server asked), which is why the shared helper takes `max` and not `min`.
   */
  noteEnvironmentalFailure(
    nowMs: number,
    retryAfterMs?: number
  ): LaneEnvironmentalDeferState {
    const window = laneStallWindow({
      stalledSinceMs: this.stalledSinceMs,
      nowMs,
      schedule: this.schedule,
    });
    this.stalledSinceMs = window.startedAtMs;
    this.nextAttemptAtMs =
      nowMs +
      laneStallDelayMs({
        stalledSinceMs: window.startedAtMs,
        nowMs,
        retryAfterMs,
        schedule: this.schedule,
      });
    const giveUp = this.foldGiveUp(nowMs);
    return {
      stalledSinceMs: window.startedAtMs,
      elapsedMs: window.elapsedMs,
      nextAttemptAtMs: this.nextAttemptAtMs,
      opened: window.opened,
      givenUp: giveUp.givenUp,
      gaveUpAtMs: giveUp.gaveUpAtMs,
    };
  }

  /**
   * ISS-9418: fold ONE environmental failure into the give-up state.
   *
   * Two ways in, and they must stay distinguishable:
   *
   * - The run crossed the ceiling for the first time — {@link laneGiveUpState}
   *   says so, and the stamp is the instant it noticed.
   * - The lane was ALREADY given up and had been re-armed, so this failure spent
   *   its one attempt. Re-stamp at `nowMs` and widen the window. Re-stamping is
   *   what stops a re-arm from buying more than the single attempt it is
   *   documented to buy.
   *
   * A failure while given up and NOT re-armed changes nothing: the lane should
   * not have attempted at all, and quietly widening the window for an attempt
   * the gate did not authorize would make the ladder a function of the caller's
   * tick rate rather than of the outage — the exact accident-of-pacing the
   * wall-clock budget exists to remove.
   */
  private foldGiveUp(nowMs: number): LaneGiveUpState {
    if (this.gaveUpAtMs !== null) {
      if (this.eventReArmed || this.windowReArmed(nowMs)) {
        this.gaveUpAtMs = nowMs;
        this.giveUpCount += 1;
        this.eventReArmed = false;
      }
      return { givenUp: true, gaveUpAtMs: this.gaveUpAtMs, elapsedMs: 0 };
    }
    const state = laneGiveUpState({
      stalledSinceMs: this.stalledSinceMs,
      gaveUpAtMs: null,
      nowMs,
      schedule: this.schedule,
    });
    if (state.givenUp) {
      this.gaveUpAtMs = state.gaveUpAtMs;
      this.giveUpCount = 1;
      this.eventReArmed = false;
    }
    return state;
  }

  /** Has the widening time window re-armed this give-up? */
  private windowReArmed(nowMs: number): boolean {
    return (
      laneReArmed({
        gaveUpAtMs: this.gaveUpAtMs,
        giveUpCount: this.giveUpCount,
        nowMs,
        eventFired: false,
        schedule: this.schedule,
      }) !== null
    );
  }

  /**
   * The lane ANSWERED — end the run and clear the backoff.
   *
   * Both a success and a row-attributable rejection count: a server that judged
   * these bytes was reachable enough to judge them, which is proof the world is
   * no longer the problem. This mirrors the session lane's `noteLaneAnswered`
   * and the transcript lane's `CLEARED_LANE_STALL`, and it is what makes the run
   * "the CURRENT unbroken run" rather than "every failure since boot".
   */
  noteLaneAnswered(): void {
    this.stalledSinceMs = null;
    this.nextAttemptAtMs = 0;
    // ISS-9418: the give-up goes with the run. The server answered, so the world
    // is demonstrably no longer the problem — keeping the stamp would leave a
    // recovered lane in a terminal state, and keeping the escalation count would
    // make the NEXT outage's first re-arm wait on a ladder the previous one
    // climbed.
    this.gaveUpAtMs = null;
    this.giveUpCount = 0;
    this.eventReArmed = false;
  }

  /**
   * ISS-9418: adopt a give-up stamp read back from the durable column.
   *
   * This is what makes the ceiling survive a relaunch, which is the whole reason
   * the column exists: an in-memory clock restarts on every launch, so a desktop
   * that keeps restarting inside a long outage never reaches the terminal path.
   *
   * Seeds the escalation count at the first rung, so a restart re-arms on the
   * schedule's floor rather than wherever the previous process had climbed to.
   * That is the FEA-3795 precedent and it errs toward retrying SOONER, which is
   * the safe direction — a re-arm only ever buys one attempt.
   *
   * A `null` adopts nothing, so a lane whose source has no stamp is unchanged.
   *
   * A stamp AHEAD of `nowMs` is normalized to `nowMs`. The gate owns the claim
   * that a give-up is always escapable and must not depend on its caller to keep
   * it: an anchor in the future makes {@link windowReArmed} measure zero elapsed
   * on every call, so the lane stays terminal with only its EVENT door — and
   * that door is precisely the one the window arm exists because we cannot count
   * on (a recovered outage with no sign-in, policy change, or target switch).
   */
  hydrateGiveUp(gaveUpAtMs: number | null, nowMs: number): void {
    if (gaveUpAtMs === null || !Number.isFinite(gaveUpAtMs)) {
      return;
    }
    this.gaveUpAtMs = Math.min(gaveUpAtMs, nowMs);
    this.giveUpCount = 1;
    this.eventReArmed = false;
  }

  /**
   * PLN-2028 (ISS-10053): adopt a whole durable lane RUN — the origin as well as
   * the give-up.
   *
   * The origin is what {@link hydrateGiveUp} alone cannot restore, and without it
   * the 24h ceiling is not merely delayed but UNREACHABLE for the install that
   * needs it most: a desktop restarting inside an outage opens a fresh run on
   * every launch, so a 28h outage spread over four 7h processes never accumulates
   * 24h of anything and the terminal path is never taken. Restoring the origin is
   * what lets the fourth process give up on an outage no single process saw the
   * whole of.
   *
   * PLN-2028 D4 — HYDRATION NEVER OVERRIDES WHAT THIS PROCESS SAW. A gate already
   * holding a run or a give-up ignores the record entirely, because the row can
   * only equal what this process knows or LAG it by a dropped write. Adopting a
   * stale row over a live run would move the ceiling backwards on a lane that is
   * currently failing.
   *
   * Answers WHETHER the record was adopted, because D4 governs more than the
   * gate: a lane also holds the give-up's cause and its announcement beside it,
   * and those have to obey the same refusal. Reported rather than left for the
   * caller to re-derive from {@link runOriginMs} and {@link giveUpStampMs} — a
   * second copy of this predicate is exactly how the two would drift.
   *
   * Pacing is deliberately left clear, so a relaunch gets ONE attempt rather than
   * resuming mid-rung. That attempt's failure schedules off the resumed age, and
   * gives up on the spot if the age is already past the ceiling.
   *
   * Each instant is clamped to `nowMs` for the reason {@link hydrateGiveUp}
   * clamps its stamp: a value ahead of the clock makes every elapsed reading
   * measure zero forever, which removes the widening recovery door by arithmetic.
   */
  hydrateRun(
    run: { stalledSinceMs: number | null; gaveUpAtMs: number | null },
    nowMs: number
  ): boolean {
    if (this.stalledSinceMs !== null || this.gaveUpAtMs !== null) {
      return false;
    }
    if (run.stalledSinceMs !== null && Number.isFinite(run.stalledSinceMs)) {
      this.stalledSinceMs = Math.min(run.stalledSinceMs, nowMs);
    }
    this.hydrateGiveUp(run.gaveUpAtMs, nowMs);
    return true;
  }

  /**
   * ISS-9418: a precondition this lane was blocked on changed — org-policy
   * transition, sign-in / identity change, compute-target change. Buy exactly
   * ONE attempt.
   *
   * A no-op when the lane never gave up: there is nothing to re-arm, and
   * answering here would let an ordinary event clear a healthy lane's backoff
   * and turn every sign-in into a licence to ignore the ladder.
   *
   * Also clears the pacing deadline, because the point of an event re-arm is
   * that the attempt happens NOW rather than at the end of a window that was
   * measuring a condition which has since changed.
   */
  noteRecoverySignal(): boolean {
    if (this.gaveUpAtMs === null) {
      return false;
    }
    this.eventReArmed = true;
    this.nextAttemptAtMs = 0;
    return true;
  }

  /**
   * ISS-8610: end the PACING window without touching the run or the give-up.
   *
   * {@link noteRecoverySignal} deliberately does nothing for a lane that has not
   * GIVEN UP — there is nothing to re-arm, and answering there would let an
   * ordinary event clear a healthy lane's backoff. But a lane merely PACING an
   * environmental run is blocked on the same precondition a recovery signal says
   * has changed, and it would otherwise sit out the rest of its current rung: a
   * user who just signed in waits up to the ladder's current delay for a lane
   * whose blocker demonstrably went away.
   *
   * Clearing the deadline and nothing else is what buys the one immediate
   * attempt while leaving the run's ORIGIN alone, so the ladder keeps measuring
   * the outage rather than the events that happened during it. A caller that
   * would fire this on every local tick would be defeating the ladder — pair it
   * with the same narrow seams {@link noteRecoverySignal} is wired to.
   */
  clearPacing(): void {
    this.nextAttemptAtMs = 0;
  }

  /**
   * ISS-9418: is this lane in the give-up state right now — i.e. must it stop
   * attempting?
   *
   * A pure read. It reports `false` once either recovery door has opened (an
   * event bought an attempt, or the widening window elapsed) and does NOT clear
   * the stamp: the clear belongs to the outcome of the attempt that follows, so
   * a failure can re-stamp immediately and a success can end the run through
   * {@link noteLaneAnswered}. A reader that mutated would spend the credit on
   * whoever happened to ask.
   */
  isGivenUp(nowMs: number): boolean {
    if (this.gaveUpAtMs === null) {
      return false;
    }
    if (this.eventReArmed) {
      return false;
    }
    return !this.windowReArmed(nowMs);
  }

  /**
   * The durable stamp this gate is holding, or `null` — what the owning lane
   * persists and what it clears. `null` is "not given up", never a fabricated
   * zero.
   */
  giveUpStampMs(): number | null {
    return this.gaveUpAtMs;
  }

  /**
   * PLN-2028: when the current environmental run opened, or `null` when none is
   * open — the other half of what the owning lane persists. `null` is "no run",
   * never a fabricated zero, exactly as {@link stallAgeMs} reports it.
   */
  runOriginMs(): number | null {
    return this.stalledSinceMs;
  }

  /**
   * Which door, if any, has re-armed this give-up right now. `null` when the
   * lane has not given up or is still inside its window. Reported rather than
   * folded into {@link isGivenUp} so a caller can say WHY it is attempting again
   * — a changed precondition and an elapsed window make different claims about
   * whether the world is fixed.
   */
  reArmTrigger(nowMs: number): LaneReArmTrigger | null {
    return laneReArmed({
      gaveUpAtMs: this.gaveUpAtMs,
      giveUpCount: this.giveUpCount,
      nowMs,
      eventFired: this.eventReArmed,
      schedule: this.schedule,
    });
  }

  /**
   * Is the lane still inside the backoff window it last scheduled?
   *
   * ISS-9418: this is the PACING gate and stays separate from
   * {@link isGivenUp}, which is the TERMINAL one. A caller holds its tick when
   * either says so; collapsing them would make a given-up lane look merely
   * deferred, which is what the give-up exists to stop being indistinguishable.
   *
   * THE TWO COMPOSE AS A MAX, and the crossover is worth knowing before reading
   * a give-up's early behaviour as a no-op. The ladder caps at
   * `LANE_STALL_MAX_RETRY_MS` (60 minutes) while the give-up window doubles from
   * `LANE_STALL_RETRY_FLOOR_MS` (5 minutes) without bound, so for the first four
   * re-arms the LADDER is the longer gate and the give-up changes no timing at
   * all; from the fifth on the give-up is longer and keeps widening to 24h.
   *
   * That is not the give-up being weak. Three of its four effects are there from
   * the first instant: it is DURABLE, so a relaunch resumes it instead of
   * restarting a 24h run the ladder cannot survive; it is what an operator can
   * observe and bound; and it is what the event door re-arms. The timing
   * divergence is the fourth, and it arrives on its own schedule.
   */
  isDeferred(nowMs: number): boolean {
    return this.stalledSinceMs !== null && nowMs < this.nextAttemptAtMs;
  }

  /**
   * How long an open run has been open, or `null` when none is — for a
   * diagnostic line. `null` is "no run", never a fabricated zero.
   */
  stallAgeMs(nowMs: number): number | null {
    if (this.stalledSinceMs === null) {
      return null;
    }
    return Math.max(0, nowMs - this.stalledSinceMs);
  }

  /** Drop the run wholesale — identity switch, or lane shutdown. */
  reset(): void {
    this.noteLaneAnswered();
  }
}
