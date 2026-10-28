/**
 * @file lane-give-up.ts
 * @description ISS-9418 (PRD-699 Appendix A): what a lane DOES when its
 * environmental wall clock runs out, as pure functions over
 * `{stalledSinceMs, gaveUpAtMs, nowMs}`.
 *
 * `lane-stall-clock.ts` answers "has this run outlived the ceiling". Nothing
 * answered what happens NEXT, so the standard's "→ lane give-up" had no
 * definition anywhere in the codebase and `sync_abandoned` existed only in two
 * comments. Invariant 5 requires every bound to end "in a terminal path with a
 * recovery door", and a bound whose terminal path is undefined is not a bound.
 *
 * Three questions, matching the three the stall clock asks:
 *
 * 1. Has the run crossed the ceiling? — {@link laneGiveUpReached}
 * 2. What is the lane's give-up state, and what stamp should it persist? —
 *    {@link laneGiveUpState}
 * 3. Has a given-up lane earned another attempt? — {@link laneReArmed}
 *
 * The ceiling itself is NOT re-declared here. {@link laneGiveUpReached}
 * delegates to the `WallClock` arm of `sync-retry-budget.ts` through
 * `laneStallBudget`, so the give-up instant is the same one the stall clock
 * already computes — a second 24h literal would be two lanes measuring one
 * outage and disagreeing about when it ended.
 *
 * NO LANE STATE LIVES HERE. The stateful wrapper is
 * `main/sync/lane-environmental-defer.ts`, which is what actually holds a run
 * and now terminates one. Keeping the decision pure is what lets the same shape
 * serve a lane with a durable column, a lane with an in-memory clock, and a
 * test — the same reason `laneStallWindow` reports the run a caller should
 * persist rather than starting one itself.
 *
 * Node-free and dependency-free beyond its two `shared/` siblings.
 */

import { exponentialBackoffMs } from "./exponential-backoff.js";
import {
  DEFAULT_LANE_STALL_SCHEDULE,
  type LaneStallSchedule,
  laneStallBudget,
} from "./lane-stall-clock.js";
import { isSyncRetryBudgetSpent } from "./sync-retry-budget.js";

/** What a lane knows about its current environmental run and its give-up. */
export type LaneGiveUpInput = {
  /**
   * When the current unbroken environmental run opened, or `null` when the lane
   * has no run on record. `null` is UNKNOWN, never zero — an unknown origin has
   * not spent anything, exactly as `SyncRetryBudgetState.originMs` says.
   */
  stalledSinceMs: number | null;
  /**
   * The instant this lane gave up, or `null` when it has not. Read back from
   * the durable stamp on a relaunch, which is the whole reason the stamp is
   * durable: an in-memory ceiling never fires for a desktop that keeps
   * restarting inside an outage.
   */
  gaveUpAtMs: number | null;
  nowMs: number;
  schedule?: LaneStallSchedule;
};

/** Where a lane stands with respect to its terminal path. */
export type LaneGiveUpState = {
  /** Whether the lane is in the give-up state right now. */
  givenUp: boolean;
  /**
   * The instant the give-up is anchored to — the value the caller should
   * persist. An already-recorded stamp is returned UNCHANGED: re-stamping it at
   * the instant of the next failure would hand a permanently-broken lane a
   * fresh window on every attempt, which is the durable-column version of the
   * unbounded retry this whole file exists to end. `null` when not given up.
   */
  gaveUpAtMs: number | null;
  /**
   * How long the lane has been given up, never negative. Zero when it has not
   * given up — not a fabricated duration, because {@link givenUp} is what says
   * whether this number means anything.
   */
  elapsedMs: number;
};

/**
 * Why a given-up lane earned another attempt. Reported rather than collapsed to
 * a boolean so the caller (and, once ISS-9418's telemetry half lands, the
 * operator) can tell a precondition that genuinely changed from a window that
 * merely elapsed — the two say different things about whether the world is
 * fixed.
 */
export const LaneReArmTrigger = {
  /**
   * A precondition the lane was blocked on changed: sign-in / identity change,
   * compute-target change. The identity half is the seam
   * `wireAuthSessionLaneRecovery` owns.
   */
  Event: "event",
  /**
   * The widening time window elapsed with no event at all. Without this arm a
   * laptop that loses access for two days and regains it — no sign-in, no org
   * policy change, no target switch — stays given up until the process
   * restarts, which is a terminal state with no reachable recovery door and
   * exactly the invariant-5 violation PRD-699 exists to end.
   */
  Window: "window",
} as const;
export type LaneReArmTrigger =
  (typeof LaneReArmTrigger)[keyof typeof LaneReArmTrigger];

