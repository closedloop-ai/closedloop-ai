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
 * `createHeavyOpGate` below serializes the work routed to IT: at most one of
 * {insights recompute, store-op/backfill} holds it at a time, so those peaks are
 * a single heavy operation and never the sum. It extends the codified
 * bounded-fan-out principle from reads to the backfill they were colliding with.
 *
 * It is NOT the whole of this module, and no longer the whole of the db-host's
 * admission policy. ISS-5941 added {@link createBoundedOpLane}, a width-N
 * sibling for the heavy READ ops, which shares this module's `admit` contract
 * but explicitly does NOT serialize: those reads bound their peak at
 * `limit × one result set` rather than at one. So "peak db-host memory is a
 * single heavy op" is true of the mutex's own traffic, not of the process.
 * `db-host-op-lanes.ts` owns which op takes which lane.
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

/**
 * ISS-5941 — a BOUNDED-CONCURRENCY sibling of {@link createHeavyOpGate} for the
 * heavy READ ops, sharing this module's admission contract rather than growing a
 * second governor beside it.
 *
 * `runExclusive` above is a width-1 mutex, and that is deliberately wrong for
 * reads: it would queue an interactive Sessions read behind a full transcript
 * backfill for the backfill's entire duration — exactly the failure
 * `HEAVY_STORE_OPS` was narrowed to avoid. Reads need a bound on how many run
 * AT ONCE, not exclusivity against a backfill.
 *
 * The case this exists for: several surfaces each issue their own heavy read
 * into this single worker through the generic invoke path, and each in-flight
 * call holds its own partially-assembled result set live for its whole
 * duration — so peak memory is LINEAR in how many are running at once. Measured
 * on a seeded large-account corpus at a 15-way fan-out, bounding that width cut
 * peak JS heap from 2236/1530 MB to 1046/1131 MB and peak RSS from 3236/2291 MB
 * to 2176/2196 MB (two runs per arm; note the bounded arm is also far more
 * STABLE, which is the property that keeps a spike off the OOM ceiling).
 *
 * The caller chooses `limit`; see `db-host-op-lanes.ts` for the reasoning behind
 * the production value. `DEFAULT_READER_POOL_SIZE` is the useful CEILING-side
 * check to know about here: these are `prisma.read` ops over a pool of that many
 * `query_only` connections, each self-serializing its statements, so width well
 * past the pool buys no additional SQL throughput. It is emphatically NOT a
 * sufficient bound on its own — a task can hold a permit while occupying no
 * reader connection at all (an interleaved `prisma.write` flush, or a
 * cooperative loop yield).
 *
 * FIFO: waiters run in arrival order, and `finally` releases on the throwing
 * path too, so a rejected op can no more wedge this lane than it can wedge the
 * mutex above.
 *
 * ⚠️ A task that never settles holds its permit forever. `runBounded` has no
 * timeout, deliberately — force-releasing a permit would let the lane exceed its
 * own bound, which is the one thing it exists to guarantee. So only admit ops
 * that are themselves guaranteed to settle.
 *
 * ⚠️ KNOWN DUPLICATION, recorded so it does not quietly become drift: this is
 * the third hand-rolled counting semaphore bounding the same db-host heap.
 * `createColdReadGate` (`collectors/parsing/cold-read-gate.ts`) is this primitive
 * minus the `admit` hook, and `InsightsResultCache` carries its own
 * `running`/`waiters` pair. The cold-read gate is BEHAVIORALLY EQUIVALENT to this
 * one on the permit path — it decrements before draining the queue where this one
 * hands the permit straight over, but both happen synchronously in one function
 * body with no turn boundary between them, so nothing can observe the difference
 * and neither admits a barging arrival. The only real difference is the `admit`
 * hook. Collapsing them is the obvious consolidation and is deliberately NOT done
 * here: it is a separate change with its own blast radius (the cold-read gate has
 * its own callers and its own configured width), and folding it into an OOM fix
 * would bury a refactor inside a bug fix.
 */
