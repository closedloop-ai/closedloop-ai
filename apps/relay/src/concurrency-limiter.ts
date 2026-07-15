/**
 * Bounded in-flight concurrency limiter (FEA-1994 / PRD-481 C6).
 *
 * A minimal synchronous counting semaphore used to bound the number of
 * concurrently in-flight relay → collector proxy requests across the entire
 * keyless `/telemetry` namespace.
 *
 * Why try-acquire with NO wait queue: the keyless ingress is unauthenticated
 * and fleet-scale (1,400+ senders). A waiting queue would let a telemetry spike
 * accumulate unbounded pending work — exactly the unbounded memory / event-loop
 * pressure this limiter exists to prevent. Instead callers fast-reject
 * (load-shed) when the limit is reached and tell the client to retry later, so
 * aggregate in-flight work — and thus outbound sockets, pending promises, and
 * retained request bodies — stay bounded regardless of offered load.
 */

export type ConcurrencyLimiter = {
  /**
   * Reserve one slot. Returns `true` and increments the in-flight count if a
   * slot was free, or `false` (no state change) when already at capacity. Every
   * successful acquire MUST be paired with exactly one {@link release}, ideally
   * in a `finally`.
   */
  tryAcquire: () => boolean;
  /**
   * Return one slot. Never drops below zero, so a double-release (defensive
   * caller bug) cannot manufacture phantom capacity.
   */
  release: () => void;
  /** Current number of reserved slots. */
  inFlight: () => number;
  /** The configured ceiling. */
  readonly max: number;
};

/**
 * Create a concurrency limiter with `max` slots. A non-finite or non-positive
 * `max` is clamped to 1 so the limiter is never a no-op (which would defeat the
 * back-pressure guarantee).
 */
export function createConcurrencyLimiter(max: number): ConcurrencyLimiter {
  const ceiling = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  let current = 0;

  return {
    tryAcquire(): boolean {
      if (current >= ceiling) {
        return false;
      }
      current += 1;
      return true;
    },
    release(): void {
      if (current > 0) {
        current -= 1;
      }
    },
    inFlight(): number {
      return current;
    },
    max: ceiling,
  };
}