/** What a lane knows when it asks whether a give-up may be cleared. */
export type LaneReArmInput = {
  /** The give-up stamp, or `null` when the lane never gave up. */
  gaveUpAtMs: number | null;
  /**
   * How many times this lane has given up in the current unbroken outage,
   * 1-indexed at the first give-up. Drives the widening window so a lane that
   * keeps re-tripping the same failure backs off toward the cap instead of
   * re-attempting on the floor forever.
   *
   * In-memory and process-scoped by design, re-deriving from the floor on a
   * cold restart — the same shape FEA-3795's `deadLetterCountById` uses, and
   * for the same reason: the DURABLE record is what guarantees an eventual
   * path, while the escalation position is a politeness the next launch may
   * safely forget.
   */
  giveUpCount: number;
  nowMs: number;
  /** True when a precondition-change event fired since the give-up. */
  eventFired: boolean;
  schedule?: LaneStallSchedule;
};

/**
 * Has the current environmental run outlived its ceiling — i.e. may the lane
 * take its terminal path?
 *
 * Delegates wholesale to the `WallClock` arm of the shared budget table, which
 * is what keeps this file free of a second 24h constant and free of a second
 * spelling of the comparison. An unknown or unreadable `stalledSinceMs` is
 * never spent (the budget's own rule), so a column that failed to parse gives
 * up on nothing.
 */
export function laneGiveUpReached(input: LaneGiveUpInput): boolean {
  return isSyncRetryBudgetSpent(
    laneStallBudget(input.schedule ?? DEFAULT_LANE_STALL_SCHEDULE),
    {
      attemptCount: 0,
      originMs: input.stalledSinceMs,
      nowMs: input.nowMs,
    }
  );
}

/**
 * The lane's give-up state, and the stamp it should persist.
 *
 * A stamp ALREADY on record wins over a freshly-reached ceiling: the give-up is
 * anchored to when the lane first gave up, not to when it last noticed. That is
 * what makes {@link laneReArmed}'s window measure the give-up rather than the
 * attempt, and it is the same anchor discipline `confirmStallClockWrites` keeps
 * for the stall clock.
 *
 * A FUTURE stamp (local clock skew, or one written by a machine running ahead)
 * is NORMALIZED to `nowMs` and RETURNED that way, so the caller persists the
 * corrected value — the same treatment `laneStallWindow` gives a future run
 * origin, and for the same reason. Clamping only the elapsed READING is not
 * equivalent, and was the defect here: the raw stamp stayed on record, and an
 * anchor that re-clamps to each fresh `nowMs` measures zero elapsed forever, so
 * the widening window never elapses and the lane sits terminal with only its
 * event door left. That is invariant 5 failing by arithmetic rather than by
 * omission.
 */
export function laneGiveUpState(input: LaneGiveUpInput): LaneGiveUpState {
  const recorded = input.gaveUpAtMs;
  const readable = recorded !== null && Number.isFinite(recorded);
  if (readable) {
    const anchoredMs = Math.min(recorded, input.nowMs);
    return {
      givenUp: true,
      gaveUpAtMs: anchoredMs,
      elapsedMs: Math.max(0, input.nowMs - anchoredMs),
    };
  }
  if (!laneGiveUpReached(input)) {
    return { givenUp: false, gaveUpAtMs: null, elapsedMs: 0 };
  }
  return { givenUp: true, gaveUpAtMs: input.nowMs, elapsedMs: 0 };
}

/**
 * How long a lane waits after its `giveUpCount`-th give-up before the window
 * arm re-arms it: the schedule's floor doubling to its ceiling — 5, 10, 20, 40
 * minutes … capped at 24h on the default schedule.
 *
 * Deliberately the SAME two numbers the stall schedule already carries, rather
 * than a third pair: the session lane's FEA-3795 dead-letter window is 5min
 * doubling to a 24h cap, and a component lane that re-arms on a different
 * ladder would mean two lanes measuring one outage and disagreeing about when
 * it is worth retrying. `DEAD_LETTER_RETRY_BASE_MS` / `DEAD_LETTER_RETRY_MAX_MS`
 * are the session lane's spelling of these values and live in main-process
 * policy; importing them into `shared/` would invert the dependency, so the
 * schedule this file already takes supplies them instead.
 */
export function laneReArmDelayMs(
  giveUpCount: number,
  schedule: LaneStallSchedule = DEFAULT_LANE_STALL_SCHEDULE
): number {
  return exponentialBackoffMs(
    giveUpCount,
    schedule.floorMs,
    schedule.ceilingMs
  );
}

/**
 * Which trigger, if any, has re-armed a given-up lane — the predicate for
 * clearing the stamp.
 *
 * Returns `null` for a lane that never gave up: there is nothing to clear, and
 * answering a trigger there would let a healthy lane report a recovery it never
 * needed.
 *
 * An event OUTRANKS the window when both hold, because it is the stronger claim:
 * the window only says time passed, while the event says the precondition the
 * lane was blocked on actually changed.
 *
 * Re-arming buys exactly ONE attempt. Nothing here grants more than that — the
 * caller re-stamps on the next environmental failure, so a permanently-broken
 * corpus cannot churn on every launch (the churn `redriveOnStart`'s
 * harness+prefix scoping was added to avoid).
 */