/**
 * The admission breakdown for ONE trip through {@link BoundedOpLane.runBounded},
 * handed to an observer after the task settles.
 *
 * This exists because the lane is the one place that knows the difference
 * between "this op was slow" and "this op waited". Everything upstream —
 * `measureOp`, the IPC handler, the renderer round trip — sees only the sum.
 */
export type BoundedLaneTiming = {
  admitMs: number;
  queueMs: number;
  reAdmitMs: number;
  execMs: number;
  queued: boolean;
  activeOnArrival: number;
  /** Queued ops at arrival, across BOTH the interactive and background queues. */
  waitingOnArrival: number;
};

/** Receives one {@link BoundedLaneTiming} per completed lane trip. */
export type BoundedLaneObserver = (timing: BoundedLaneTiming) => void;

/**
 * The clock an UNOBSERVED lane trip reads — i.e. every trip on a production
 * launch. Hoisted to module scope so the unobserved path allocates nothing at
 * all per call; an inline arrow here would mint a fresh closure on every heavy
 * read, which is precisely the cost this instrumentation must not add.
 */
const UNMEASURED_CLOCK = (): number => 0;

export type BoundedOpLane = {
  /**
   * Run `task` once fewer than `limit` lane tasks are in flight AND — if an
   * `admit` gate was configured — once memory pressure has cleared (or the
   * bounded admission wait has elapsed).
   *
   * `observe` is the profiling seam and is OPTIONAL BY DESIGN: when it is
   * absent (the production default) this function reads no clock and allocates
   * no timing object, so the instrumentation cannot cost anything it is not
   * switched on for.
   */
  runBounded: <T>(
    task: () => Promise<T>,
    observe?: BoundedLaneObserver,
    /**
     * ISS-6079: `background: true` marks a task that must yield the lane to
     * interactive work. Absent means interactive, so omitting it preserves the
     * pre-ISS-6079 behaviour exactly.
     */
    options?: { background?: boolean }
  ) => Promise<T>;
};

