import { z } from "zod";

const TOKEN_COUNT_DECIMAL_RE = /^(?:0|[1-9]\d*)$/;
const MAX_SAFE_TOKEN_COUNT_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Token counters cross SQLite/Prisma/IPC boundaries as JavaScript numbers.
 * Accept only exact non-negative safe integers so widened BIGINT storage cannot
 * silently persist a value that was already rounded in JS.
 */
export const safeStorageTokenCountSchema = z
  .number()
  .int()
  .nonnegative()
  .refine((value) => Number.isSafeInteger(value), {
    message: "must be a safe integer",
  });

/** Error raised when a token counter cannot be represented exactly in JS. */
export class InvalidTokenCountError extends Error {
  constructor(fieldName: string) {
    super(
      `Invalid token count for ${fieldName}: expected a safe non-negative integer`
    );
    this.name = "InvalidTokenCountError";
  }
}

/**
 * Read a storage-bound token counter, treating missing values as zero.
 *
 * Accepts safe non-negative JS numbers plus decimal strings or `bigint` values
 * returned by database drivers. Throws `InvalidTokenCountError` for negative,
 * fractional, or JS-unsafe values so callers do not persist or emit rounded
 * counters.
 */
export function readStorageTokenCount(
  value: unknown,
  fieldName: string
): number {
  const parsed = parseOptionalStorageTokenCount(value, fieldName);
  return parsed ?? 0;
}

/**
 * Read an optional storage-bound token counter.
 *
 * Missing values remain `null`; present values must be exact non-negative safe
 * integers. Database `bigint` values are accepted only when they fit within
 * `Number.MAX_SAFE_INTEGER`.
 */
export function parseOptionalStorageTokenCount(
  value: unknown,
  fieldName: string
): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (TOKEN_COUNT_DECIMAL_RE.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed)) {
        return parsed;
      }
    }
  }
  if (
    typeof value === "bigint" &&
    value >= 0n &&
    value <= MAX_SAFE_TOKEN_COUNT_BIGINT
  ) {
    return Number(value);
  }
  throw new InvalidTokenCountError(fieldName);
}

/**
 * Add two storage-bound counters and reject totals that would leave the JS-safe
 * numeric contract used by desktop IPC and API payloads.
 */
export function addStorageTokenCounts(
  current: unknown,
  next: unknown,
  fieldName: string
): number {
  return readStorageTokenCount(
    readStorageTokenCount(current, fieldName) +
      readStorageTokenCount(next, fieldName),
    fieldName
  );
}

/**
 * Subtract storage-bound counters for cumulative-token deltas and clamp counter
 * resets at zero. Operands and the non-negative result stay JS-safe.
 */
export function subtractStorageTokenCounts(
  current: unknown,
  previous: unknown,
  fieldName: string
): number {
  const currentValue = readStorageTokenCount(current, fieldName);
  const previousValue = readStorageTokenCount(previous, fieldName);
  if (currentValue <= previousValue) {
    return 0;
  }
  return readStorageTokenCount(currentValue - previousValue, fieldName);
}

/**
 * Pick the first present token alias and validate only that value. This
 * preserves canonical zero values instead of falling through to legacy aliases.
 */
export function readStorageTokenCountAlias(
  record: Record<string, unknown>,
  fieldName: string,
  keys: readonly string[]
): number {
  for (const key of keys) {
    const value = record[key];
    if (value != null) {
      return readStorageTokenCount(value, `${fieldName}.${key}`);
    }
  }
  return 0;
}
