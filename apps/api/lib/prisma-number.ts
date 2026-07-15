/** Safely convert a BigInt or Prisma Decimal to a JS number; null/undefined → 0. */
export function toNumber(
  value: bigint | number | { toNumber?: () => number } | null | undefined
): number {
  if (value == null) {
    return 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value.toNumber === "function") {
    return value.toNumber();
  }
  return Number(value);
}
