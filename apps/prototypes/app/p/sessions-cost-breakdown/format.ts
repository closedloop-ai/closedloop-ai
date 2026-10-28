/**
 * Faithful replicas of the production currency formatters. The sandbox cannot
 * import `@repo/app`, so these restate `formatCostPrecise`, `formatCurrencyWhole`,
 * `formatCurrencyTileValue` and `KPI_NO_VALUE` from
 * `packages/app/shared/lib/format-utils.ts` rather than inventing a local
 * rounding rule. Productionizing imports the real ones and deletes this file.
 *
 * The guarantee worth preserving: a nonzero amount NEVER renders as an exact
 * zero, and a bound is only ever stated where no faithful figure exists. The
 * first draft of this file bounded the WHOLE sub-cent band, so a real $0.004
 * read `< $0.01` where production shows `$0.004` — a bound standing in for a
 * true number, inside the card written to stop exactly that. A replica needs a
 * diff against its source before anyone productionizes it.
 */

/** Rendered when a metric has no computable value (unknown, not zero). */
export const KPI_NO_VALUE = "—";

const PRECISE_COST_MAX_FRACTION_DIGITS = 4;

/** Smallest magnitude 4dp can render as a nonzero figure. */
const PRECISE_COST_SMALLEST_UNIT = 10 ** -PRECISE_COST_MAX_FRACTION_DIGITS;

/** Below half the smallest unit, even 4dp rounds a real cost back to zero. */
const PRECISE_COST_ZERO_ROUNDING_FLOOR = PRECISE_COST_SMALLEST_UNIT / 2;

export const PRECISE_COST_BELOW_FLOOR = `< $${PRECISE_COST_SMALLEST_UNIT.toFixed(
  PRECISE_COST_MAX_FRACTION_DIGITS
)}`;

export const PRECISE_COST_ABOVE_NEGATIVE_FLOOR = `> -$${PRECISE_COST_SMALLEST_UNIT.toFixed(
  PRECISE_COST_MAX_FRACTION_DIGITS
)}`;

/** The precision a whole-dollar tile renders, and so where it states its bound. */
const WHOLE_CURRENCY_BOUND_UNIT = 0.01;

export const WHOLE_CURRENCY_BELOW_FLOOR = `< $${WHOLE_CURRENCY_BOUND_UNIT.toFixed(2)}`;

export const WHOLE_CURRENCY_ABOVE_NEGATIVE_FLOOR = `> -$${WHOLE_CURRENCY_BOUND_UNIT.toFixed(2)}`;

/** Plain 2dp. */
function formatCost(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Sub-cent aware. A cent or more (or exact zero) is faithful at 2dp; below that
 * it shows enough decimals to expose a nonzero figure, and only states a bound
 * once even 4dp would round to zero.
 */
export function formatCostPrecise(cost: number | undefined): string {
  const value = cost ?? 0;
  const abs = Math.abs(value);
  if (abs === 0 || abs >= 0.01) {
    return formatCost(value);
  }
  if (abs < PRECISE_COST_ZERO_ROUNDING_FLOOR) {
    return value < 0
      ? PRECISE_COST_ABOVE_NEGATIVE_FLOOR
      : PRECISE_COST_BELOW_FLOOR;
  }
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: PRECISE_COST_MAX_FRACTION_DIGITS,
  })}`;
}

/** Whole dollars, with the nonzero-never-renders-as-zero guarantee. */
export function formatCurrencyWhole(cost: number | undefined): string {
  const value = cost ?? 0;
  if (value !== 0 && Math.round(value) === 0) {
    // Guard on the PRECISE floor ($0.00005), not the whole-dollar bound unit:
    // the bound is stated only once even 4dp rounds to zero. Guarding on $0.01
    // here is the drift this file already shipped once — it turns a renderable
    // $0.004 into a bound, which is a bound standing in for a true figure.
    if (Math.abs(value) < PRECISE_COST_ZERO_ROUNDING_FLOOR) {
      return value < 0
        ? WHOLE_CURRENCY_ABOVE_NEGATIVE_FLOOR
        : WHOLE_CURRENCY_BELOW_FLOOR;
    }
    return formatCostPrecise(value);
  }
  return `$${Math.round(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** Tile guard: an unavailable metric is the honest-empty dash, never `$0`. */
export function formatCurrencyTileValue(
  value: number | null | undefined
): string {
  if (value == null || !Number.isFinite(value)) {
    return KPI_NO_VALUE;
  }
  return formatCurrencyWhole(value);
}

/**
 * Lane share of the total, bounded at BOTH ends for the same reason the currency
 * formatter is: a real lane worth 0.04% must not read `0.0%`, and a lane that is
 * not the whole total must not read `100.0%`.
 */
export function formatShare(
  amount: number | null,
  total: number | null
): string | null {
  if (amount === null || total === null || total <= 0) {
    return null;
  }
  const share = (amount / total) * 100;
  if (share > 0 && share < 0.1) {
    return "<0.1%";
  }
  if (share > 99.9 && share < 100) {
    return ">99.9%";
  }
  return `${share.toFixed(1)}%`;
}

/**
 * Whole-dollar lane figures that actually sum to the whole-dollar headline.
 * Rounding each lane independently leaves the column off by a dollar against the
 * total above it, on a card whose info copy promises the lanes sum to it. The
 * largest lane absorbs the remainder, so the discrepancy lands where it is
 * proportionally smallest.
 *
 * NEVER at the cost of a negative lane. Three $0.50 lanes under a $1.50 total
 * round to 1+1+1 against a headline of 2, so the -1 remainder would push the
 * absorbing lane to -$0.50 — a negative lane beneath a positive total, on the
 * card written to stop the UI lying about money. A column that is a dollar off
 * is the smaller lie, and it is visible; a negative lane is neither. Same rule
 * for a payload carrying a non-finite figure: reconciling it would repair bad
 * data into a believable lane, so it is left exactly as it arrived.
 */
export function allocateLaneRounding(
  amounts: readonly (number | null)[],
  total: number | null
): readonly (number | null)[] {
  if (total === null || !Number.isFinite(total)) {
    return amounts;
  }
  let largestIndex = -1;
  let largestValue = Number.NEGATIVE_INFINITY;
  let roundedSum = 0;
  for (const [index, amount] of amounts.entries()) {
    if (amount === null) {
      continue;
    }
    if (!Number.isFinite(amount)) {
      return amounts;
    }
    roundedSum += Math.round(amount);
    if (amount > largestValue) {
      largestValue = amount;
      largestIndex = index;
    }
  }
  const remainder = Math.round(total) - roundedSum;
  if (remainder === 0 || largestIndex === -1) {
    return amounts;
  }
  const absorbed = largestValue + remainder;
  if (absorbed < 0) {
    return amounts;
  }
  return amounts.map((amount, index) =>
    index === largestIndex && amount !== null ? absorbed : amount
  );
}