export function laneReArmed(input: LaneReArmInput): LaneReArmTrigger | null {
  const recorded = input.gaveUpAtMs;
  if (recorded === null || !Number.isFinite(recorded)) {
    return null;
  }
  if (input.eventFired) {
    return LaneReArmTrigger.Event;
  }
  const schedule = input.schedule ?? DEFAULT_LANE_STALL_SCHEDULE;
  // Defence only. A future stamp is normalized where it is READ
  // ({@link readLaneGiveUpStamp}) and where a gate hydrates it, because a clamp
  // applied HERE cannot fix one: the anchor would move with every fresh `nowMs`
  // and the window would measure zero elapsed forever. This keeps a negative
  // elapsed out of the comparison for a caller holding a raw stamp.
  const elapsedMs = Math.max(0, input.nowMs - Math.min(recorded, input.nowMs));
  // The count is 1-indexed at the first give-up; a non-positive or non-finite
  // one reads as the first, which is what `exponentialBackoffMs` clamps to. That
  // direction is the safe one here: it re-arms SOONER, and a re-arm only ever
  // buys one attempt.
  const count = Number.isFinite(input.giveUpCount) ? input.giveUpCount : 1;
  if (elapsedMs >= laneReArmDelayMs(count, schedule)) {
    return LaneReArmTrigger.Window;
  }
  return null;
}

/** Why a persisted `lane_gave_up_at` could not be taken at face value. */
export const LaneGiveUpStampDefect = {
  /** `Date.parse` could not read it. Adopts nothing. */
  Unreadable: "unreadable",
  /** It is ahead of the clock. Normalized to `nowMs`. */
  Future: "future",
} as const;
export type LaneGiveUpStampDefect =
  (typeof LaneGiveUpStampDefect)[keyof typeof LaneGiveUpStampDefect];

/** A persisted `lane_gave_up_at`, read into the anchor a lane may hold. */
export type LaneGiveUpStampRead = {
  /** The anchor to hydrate, or `null` to adopt nothing. */
  gaveUpAtMs: number | null;
  /**
   * What the COLUMN holds, in milliseconds — the raw parsed value, which for a
   * normalized stamp differs from {@link gaveUpAtMs}. `null` when unreadable.
   * A caller tracking the durable row adopts THIS, so a repair write is a real
   * change rather than an equality-gated no-op.
   */
  storedMs: number | null;
  /** What was wrong with the stored value, or `null` when nothing was. */
  defect: LaneGiveUpStampDefect | null;
};

/**
 * Read a persisted `lane_gave_up_at` into the anchor a lane may hold.
 *
 * ONE copy of this on purpose: every adopting lane parses the same column, and
 * "what counts as a usable stamp" drifting between them is the SSOT-by-copy
 * defect this repo keeps paying for.
 *
 * Two ways a stored value is not a measurement, and they do NOT get the same
 * answer:
 *
 * - Unreadable → `null`, adopting nothing. A column `Date.parse` cannot read is
 *   not evidence that anything waited, exactly as `laneStallWindow` treats an
 *   unreadable run origin. The lane resumes attempting and re-stamps if the
 *   outage is still on.
 * - Future → normalized to `nowMs`, not dropped. A give-up is something that
 *   HAPPENED, so a stamp ahead of the clock is a corrupt row or a backwards
 *   clock jump — but both readings still agree the lane DID give up, and
 *   dropping it would re-open a fresh 24h run on every launch for as long as
 *   the skew lasted, which is what the durable column exists to stop.
 *
 * Normalizing ONCE, at the read, is the whole point. A clamp applied on each
 * later comparison cannot fix a future anchor: it would move forward with the
 * clock, so the widening re-arm window would measure zero elapsed forever and
 * the lane would sit terminal with only its event door — invariant 5's recovery
 * door removed by arithmetic rather than by omission.
 */
export function readLaneGiveUpStamp(
  laneGaveUpAt: string | undefined,
  nowMs: number
): LaneGiveUpStampRead {
  const parsedMs = laneGaveUpAt ? Date.parse(laneGaveUpAt) : Number.NaN;
  if (!Number.isFinite(parsedMs)) {
    return {
      gaveUpAtMs: null,
      storedMs: null,
      // An ABSENT column is not a defect: it is the ordinary state of a lane
      // that never gave up, and reporting it would make every healthy hydration
      // look like a corrupt row.
      defect: laneGaveUpAt ? LaneGiveUpStampDefect.Unreadable : null,
    };
  }
  if (parsedMs > nowMs) {
    return {
      gaveUpAtMs: nowMs,
      storedMs: parsedMs,
      defect: LaneGiveUpStampDefect.Future,
    };
  }
  return { gaveUpAtMs: parsedMs, storedMs: parsedMs, defect: null };
}
