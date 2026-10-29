/**
 * Compare two nullable numbers with nulls parked last in BOTH sort directions.
 *
 * The direction orders measured values against each other only. A null is
 * always after a measured value, while a measured zero remains distinct from
 * an absent measurement.
 */
export function compareNullableNumber(
  a: number | null,
  b: number | null,
  direction: "asc" | "desc"
): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  const sign = direction === "asc" ? 1 : -1;
  return sign * (a - b);
}
