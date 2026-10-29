/**
 * @file sync-retry-budget.ts
 * @description PRD-699 §7.3 (ISS-8615): the typed retry-budget table every
 * desktop→cloud sync lane bounds itself with, as ONE pure predicate over
 * `{state, now}`.
 *
 * `main/sync/AGENTS.md` invariants 4 and 5 are two halves of one rule: only a
 * ROW-ATTRIBUTABLE failure may exhaust a budget (4), and every retry path must
 * carry a bound whose terminal path stays reachable (5). The lanes already agree
 * on the rule and had four independent spellings of "has this row run out of
 * rope", each with its own clamps and its own way of failing open. This is the
 * one spelling. Lanes keep their own constants, their own classification, and
 * their own terminal paths — what they stop keeping is the comparison.
 *
 * The three arms are NOT interchangeable, and which one a lane picks follows
 * from what the failure is evidence OF:
 *
 * - {@link SyncRetryBudgetKind.Attempts} bounds an ITEM failure. These bytes are
 *   the problem, retrying them is pointless, and the budget exists only to
 *   survive a misclassification — so it is counted in tries and gated by
 *   `permanent`, which is invariant 4 stated as a type.
 * - {@link SyncRetryBudgetKind.WallClock} bounds an ENVIRONMENTAL failure. The
 *   world is broken and every row would fail identically, so counting tries
 *   measures the lane's tick rate rather than the outage: the same 8-hour outage
 *   is 5,760 attempts at a 5s tick or 12 on a ladder, which makes give-up timing
 *   an accident of pacing. The bound is elapsed time since the failure RUN
 *   opened (PRD-699 Appendix A; ISS-6883 and ISS-7730 are what charging counts
 *   during an outage cost — 40,634 events).
 * - {@link SyncRetryBudgetKind.Age} bounds a failure whose meaning DECAYS. The
 *   invocation lane's `session_missing` is an ordinary ordering race for a few
 *   minutes and a permanent orphan after three days, so it is budgeted from the
 *   row's own `created_at` and no number of transient failures can pre-spend it
 *   (ISS-5789).
 *
 * `Age` and `WallClock` perform the same subtraction and are deliberately still
 * two members: they read a different ORIGIN (the row's creation instant vs the
 * start of the current failure run), a lane reaching for the wrong one is a real
 * defect rather than a style choice, and an exhaustive `switch` over three named
 * members is what makes a fourth arm fail `tsc` instead of falling through a
 * default. `permanent` sits on the `Attempts` arm alone because the other two
 * exist precisely BECAUSE the failure is not attributable to the row — a
 * `permanent` flag there could only ever be `false`, and an inert field is a
 * field the next reader has to disprove.
 *
 * Node-free and import-free, beside `exponential-backoff.ts` and
 * `sync-lane-contract.ts`, for the reason those are: a lane vocabulary that the
 * main process holds today and a renderer-side reader could hold later without a
 * move. It decides nothing about SCHEDULING — that is `lane-stall-clock.ts`,
 * which composes this module's wall-clock arm rather than re-deriving it.
 */

/**
 * Which magnitude a budget is counted in. The member a lane picks is a claim
 * about what its failure means, not an implementation preference — see the file
 * header.
 */
export const SyncRetryBudgetKind = {
  Attempts: "attempts",
  Age: "age",
  WallClock: "wall_clock",
} as const;
export type SyncRetryBudgetKind =
  (typeof SyncRetryBudgetKind)[keyof typeof SyncRetryBudgetKind];

/**
 * One lane's bound on one failure class.
 *
 * Every magnitude is clamped by {@link isSyncRetryBudgetSpent} rather than
 * trusted, so a lane cannot lose its bound to a `0`, a negative, a fraction, or
 * a non-finite constant — see {@link clampBudgetMagnitude}.
 */
export type SyncRetryBudget =
  | {
      kind: typeof SyncRetryBudgetKind.Attempts;
      /**
       * Invariant 4, as a field: only a failure the lane attributes to the ROW
       * ITSELF may exhaust this budget. A lane-wide condition — auth loss,
       * transport error, rate limit, 5xx — must arrive here as `false`, or an
       * outage dead-letters healthy rows wholesale.
       */
      permanent: boolean;
      maxAttempts: number;
    }
  | { kind: typeof SyncRetryBudgetKind.Age; ageHorizonMs: number }
  | { kind: typeof SyncRetryBudgetKind.WallClock; ceilingMs: number };

/** What the lane knows right now, measured against a {@link SyncRetryBudget}. */
export type SyncRetryBudgetState = {
  /**
   * Attempts INCLUDING the failure being decided (post-increment), matching
   * `decideOutboxFailure`'s contract. Read only by the `Attempts` arm.
   */
  attemptCount: number;
  /**
   * The instant the budget is measured FROM — the row's `created_at` for `Age`,
   * the start of the current unbroken failure run for `WallClock`.
   *
   * `null` means UNKNOWN, not zero: a `lane_stalled_since` that `Date.parse`
   * could not read, or a run that has not opened yet. An unknown origin is never
   * spent — the lane starts a fresh run and stamps a readable origin over the
   * corrupt one, which is what `seedStallClock` already does for
   * `LaneStallClockAnomaly.Unreadable`. Seeding `NaN` instead would make every
   * later comparison `false` and remove the bound silently, which is the failure
   * this field's nullability exists to make impossible to write by accident.
   */
  originMs: number | null;
  nowMs: number;
};

