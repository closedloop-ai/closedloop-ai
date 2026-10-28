/**
 * @file safe-counts.ts
 * @description The canonical validator for a COUNT crossing a storage, worker,
 * or IPC boundary: an exact, non-negative, JS-safe integer.
 *
 * ISS-9047. A bare `z.number()` on a count admits `-1`, `1.5`, `Infinity` and
 * `1e300` — each of which renders downstream as a confident measurement rather
 * than as the corrupt parse it came from. The two everyone remembers are
 * negative and non-finite; the ones that actually reach a column are the
 * fractional count and the magnitude past the safe-integer range, because
 * neither looks wrong until something divides by it.
 *
 * `.int()` alone is not the bound: `Number.isInteger(1e300)` is true, so a
 * magnitude that has already lost precision in JS passes it. The refine is what
 * closes that, and it is the reason this is a shared schema rather than a
 * three-call idiom each boundary re-types.
 */
import { z } from "zod";

export const safeStorageCountSchema = z
  .number()
  .int()
  .nonnegative()
  .refine((value) => Number.isSafeInteger(value), {
    message: "must be a safe integer",
  });

/**
 * The same bound for a 1-BASED ORDINAL or its denominator — a position, not a
 * tally — where `0` is already impossible because the thing being counted had
 * to exist for the position to be drawn.
 *
 * Derived from {@link safeStorageCountSchema} rather than re-spelling
 * `.int().nonnegative().refine(...)` with a `.positive()` swapped in, so the
 * safe-integer arm cannot be added to one and forgotten on the other
 * (davetho review, PR #7220).
 */
export const safeStorageOrdinalSchema = safeStorageCountSchema.refine(
  (value) => value > 0,
  { message: "must be greater than zero" }
);
