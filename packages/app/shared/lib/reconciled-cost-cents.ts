/**
 * ISS-5000: per-row dollar amounts that sum to EXACTLY the total they are
 * presented as a decomposition of — the money twin of
 * `largestRemainderPercents`, over the same shared allocation
 * (`largest-remainder.ts`) so the Cost column and the Cost % column beside it
 * cannot break a tie differently for the same row.
 *
 * The failure this exists to prevent: rounding each row to cents INDEPENDENTLY
 * of the total. The session Activity breakdown summed unrounded per-phase floats
 * for its header, then rendered each phase through its own 2dp `formatCost`, so
 * every row could shed up to half a cent and the column silently stopped adding
 * up to the figure directly above it — $24.79 + $3.40 + $3.25 + $0.00 + $1.40 =
 * $32.84 under a header reading $32.86.
 *
 * The parts were the wrong side of that mismatch, not the total: the header is
 * the exact sum of the unrounded attribution and agrees with the Properties
 * strip, whereas the rows were each answering a slightly different question than
 * "what is my share of this total". So the total stays authoritative and the
 * cents get ALLOCATED across the rows, rather than the header being lowered to
 * meet a lossy column (which would have made session detail contradict itself in
 * a second place).
 *
 * The sibling branch Cost-to-merge panel already refuses to ship this class of
 * gap — it folds its residual into an explicit trailing row
 * (`reconcilePhaseSegments`). The session panel has no such catch-all row to
 * absorb it, so it reconciles the displayed cents instead. Same invariant, and
 * it does not require the caller to own a remainder row.
 */

import { largestRemainderAllocate } from "@repo/app/shared/lib/largest-remainder";

const CENTS_PER_DOLLAR = 100;

/**
 * Whole-cent amounts (as USD numbers) for `values`, summing to exactly
 * {@link toDisplayCents}`(total)` cents.
 *
 * Every returned element is already at 2dp, so the caller formats it without
 * rounding again.
 *
 * Returns `null` when the inputs are not a decomposition this can honestly
 * reconcile — any non-finite or NEGATIVE part (wongk, #4324). The allocator
 * underneath clamps a negative to 0, which is the wrong answer twice over: for
 * `[-1, 3]` against a $2 total it renders `$0.00` and `$2.00`, hiding the
 * corrupt phase behind a plausible zero AND silently taking a real dollar off
 * the phase beside it. The token-event aggregation upstream preserves finite
 * negative costs, so this is reachable data, not a type-forbidden input.
 *
 * `null` means "cannot be reconciled" and the caller must fall back to its
 * existing unavailable/unreconciled rendering. That is the repo's rule for bad
 * data: degrade rather than emit a plausible-but-wrong number, and never let a
 * `$0.00` stand in for a figure that was not computed.
 *
 * When `total` is zero there is nothing to divide and this returns zeros — a
 * TRUE zero, distinct from the `null` above. A caller that must distinguish "no
 * cost to attribute" from "cost not computed" has to make that call BEFORE
 * getting here — the same contract `largestRemainderPercents` sets.
 */
export function reconcileDisplayedCostCents(
  values: readonly number[],
  total: number
): number[] | null {
  if (!Number.isFinite(total) || total < 0) {
    return null;
  }
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    return null;
  }
  if (total === 0) {
    return values.map(() => 0);
  }
  return largestRemainderAllocate(
    values.map((value) => value * CENTS_PER_DOLLAR),
    toDisplayCents(total)
  ).map((cents) => cents / CENTS_PER_DOLLAR);
}

/**
 * A USD amount as whole cents, matching what a 2dp currency formatter renders.
 *
 * Exported so the caller can head its column with a total derived from the SAME
 * quantization the rows were allocated against. `Math.round` and
 * `Intl.NumberFormat`'s 2dp rounding disagree on doubles sitting within a hair
 * of a half-cent, and a one-cent disagreement between the header and the column
 * is precisely the defect being fixed — so the header must not be formatted from
 * the raw float independently.
 */
export function toDisplayCents(usd: number): number {
  return Number.isFinite(usd) ? Math.round(usd * CENTS_PER_DOLLAR) : 0;
}
