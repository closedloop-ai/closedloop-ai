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
