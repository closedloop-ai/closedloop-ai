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
