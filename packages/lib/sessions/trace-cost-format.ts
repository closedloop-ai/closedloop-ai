/**
 * Canonical fixed-2dp USD display for a session/branch trace cost figure —
 * `$0.42`. Shared SSOT so the session-detail trace (`session-trace.tsx`), the
 * collapsed sub-agent box (FEA-4178), and the branch merged-trace adapter all
 * render trace costs identically and the branch merge can round-trip the label
 * back to a number (`parseSubagentCostUsd`).
 *
 * `@repo/lib` (not `@repo/app/shared/lib/format-utils`) so the turn-item
 * projection — which lives in `@repo/lib` and cannot import the app layer — can
 * reuse it; `@repo/app` consumers import it from here too.
 */
export function formatTraceCostUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** How many extra decimals `formatTraceCostPrecise` may add before it gives up
 *  and shows the fixed 2dp cents (a sub-tenth-of-a-cent value reads as "$0.00" —
 *  at that granularity precision is noise, not signal). Mirrors
 *  `PRECISE_COST_MAX_FRACTION_DIGITS` in `@repo/app`'s `formatCostPrecise`. */
const PRECISE_COST_MAX_FRACTION_DIGITS = 4;

/** The smallest magnitude {@link PRECISE_COST_MAX_FRACTION_DIGITS} can render as
 *  a nonzero figure. Mirrors `PRECISE_COST_SMALLEST_UNIT` in `@repo/app`. */
const PRECISE_COST_SMALLEST_UNIT = 10 ** -PRECISE_COST_MAX_FRACTION_DIGITS;

/** Below HALF the smallest unit, 4dp rounding lands on zero. The bound starts at
 *  the ROUNDING boundary, not the unit, or it would swallow values that still
 *  render faithfully. Mirrors `PRECISE_COST_ZERO_ROUNDING_FLOOR` in `@repo/app`. */
const PRECISE_COST_ZERO_ROUNDING_FLOOR = PRECISE_COST_SMALLEST_UNIT / 2;

/**
 * ISS-4919 (review thread): the sub-floor bound, kept byte-identical to
 * `PRECISE_COST_BELOW_FLOOR` in `@repo/app`'s `format-utils`. The two constants
 * are a second definition rather than a re-export because `@repo/lib` cannot
 * import the app layer — which is the same reason this whole function is a twin.
 */
const PRECISE_COST_BELOW_FLOOR = `< $${PRECISE_COST_SMALLEST_UNIT.toFixed(
  PRECISE_COST_MAX_FRACTION_DIGITS
)}`;

/** Negative mirror of {@link PRECISE_COST_BELOW_FLOOR}. */
const PRECISE_COST_ABOVE_NEGATIVE_FLOOR = `> -$${PRECISE_COST_SMALLEST_UNIT.toFixed(
  PRECISE_COST_MAX_FRACTION_DIGITS
)}`;

/**
 * FEA-4178 / wongk review: precise USD display for a FINE-GRAINED trace cost
 * that can legitimately fall below one cent (a single sub-agent's attributed
 * spend). Fixed-2dp `formatTraceCostUsd` renders any nonzero value under $0.005
 * as a flat "$0.00", which reads as a broken/lying stat next to a run that
 * visibly cost something — and, worse, collapses a real $0.003 sub-agent into
 * the same "$0.00" as a sub-agent whose cost we have no data for, two distinct
 * states the user then can't tell apart. This widens `maximumFractionDigits`
 * just enough that a nonzero value shows a nonzero figure (up to 4dp, e.g.
 * `$0.0037`). Values of a cent or more (and exact zero) render identically to
 * `formatTraceCostUsd`. This is the `@repo/lib`-layer twin of
 * `@repo/app/shared/lib/format-utils`'s `formatCostPrecise` (FEA-3722) — which
 * the turn-item projection cannot import across the layer boundary — so the
 * branch activity timeline and this trace agree on how sub-cent costs read;
 * keep the two behaviors in lockstep.
 *
 * ISS-4919 (review thread): that lockstep is why the sub-floor bound is HERE and
 * not only in `@repo/app`. Below {@link PRECISE_COST_ZERO_ROUNDING_FLOOR} even
 * 4dp rounds a real cost back to `$0.00`, so without this branch the same session
 * dollars read `< $0.0001` in the branch activity timeline and a flat `$0.00` in
 * the session-detail trace and the collapsed sub-agent box — two surfaces, one
 * record, two claims. The guarantee both twins now hold: **a nonzero cost never
 * renders as an exact zero**, which is also what `formatTraceCostForDisplay`'s
 * docstring already promised (a real sub-cent cost must not collapse into the
 * same `$0.00` as a sub-agent with no cost data).
 */
export function formatTraceCostPrecise(value: number): string {
  const abs = Math.abs(value);
  // A cent or more (or exact zero) is already faithful at 2dp.
  if (abs === 0 || abs >= 0.01) {
    return formatTraceCostUsd(value);
  }
  // Once 4dp rounding lands on zero, no figure is faithful — state the bound
  // rather than round a real cost down to a fabricated zero.
  if (abs < PRECISE_COST_ZERO_ROUNDING_FLOOR) {
    return value < 0
      ? PRECISE_COST_ABOVE_NEGATIVE_FLOOR
      : PRECISE_COST_BELOW_FLOOR;
  }
  // Sub-cent: show enough decimals to expose a nonzero figure, but never so many
  // that we render a meaningless string of zeros for a truly negligible slice.
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: PRECISE_COST_MAX_FRACTION_DIGITS,
  })}`;
}

/**
 * FEA-4178: format a sub-agent's attributed trace cost for the collapsed box's
 * meta row, or `null` only when the cost is genuinely ABSENT (no attribution) so
 * the box drops the empty part. A present nonzero figure — including a sub-cent
 * one — renders precisely (`formatTraceCostPrecise`) rather than being floored
 * to "$0.00" or hidden: a real sub-cent cost is a distinct state from "no data"
 * and must not collapse into it (wongk review, mirroring `formatCostPrecise` in
 * the branch activity timeline). Only a `null` input yields `null` here.
 */
export function formatTraceCostForDisplay(value: number | null): string | null {
  if (value == null) {
    return null;
  }
  return formatTraceCostPrecise(value);
}