export function createBoundedOpLane(opts: {
  /**
   * Max tasks in flight. Coerced to a whole number ≥ 1. Every degenerate width
   * falls back to 1 — the narrowest lane that still makes progress: `0` would
   * admit nothing, `NaN` would make every `active < limit` compare false and
   * wedge the lane permanently, and a non-finite width (including
   * `Number.POSITIVE_INFINITY`) is rejected rather than treated as "unbounded",
   * since an unbounded lane is precisely the bug this exists to prevent. If you
   * want a wide lane, pass a number.
   */
  limit: number;
  /**
   * Memory-pressure gate, the SAME one {@link createHeavyOpGate} takes. Bounded
   * by contract, so a permanently-high heap defers but never starves.
   *
   * Called at up to TWO points, and the split matters:
   *
   * 1. Before taking a permit, always. The mutex can park while holding its lock
   *    because at width 1 nothing else could be running anyway; at width > 1
   *    that fails — a parked task would hold a permit while allocating nothing,
   *    and a queue of K tasks would pay `ceil(K / limit)` full admission waits
   *    back to back before any of them started.
   * 2. Again after acquiring, but ONLY if the acquire had to QUEUE. A queued task
   *    may have waited arbitrarily long since its first check, so its pressure
   *    reading is stale exactly when it is about to allocate. A fast-path acquire
   *    skips this — it just admitted, and re-reading would be pure overhead.
   *
   * Step 2 is what keeps per-op back-pressure honest. Without it a burst would
   * admit once at t=0, exhaust the bounded wait together, and then pump through
   * the lane with no further pressure consultation at all.
   *
   * Step 2 DOES park while holding a permit, and hands back some of what step 1
   * bought — said plainly because an earlier revision of this comment implied
   * otherwise. A queue of K tasks still pays roughly `ceil(K / limit)` full
   * admission waits back to back, and a task parked in the post-acquire check
   * blocks a permit while allocating nothing, which is exactly the shape step 1
   * exists to keep OFF the front of the queue. That is the intended trade at
   * this position and not at step 1's: the whole point of re-reading here is
   * that the task is about to allocate, so under real pressure the correct
   * behavior is to hold the lane narrow until pressure clears rather than to
   * keep admitting. Step 1 has no such justification — a task waiting for its
   * TURN is not about to allocate, so parking there would be pure lane loss.
   * `admit` is bounded by contract, so the hold is bounded too.
   *
   * `db-host-op-lanes.test.ts` pins BOTH sides of that boundary behaviorally —
   * that a step-1 park lets another op through, and that a step-2 park does
   * not — rather than only counting `admit` calls, which cannot distinguish
   * them.
   */
  admit?: AdmissionGate;
  /**
   * Monotonic clock the timing split reads, injectable so a test can assert
   * EXACT millisecond attribution instead of racing the real clock (this repo
   * bans real-clock timing assertions). Read only when an observer is passed to
   * `runBounded`.
   */
  now?: () => number;
}): BoundedOpLane {
  const requested = Math.floor(opts.limit);
  const limit = Number.isFinite(requested) ? Math.max(1, requested) : 1;
  const admit = opts.admit;
  const clock = opts.now ?? (() => performance.now());
  // Guarded ONCE here rather than per call: an observed trip must never be able
  // to fail on its own clock, and the unobserved path must not pay a closure
  // for a wrapper it never reads. See `guardLaneClock`.
  const measuredClock = guardLaneClock(clock);
  let active = 0;
  let backgroundActive = 0;
  const waiting: (() => void)[] = [];
  const waitingBackground: (() => void)[] = [];
  // ISS-6079: permits a BACKGROUND op may hold at once. One is held back for
  // interactive work, so a corpus-scale sync batch can never occupy the whole
  // lane while a Sessions page read waits behind it. At the degenerate width 1
  // there is nothing to hold back — reserving there would stop background work
  // running at all, which is starvation, not prioritisation — so the cap is the
  // full width and background keeps today's behaviour.
  const backgroundLimit = limit > 1 ? limit - 1 : limit;

  function canAdmitBackground(): boolean {
    return active < limit && backgroundActive < backgroundLimit;
  }

  /** Resolves to `true` when the caller had to QUEUE for its permit. */
  function acquire(background: boolean): Promise<boolean> {
    if (background) {
      if (canAdmitBackground()) {
        active += 1;
        backgroundActive += 1;
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        waitingBackground.push(() => {
          backgroundActive += 1;
          resolve(true);
        });
      });
    }
    if (active < limit) {
      active += 1;
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      waiting.push(() => resolve(true));
    });
  }

  function release(background: boolean): void {
    if (background) {
      backgroundActive -= 1;
    }
    // Transfer the permit straight to the next waiter rather than decrementing
    // and letting it re-acquire. (Decrement-then-drain would behave identically
    // here — both are synchronous in this one body, so nothing can observe the
    // intermediate state — but transferring keeps `active` meaning exactly
    // "permits outstanding" at every point a reader could stop and check.)
    //
    // ISS-6079: interactive waiters drain FIRST. A single FIFO would hand the
    // freed permit to whoever queued earliest, which is how a background batch
    // took a permit an interactive read was already waiting on — the reservation
    // above bounds how many background ops RUN, and this bounds who gets a
    // permit next. A background waiter is only resumed when its own cap allows.
    const next = waiting.shift();
    if (next) {
      next();
      return;
    }
    // NB the cap is the ONLY term checked here, deliberately. `active` has not
    // been decremented — this path TRANSFERS the outstanding permit rather than
    // freeing and re-acquiring it — so re-using `canAdmitBackground()` would
    // test `active < limit` against a count that still includes the permit being
    // handed over, read false at a full lane, and strand the background waiter
    // until some unrelated release happened to run.
    if (backgroundActive < backgroundLimit) {
      const nextBackground = waitingBackground.shift();
      if (nextBackground) {
        nextBackground();
        return;
      }
    }
    active -= 1;
  }

  return {
    async runBounded<T>(
      task: () => Promise<T>,
      observe?: BoundedLaneObserver,
      options?: { background?: boolean }
    ): Promise<T> {
      // ISS-6079: absent => interactive. Every existing caller, and any
      // version-skewed one that cannot send the flag, therefore keeps exactly
      // today's admission behaviour; only a caller that OPTS IN is deprioritised.
      const background = options?.background === true;
      // No observer (production) means no clock reads and no timing object at
      // all — `now()` collapses to the shared no-op constant (hoisted to module
      // scope so the unobserved path allocates nothing per call) and the record
      // step is skipped. An OBSERVED trip reads the GUARDED clock, never the
      // caller's raw one: the first read below happens before `task` is
      // dispatched and the last one happens inside the `finally` that returns
      // `task`'s outcome, so an unguarded throw would have two ways to break
      // the thing it is measuring.
      const now = observe ? measuredClock : UNMEASURED_CLOCK;
      const activeOnArrival = active;
      // BOTH queues: ISS-6079 split the single FIFO into interactive and
      // background, and counting only `waiting` would report a lane with queued
      // background work as having zero waiters — precisely inverting the
      // execution-latency-vs-contention signal this row exists to provide.
      const waitingOnArrival = waiting.length + waitingBackground.length;
      const arrivedAt = now();
      if (admit) {
        await admit();
      }
      const admittedAt = now();
      const queued = await acquire(background);
      const acquiredAt = now();
      let startedAt = acquiredAt;
      try {
        // Re-consult pressure only when we waited: a fast-path acquire just
        // admitted, but a queued one may have sat here arbitrarily long and is
        // about to allocate on a stale reading.
        if (admit && queued) {
          await admit();
          startedAt = now();
        }
        return await task();
      } finally {
        release(background);
        if (observe) {
          reportLaneTiming(observe, {
            admitMs: admittedAt - arrivedAt,
            queueMs: acquiredAt - admittedAt,
            reAdmitMs: startedAt - acquiredAt,
            execMs: now() - startedAt,
            queued,
            activeOnArrival,
            waitingOnArrival,
          });
        }
      }
    },
  };
}

