// FEA-2952 / PLN-1323 — aggregations layer.
//
// An "aggregation" folds a list of measured numbers into a single scalar (or null
// when the input is empty, so "no data" stays distinguishable from a real 0 —
// see the KPI contract's tile-availability semantics). The registry names an
// aggregation per KPI; changing "median PR size" to "mean PR size" is a one-word
// edit there.
//
// `median` and `computeMean` are the already-consolidated shared implementations
// in `@repo/api/src/utils/math` — reused here rather than re-duplicated (that
// consolidation was intentional; see FEA-2878-era math util).

import { computeMean, median as sharedMedian } from "../../utils/math.ts";

/** Median of the values; null on empty input. Delegates to the shared helper. */
function median(values: number[]): number | null {
  return sharedMedian(values);
}

/** Arithmetic mean of the values; null on empty input. */
function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return computeMean(values);
}

/** Sum of the values; null on empty input. */
function sum(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((acc, value) => acc + value, 0);
}

/** Count of the values (their length). Always defined — 0 for empty input. */
function count(values: number[]): number {
  return values.length;
}

/**
 * A ratio numerator/denominator, scaled by `scale` (default 1). Null when the
 * denominator is 0, so an undefined rate renders as "unavailable" rather than a
 * divide-by-zero NaN or a misleading 0.
 */
function ratio(
  numerator: number,
  denominator: number,
  scale = 1
): number | null {
  if (denominator === 0) {
    return null;
  }
  return (numerator / denominator) * scale;
}

/**
 * Rounds `value` to `decimals` decimal places. Null-safe: passes a null value
 * through unchanged so the "unavailable" signal survives the rounding step.
 */
function round(value: number | null, decimals: number): number | null {
  if (value === null) {
    return null;
  }
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

export const aggregations = {
  median,
  mean,
  sum,
  count,
} as const;
export type AggregationKey = keyof typeof aggregations;

export { count, mean, median, ratio, round, sum };
