/**
 * Computes the arithmetic mean of an array of numbers.
 * Typically we would use this functionality from an external library. However, adding an extra
 * dependency for one function is overkill, so we decided to implement it here.
 */
export function computeMean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

/**
 * Median of a numeric array. Returns `null` for an empty input so callers can
 * distinguish "no data" from a real zero; callers that want 0-on-empty use
 * `median(values) ?? 0`. Does not mutate the input.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Checks whether a number can be represented with at most N decimal places.
 * Uses an epsilon tolerance to account for IEEE-754 floating-point arithmetic.
 */
export function hasAtMostDecimalPlaces(
  value: number,
  maxDecimalPlaces: number
): boolean {
  if (!Number.isFinite(value) || maxDecimalPlaces < 0) {
    return false;
  }

  const scale = 10 ** maxDecimalPlaces;
  const scaledValue = value * scale;
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(scaledValue));

  return Math.abs(scaledValue - Math.round(scaledValue)) <= epsilon;
}
