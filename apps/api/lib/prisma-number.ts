/**
 * Safely convert a BigInt or Prisma Decimal to a JS number; null/undefined → 0.
 *
 * Token-usage columns are BigInt in Postgres (int8) so a single huge synced
 * session can't overflow int4 and fail the upsert. The cloud surfaces expose
 * them as JS numbers, which is exact up to Number.MAX_SAFE_INTEGER — the same
 * ceiling the desktop side preserves — so narrowing here is lossless in practice
 * and keeps these counts JSON-serializable.
 */
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
