/**
 * Wall-clock budget for the preview-schema sweep's DROP work (ISS-5343).
 *
 * A private internal of `app/preview-schemas/service.ts`, which stays the only
 * module routes consume. Split out per the nested-service pattern in
 * `apps/api/AGENTS.md` so the composition root does not carry every concern.
 */

import type { CategoryCounters } from "@repo/database/scripts/cleanup-preview-schemas-lib";

/**
 * Default wall-clock budget for a sweep, in milliseconds.
 *
 * Deliberately below the cron route's `maxDuration` (300s): a `DROP SCHEMA
 * CASCADE` already in flight cannot be preempted, so the gap is headroom for
 * one worst-case drop to finish after the budget is spent. Without it, the
 * first sweep that drains a large backlog can outlive the function and return
 * nothing, which reads as a cron failure and pages — on a sweep that was
 * working correctly.
 */
export const FALLBACK_SWEEP_BUDGET_MS = 240_000;

/**
 * Hard ceiling on the budget, whatever the operator sets.
 *
 * The whole point of the budget is to stop the sweep starting work it cannot
 * finish before the cron route's `maxDuration` (300s) kills the function. An
 * override at or above that ceiling — `PREVIEW_SWEEP_BUDGET_MS=300000` — would
 * silently delete the headroom and hand back the exact timeout this prevents,
 * so the env var can lower the budget but never raise it past what is safe
 * (PR #4499 review). Kept as a local constant rather than derived from the
 * route's export to avoid a route → service → route import cycle; a test pins
 * the two together.
 */
export const SWEEP_BUDGET_CEILING_MS = 240_000;

export type DropBudget = {
  /** True once the sweep has spent its wall-clock budget. */
  isExhausted: () => boolean;
};

/**
 * Resolves the sweep budget from `process.env.PREVIEW_SWEEP_BUDGET_MS`, falling
 * back to {@link FALLBACK_SWEEP_BUDGET_MS} when unset, non-numeric, or
 * non-positive, and clamped to {@link SWEEP_BUDGET_CEILING_MS} so an oversized
 * override cannot erase the headroom under `maxDuration`.
 */
export function getSweepBudgetMs(): number {
  const raw = process.env.PREVIEW_SWEEP_BUDGET_MS;
  if (raw === undefined || raw === "") {
    return FALLBACK_SWEEP_BUDGET_MS;
  }
  const n = Number(raw);
  if (!(Number.isFinite(n) && n > 0)) {
    return FALLBACK_SWEEP_BUDGET_MS;
  }
  return Math.min(n, SWEEP_BUDGET_CEILING_MS);
}

/**
 * Starts the sweep's budget clock.
 *
 * **Call this at the very start of the sweep, before listing and classifying.**
 * Classification is one sequential registry round trip per schema plus a
 * paginated GitHub branch fetch, and on the large backlog this exists to drain
 * that is not free. Anchoring the deadline at the first DROP instead would make
 * the real ceiling `classification + budget + one in-flight drop`, quietly
 * spending the headroom the default reserves and reintroducing the very
 * function-timeout this budget prevents.
 *
 * Best-effort by construction: the check happens *before* each drop, and a
 * `DROP SCHEMA … CASCADE` in flight cannot be preempted. The budget bounds when
 * the sweep *starts* work, not when it finishes.
 *
 * Uses `Date.now()` directly rather than an injected clock — tests drive it with
 * `vi.useFakeTimers()` + `vi.advanceTimersByTime()`, which keeps the production
 * signature clean and the assertions off the real wall clock.
 */
export function createDropBudget(budgetMs: number): DropBudget {
  const deadline = Date.now() + budgetMs;
  return {
    isExhausted: () => Date.now() >= deadline,
  };
}

/**
 * Single decision point for "the budget is spent, so skip this drop".
 *
 * Returns true when the caller should skip, having already credited the
 * un-attempted drop to `deferredDrops`. Shared by every drop path so the
 * deferral policy — and what counts toward the counter — cannot drift between
 * them.
 */
export function deferDropIfExhausted(
  budget: DropBudget,
  counters: CategoryCounters
): boolean {
  if (!budget.isExhausted()) {
    return false;
  }
  counters.deferredDrops += 1;
  return true;
}
