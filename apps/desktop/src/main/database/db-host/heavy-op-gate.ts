/**
 * Shared heavy-op gate for the db-host utilityProcess.
 *
 * The db-host is a SINGLE worker with one `--max-old-space-size` heap. The
 * FEA-2055 InsightsResultCache bounds insights-vs-insights, but the heavy
 * store-ops (session-analytics rollup + the `*.backfill` jobs) ran with NO
 * shared gate against it. At scale (thousands of backfill sessions) a
 * get-insights recompute (json_each over turns) and a backfill chunk executed
 * concurrently in the one worker and their peaks SUMMED past the heap ceiling
 * → exit code 5. Because the dashboard re-fires get-insights on every launch,
 * the worker crash-looped and the backfill never drained (the queue only grew).
 *
 * This gate serializes ALL heavy work: at most one of {insights recompute,
 * store-op/backfill} holds it at a time, so peak db-host memory is a single
 * heavy operation — never the sum. It extends the codified bounded-fan-out
 * principle from reads to the backfill they were colliding with.
 *
 * Implemented as a promise-chain mutex (not a semaphore): a rejected task
 * settles the chain without breaking it, so one failing op can never wedge the
 * gate shut for every op that follows.
 *
 * FEA-3150 (FEA-3132 P1) — MEMORY-AWARE ADMISSION. Serialization alone bounds
 * the peak to a SINGLE heavy op, but a single heavy op can still START while the
 * worker is already under memory pressure (a WAL/reader-snapshot pinning the
 * -wal into the OS page cache, or an RSS high-water a prior op left behind).
 * The gate now runs an optional PRE-ADMISSION pressure check the moment it has
 * exclusivity, immediately BEFORE the task allocates: if under pressure it parks
 * in bounded ticks (reusing the SAME `getMemoryPressure` signal FEA-3140 uses to
 * throttle a RUNNING backfill via `yieldDbHostLoopUnderMemoryPressure`) so GC /
 * WAL-checkpoint can reclaim first. The wait is BOUNDED (maxWaits × delayMs): if
 * pressure won't clear within the cap the op proceeds rather than deadlock —
 * throttle, never starve. Because the check runs with exclusivity already held,
 * no other heavy op is in flight while it parks, so a stuck-high heap can never
 * wedge the whole chain shut. When no `admit` gate is supplied the gate behaves
 * exactly as before (pure serialization).
 */

/**
 * Park (bounded) until memory pressure clears, then resolve to admit the op.
 * MUST be bounded — a gate that never resolves would wedge the chain.
 */
export type AdmissionGate = () => Promise<void>;

export type HeavyOpGate = {
  /**
   * Run `task` only once all previously-gated tasks have settled AND — if an
   * `admit` gate was configured — once memory pressure has cleared (or the
   * bounded admission wait has elapsed).
   */
  runExclusive: <T>(task: () => Promise<T>) => Promise<T>;
};

export function createHeavyOpGate(opts?: {
  /**
   * Pre-admission memory-pressure gate. Invoked with exclusivity already held,
   * immediately before `task` runs; it should park (bounded) while under
   * pressure and resolve when pressure clears or the wait cap is hit. Omit for
   * pure serialization (legacy behavior).
   */
  admit?: AdmissionGate;
}): HeavyOpGate {
  const admit = opts?.admit;
  let chain: Promise<unknown> = Promise.resolve();

  // Wrap the task with the pre-admission wait when an `admit` gate is present.
  // The wait runs INSIDE the chained continuation, so exclusivity is already
  // held — it only waits out pressure the worker as a whole is under, never
  // another gated op.
  const gated = admit
    ? async <T>(task: () => Promise<T>): Promise<T> => {
        await admit();
        return await task();
      }
    : <T>(task: () => Promise<T>): Promise<T> => task();

  return {
    runExclusive<T>(task: () => Promise<T>): Promise<T> {
      // `.then(fn, fn)` runs `fn` after the prior op settles regardless of
      // whether it fulfilled or rejected — the gate is about serializing memory
      // pressure, not propagating outcomes.
      const run = chain.then(
        () => gated(task),
        () => gated(task)
      );
      // Advance the chain on a swallowed copy so a rejection here never poisons
      // subsequent ops. The caller still observes the real result via `run`.
      chain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };
}
