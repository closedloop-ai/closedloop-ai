/**
 * FEA-3795: shared exponential-backoff schedule used by every desktop sync
 * retry ladder (transcript file retries, agent-session dead-letter retries).
 *
 * Returns the delay (ms) for the Nth attempt of a 1-indexed `attemptCount`:
 * `baseMs * 2^(attemptCount - 1)`, capped at `maxMs`. The schedule is
 * monotonically non-decreasing in `attemptCount` and pinned at `maxMs` once
 * reached.
 *
 * Input hardening (so a single SSOT can back every caller safely):
 * - `attemptCount` is floored and clamped to a minimum of 1, so a non-positive
 *   or fractional count behaves like the first attempt (`baseMs`). Callers pass
 *   integer counts today; this keeps the helper defensive without changing any
 *   integer-input result.
 * - the doubling exponent is clamped so `2 ** exponent` can never overflow to
 *   `Infinity` before the cap clamps it. `2^49` already dwarfs any realistic
 *   cap, so clamping at 49 never alters a result — the final `Math.min` still
 *   returns `maxMs` for every count at or past the cap.
 */
export function exponentialBackoffMs(
  attemptCount: number,
  baseMs: number,
  maxMs: number
): number {
  const count = attemptCount >= 1 ? Math.floor(attemptCount) : 1;
  const exponent = Math.min(count - 1, 49);
  const raw = baseMs * 2 ** exponent;
  return Math.min(raw, maxMs);
}