/**
 * The floor every budget magnitude is clamped to: one attempt, one millisecond.
 *
 * A magnitude at or below zero, fractional, or non-finite is a programming error
 * — every caller passes a module constant — and the clamp picks the direction
 * that direction matters in. Failing toward the BOUND terminates the row on its
 * next failure: recoverable (every terminal path in these lanes keeps a recovery
 * door), monitored (a dead-letter is on the telemetry path), and loud enough to
 * surface in a test run. Failing the other way removes the bound entirely and is
 * invisible — an unbounded retry that looks exactly like a healthy backoff, and
 * the precise shape invariant 5 exists to forbid.
 */
export const SYNC_RETRY_BUDGET_FLOOR = 1;

/**
 * Clamp a budget magnitude to a usable positive integer, covering the whole
 * impossible set rather than the two that get remembered: non-finite (`NaN` from
 * a failed parse, `Infinity` from a bad expression), zero and negative, and
 * fractional. See {@link SYNC_RETRY_BUDGET_FLOOR} for why the clamp floors
 * rather than widens.
 */
function clampBudgetMagnitude(magnitude: number): number {
  if (!Number.isFinite(magnitude)) {
    return SYNC_RETRY_BUDGET_FLOOR;
  }
  return Math.max(SYNC_RETRY_BUDGET_FLOOR, Math.floor(magnitude));
}

/**
 * How long `state.originMs` has been open, or `null` when the origin is unknown.
 *
 * A FUTURE origin (local clock skew, or a stamp written by a machine running
 * ahead) is clamped to zero elapsed rather than left negative. A negative
 * elapsed makes the horizon unreachable for as long as the skew lasts, so the
 * row defers forever — the same silent unbounded retry the null case avoids,
 * arriving by arithmetic instead of by parse. Clamping reads it as "the run
 * started no later than now", which is the honest floor and is self-repairing on
 * the next stamp (`LaneStallClockAnomaly.Future` reports the same reading).
 */
function elapsedSinceOrigin(state: SyncRetryBudgetState): number | null {
  if (state.originMs === null || !Number.isFinite(state.originMs)) {
    return null;
  }
  if (!Number.isFinite(state.nowMs)) {
    return null;
  }
  return Math.max(0, state.nowMs - state.originMs);
}

/**
 * Has this budget run out — i.e. may the lane take its terminal path?
 *
 * Pure over `{budget, state}`, so a lane's give-up decision is testable without
 * a store, a clock, or a transport. It answers ONLY "is the rope gone"; what the
 * terminal path IS (dead-letter recoverably, quarantine, skip) stays the lane's,
 * because those are the vocabularies PLN-1562 recorded as a non-goal to merge.
 *
 * A `false` from the `Attempts` arm's `permanent` gate is not "budget remains" in
 * some weaker sense — it is invariant 4 refusing to let a lane-wide failure spend
 * a row's rope at all. Such a class needs a `WallClock` budget of its own, not a
 * relaxed attempts one; exempting a class from the ladder without replacing the
 * bound is how invariant 5 gets violated while looking like invariant 4
 * compliance.
 */
export function isSyncRetryBudgetSpent(
  budget: SyncRetryBudget,
  state: SyncRetryBudgetState
): boolean {
  switch (budget.kind) {
    case SyncRetryBudgetKind.Attempts: {
      if (!budget.permanent) {
        return false;
      }
      if (!Number.isFinite(state.attemptCount)) {
        return false;
      }
      return state.attemptCount >= clampBudgetMagnitude(budget.maxAttempts);
    }
    case SyncRetryBudgetKind.Age: {
      const elapsedMs = elapsedSinceOrigin(state);
      return (
        elapsedMs !== null &&
        elapsedMs >= clampBudgetMagnitude(budget.ageHorizonMs)
      );
    }
    case SyncRetryBudgetKind.WallClock: {
      const elapsedMs = elapsedSinceOrigin(state);
      return (
        elapsedMs !== null &&
        elapsedMs >= clampBudgetMagnitude(budget.ceilingMs)
      );
    }
    default: {
      // The backstop the file header promises. An if/else chain whose last
      // branch reads `budget.ceilingMs` would silently absorb a fourth arm that
      // happened to carry that field — the exact fall-through-a-default defect
      // this shape exists to make impossible.
      const unreachable: never = budget;
      throw new Error(`unmapped sync retry budget: ${String(unreachable)}`);
    }
  }
}

/**
 * How much of a time-based budget is left, in ms, or `null` when the origin is
 * unknown or the budget is counted in attempts.
 *
 * Separate from {@link isSyncRetryBudgetSpent} because a schedule needs the
 * REMAINDER, not the verdict: `lane-stall-clock.ts` caps a retry delay by it so
 * the next attempt can never land past the give-up instant, and the terminal
 * path is only ever evaluated when an attempt actually runs. The result goes
 * negative once the budget is spent and is deliberately not clamped to zero —
 * that distinction is what lets a caller stop capping past the ceiling instead
 * of scheduling a hot loop (see `laneStallDelayMs` in `lane-stall-clock.ts`).
 */
export function syncRetryBudgetRemainingMs(
  budget: SyncRetryBudget,
  state: SyncRetryBudgetState
): number | null {
  const elapsedMs = elapsedSinceOrigin(state);
  switch (budget.kind) {
    case SyncRetryBudgetKind.Attempts:
      return null;
    case SyncRetryBudgetKind.Age:
      return elapsedMs === null
        ? null
        : clampBudgetMagnitude(budget.ageHorizonMs) - elapsedMs;
    case SyncRetryBudgetKind.WallClock:
      return elapsedMs === null
        ? null
        : clampBudgetMagnitude(budget.ceilingMs) - elapsedMs;
    default: {
      const unreachable: never = budget;
      throw new Error(`unmapped sync retry budget: ${String(unreachable)}`);
    }
  }
}
