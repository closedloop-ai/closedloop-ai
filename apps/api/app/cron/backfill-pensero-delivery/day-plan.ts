import { toIsoDateOnly } from "@/lib/date-only";

/**
 * Which calendar days one organization's Pensero backfill asks for on this run
 * (ISS-8761).
 *
 * Pure: no clock of its own, no database, no provider. The caller supplies
 * "today" and the persisted cursors, and gets back an ordered day list. That
 * makes every day-boundary rule here testable without a fake provider, and it
 * is why the rules can be stated as literals in a test rather than re-derived
 * from this file.
 *
 * ## Three lanes, and why none of them can be dropped
 *
 * 1. **Today, always.** The current day is still accruing rows, so whatever we
 *    fetched for it an hour ago is already stale. It is refreshed every run and
 *    is governed by neither cursor.
 * 2. **Backward, forever.** `backwardCursor` is the oldest day already
 *    attempted; the walk continues strictly below it, one day at a time, with
 *    NO historical cutoff. There is no "far enough back" this code decides on
 *    an operator's behalf.
 * 3. **Recheck, round robin.** The delivery endpoint reports no completeness
 *    (see `SegmentCompleteness`), so an attempted day is never done. The
 *    recheck cursor walks the attempted range so every previously-attempted day
 *    is asked again over time, wrapping at the end.
 *
 * ## The per-run budget bounds WORK, never HISTORY
 *
 * `maxDays` caps how many days ONE invocation asks for, so a serverless ceiling
 * cannot truncate a run mid-write. Days it does not reach are not discarded —
 * they are simply not visited this run, and the cursors persist so the next run
 * resumes exactly where this one stopped. Nothing here caps total history, and
 * nothing here drops a remainder.
 */

const MS_PER_DAY = 86_400_000;

/** Why a planned day is being asked for. Carried into the ledger and metrics. */
export const BackfillDayReason = {
  /** The current day, refreshed on every run. */
  Today: "today",
  /** A day older than anything attempted before. */
  Backward: "backward",
  /** A previously-attempted day being asked again. */
  Recheck: "recheck",
} as const;
export type BackfillDayReason =
  (typeof BackfillDayReason)[keyof typeof BackfillDayReason];

