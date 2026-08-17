import { largestRemainderAllocate } from "@repo/app/shared/lib/largest-remainder";

/**
 * Integer percentages that sum to EXACTLY 100 (largest-remainder / Hamilton
 * method): floor each share, then hand the leftover points to the largest
 * fractional remainders.
 *
 * Rounding each row independently with `Math.round` is the failure this exists
 * to prevent: three equal shares render 33 / 33 / 33 (= 99) and the reader is
 * looking at a column that claims to be a share OF something and does not add up
 * to it. A column headed with the thing it divides ("Cost %") makes that legible
 * as a discrepancy rather than as harmless rounding, so every surface that
 * renders a per-row share of a named total goes through here.
 *
 * Shared by the branch Cost-to-merge breakdown and the session Activity
 * breakdown (ISS-4685): both divide the same dollars into per-activity shares,
 * and before this was hoisted they rounded differently — one summed to 100, the
 * other could be off by a point for the same session. Do NOT re-declare this at
 * a call site.
 *
 * The allocation itself lives in `largest-remainder.ts`, shared with the cents
 * twin (`reconciled-cost-cents.ts`) so the two cannot break a tie differently for
 * the same row. This module owns only the percent framing.
 *
 * A non-positive `total` has no honest share to report. This returns zeros for
 * that case, so a caller that must distinguish "unknown denominator" from a true
 * zero has to guard BEFORE calling (the Activity breakdown renders an em dash
 * there rather than a 0% that reads as measured).
 */
export function largestRemainderPercents(
  values: readonly number[],
  total: number
): number[] {
  if (total <= 0) {
    return values.map(() => 0);
  }
  const raw = values.map((value) => (value / total) * 100);
  // The target is the ROUNDED sum of the raw shares rather than a hardcoded 100:
  // a caller whose values do not sum to `total` (a subset of the population) is
  // asking for a partial split, and forcing it to 100 would inflate it.
  return largestRemainderAllocate(
    raw,
    Math.round(raw.reduce((sum, share) => sum + share, 0))
  );
}
