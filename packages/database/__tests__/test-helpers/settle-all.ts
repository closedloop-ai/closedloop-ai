/**
 * Sequential cleanup that runs every step and loses no failure.
 *
 * WHY (ISS-6211): a `try { work } finally { cleanup }` teardown drops the work's
 * error whenever the cleanup ALSO rejects — `finally` replaces the in-flight
 * rejection — and a `finally` body that awaits two things in sequence skips the
 * second when the first rejects. Both shapes turn a teardown into a place where
 * the useful error disappears and a resource leaks, which is the same
 * fail-quietly class this ticket exists to close.
 */

/**
 * Runs every step in order regardless of earlier failures, then rethrows.
 *
 * A single failure is rethrown as-is so its stack and type reach the caller
 * unchanged; several are combined into an `AggregateError` so no cause is lost.
 */
export async function settleAll(
  steps: readonly (() => Promise<unknown>)[],
  description: string
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, description);
  }
}