/** One day this run will ask the provider for. */
export type PlannedBackfillDay = {
  /** UTC calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly reason: BackfillDayReason;
};

/** The persisted position of one organization's walk. */
export type BackfillCursors = {
  /** Oldest day attempted so far, `YYYY-MM-DD`, or null when none has been. */
  readonly backwardCursor: string | null;
  /** Round-robin position over attempted days, or null to start at the oldest. */
  readonly recheckCursor: string | null;
};

export type BackfillDayPlanInput = {
  /** The run's "today", supplied by the caller so nothing here reads a clock. */
  readonly today: Date;
  readonly cursors: BackfillCursors;
  /**
   * Days already attempted, ascending, `YYYY-MM-DD`. The recheck lane walks
   * exactly this set — it never invents a day nobody has asked for, because a
   * day with no attempt is the backward lane's job, not the recheck lane's.
   */
  readonly attemptedDays: readonly string[];
  /** Hard ceiling on days asked for in this run. Clamped at both ends. */
  readonly maxDays: number;
  /** How many of the run's budget go to the backward walk. Clamped at both ends. */
  readonly backwardDaysPerRun: number;
};

/** What this run will ask for, and what it is leaving for the next one. */
export type BackfillDayPlan = {
  readonly days: readonly PlannedBackfillDay[];
  /**
   * True when the budget stopped this run short of the lanes it could still
   * have served. NOT a truncation: the cursors carry the remainder, and the
   * next run resumes below/after them. It exists so a run that is permanently
   * budget-bound is visible rather than looking like a completed sweep.
   */
  readonly continuationPending: boolean;
};

/** Default days per run. Sized to stay well inside the route's 300s ceiling. */
export const DEFAULT_MAX_DAYS_PER_RUN = 14;

/** Default share of the run's budget spent walking backwards. */
export const DEFAULT_BACKWARD_DAYS_PER_RUN = 7;

/**
 * Plan one organization's days for one run.
 *
 * Today comes first so the freshest, most-read day is served even when the
 * budget is exhausted by the other two lanes; the backward walk comes next
 * because unexplored history is the lane that never finishes on its own; the
 * recheck lane spends whatever is left.
 */
export function planBackfillDays(input: BackfillDayPlanInput): BackfillDayPlan {
  const maxDays = clampPositive(input.maxDays, DEFAULT_MAX_DAYS_PER_RUN);
  const backwardBudget = Math.min(
    clampPositive(input.backwardDaysPerRun, DEFAULT_BACKWARD_DAYS_PER_RUN),
    maxDays
  );

  const today = toIsoDateOnly(input.today);
  const days: PlannedBackfillDay[] = [
    { day: today, reason: BackfillDayReason.Today },
  ];
  const planned = new Set<string>([today]);

  const backwardDays = planBackwardDays({
    today,
    backwardCursor: input.cursors.backwardCursor,
    budget: Math.min(backwardBudget, maxDays - days.length),
  });
  for (const day of backwardDays) {
    if (!planned.has(day)) {
      days.push({ day, reason: BackfillDayReason.Backward });
      planned.add(day);
    }
  }

  const recheckDays = planRecheckDays({
    attemptedDays: input.attemptedDays,
    recheckCursor: input.cursors.recheckCursor,
    excluded: planned,
    budget: maxDays - days.length,
  });
  for (const day of recheckDays) {
    days.push({ day, reason: BackfillDayReason.Recheck });
    planned.add(day);
  }

  return {
    days,
    continuationPending: days.length >= maxDays,
  };
}

/** One backward-lane day this run asked for, and whether the ask worked. */
export type BackwardDayAttempt = {
  readonly day: string;
  readonly succeeded: boolean;
};

/**
 * The new `backwardCursor`, given the BACKWARD LANE's attempts in walk order.
 *
 * The cursor advances over a CONTIGUOUS PREFIX of successes and stops dead at
 * the first failure. Anything else loses a day permanently: the backward lane
 * only ever plans days strictly OLDER than this cursor, so a cursor that moved
 * past a failed day means that day is never re-planned by this lane again —
 * a hole in the ledger wearing a green tick, which is the whole failure mode
 * this scheduler exists to avoid.
 *
 * TAKES BACKWARD ATTEMPTS ONLY, IN WALK ORDER (codex + whitlockk, #6492). Two
 * separate defects lived in the previous signature, which took an
 * undifferentiated list of every day that succeeded and picked the minimum:
 *
 *  - a Backward day failing while an OLDER Backward day succeeded moved the
 *    cursor below the failure (Aug 29 fails, Aug 28 succeeds ⇒ cursor Aug 28,
 *    and Aug 29 is never walked again);
 *  - a Today or Recheck success older than a failed backward day did the same
 *    thing from a lane that has no business moving this cursor at all.
 *
 * Both are why this takes typed per-lane attempts rather than a bag of strings:
 * the ordering the walk used is information the caller has and a sort cannot
 * reconstruct.
 */
export function advanceBackwardCursor(
  currentCursor: string | null,
  backwardAttempts: readonly BackwardDayAttempt[]
): string | null {
  let advanced = currentCursor;
  for (const attempt of backwardAttempts) {
    if (!attempt.succeeded) {
      break;
    }
    if (advanced === null || attempt.day < advanced) {
      advanced = attempt.day;
    }
  }
  return advanced;
}

/**
 * The new round-robin position: the LAST day this run rechecked IN WALK ORDER,
 * or the unchanged cursor when it rechecked nothing.
 *
 * WALK ORDER, NEVER THE LEXICAL MAXIMUM (whitlockk, #6492). The recheck lane wraps,
 * so a run that crosses the end of the attempted range visits, say,
 * `[Aug 4, Aug 1, Aug 2]`. The largest of those is Aug 4 — the day the walk
 * started on — and storing it makes the next run wrap again and re-ask Aug 1
 * and Aug 2 immediately while Aug 3 keeps waiting. The round robin then repeats
 * a prefix instead of advancing. The last day VISITED, Aug 2, is the position
 * that makes the next run resume at Aug 3.
 *
 * Unlike the backward cursor this DOES advance over a failed day. The lane
 * wraps, so a day it skipped comes round again on the next pass; holding the
 * position on a persistently failing day would pin the round robin there and
 * starve every other attempted day.
 */
export function advanceRecheckCursor(
  currentCursor: string | null,
  recheckedDaysInWalkOrder: readonly string[]
): string | null {
  return recheckedDaysInWalkOrder.at(-1) ?? currentCursor;
}

/** The backward lane: strictly older than the cursor, one day at a time. */
function planBackwardDays(input: {
  today: string;
  backwardCursor: string | null;
  budget: number;
}): string[] {
  if (input.budget <= 0) {
    return [];
  }
  // With nothing attempted yet the walk starts at today, so the first backward
  // day is yesterday — today itself is already served by its own lane.
  const anchor = input.backwardCursor ?? input.today;
  const days: string[] = [];
  let cursorMs = Date.parse(`${anchor}T00:00:00.000Z`);
  if (Number.isNaN(cursorMs)) {
    return [];
  }
  for (let taken = 0; taken < input.budget; taken += 1) {
    cursorMs -= MS_PER_DAY;
    days.push(toIsoDateOnly(new Date(cursorMs)));
  }
  return days;
}

/**
 * The recheck lane: attempted days strictly after the cursor, wrapping to the
 * oldest attempted day once the end is reached, so the walk is a true cycle
 * over the whole attempted set rather than a one-way sweep that stops.
 */
function planRecheckDays(input: {
  attemptedDays: readonly string[];
  recheckCursor: string | null;
  excluded: ReadonlySet<string>;
  budget: number;
}): string[] {
  if (input.budget <= 0) {
    return [];
  }
  const ordered = [...input.attemptedDays].sort();
  if (ordered.length === 0) {
    return [];
  }
  const cursor = input.recheckCursor;
  const startIndex = cursor ? ordered.findIndex((day) => day > cursor) : 0;
  // -1 means the cursor is at or past the newest attempted day: wrap to 0.
  const from = startIndex === -1 ? 0 : startIndex;

  const picked: string[] = [];
  for (let offset = 0; offset < ordered.length; offset += 1) {
    if (picked.length >= input.budget) {
      break;
    }
    const day = ordered[(from + offset) % ordered.length];
    if (!input.excluded.has(day)) {
      picked.push(day);
    }
  }
  return picked;
}

/**
 * Clamp a budget at BOTH ends and refuse a non-finite one by falling back to
 * the default. `Math.min` alone would let a negative through, and a negative
 * budget produces an empty plan that reads exactly like a completed run.
 */
function clampPositive(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}