/**
 * Hand a completed lane trip to its observer, swallowing any observer failure.
 *
 * Fail-open in the same sense as the rest of the profiling contract: this runs
 * inside the `finally` of the op it measured, so a throwing observer would
 * otherwise replace the op's real outcome (or its real error) with an
 * instrumentation bug.
 */
function reportLaneTiming(
  observe: BoundedLaneObserver,
  timing: BoundedLaneTiming
): void {
  if (!isCompleteLaneTiming(timing)) {
    // A clock that threw or returned a non-finite value leaves at least one
    // duration as NaN. Emit nothing rather than a plausible-but-wrong number:
    // a lane row is valid or absent, never partially corrupt.
    return;
  }
  try {
    observe(timing);
  } catch {
    // Instrumentation never affects the instrumented operation.
  }
}

/**
 * Wrap a lane clock so a clock failure can never fail the op it measures.
 *
 * This is `readMonotonicMs`'s fail-open contract (`src/shared/profiling.ts`)
 * restated for the bare `() => number` shape this lane injects, and it lives at
 * the clock rather than at each of the five read sites so no future read can be
 * added outside the guard. A throwing or non-finite read yields `NaN`, which
 * propagates into the timing and is dropped whole by {@link reportLaneTiming}.
 */
function guardLaneClock(now: () => number): () => number {
  return () => {
    try {
      const value = now();
      return Number.isFinite(value) ? value : Number.NaN;
    } catch {
      // A profiling clock is not allowed to have an opinion about the op.
      return Number.NaN;
    }
  };
}

/** True when every duration in `timing` is a real, finite measurement. */
function isCompleteLaneTiming(timing: BoundedLaneTiming): boolean {
  return (
    Number.isFinite(timing.admitMs) &&
    Number.isFinite(timing.queueMs) &&
    Number.isFinite(timing.reAdmitMs) &&
    Number.isFinite(timing.execMs)
  );
}
