import type { Pool, PoolClient } from "pg";

/**
 * Connection-pool telemetry for the runtime pg pool (FEA-3300).
 *
 * ## Why the emitter is injected rather than imported
 *
 * This package deliberately has no `@repo/observability` dependency. `apps/mcp`
 * consumes `@repo/database` through a narrow Docker context that copies an
 * explicit list of workspace packages; a static `@repo/observability` import
 * here would type-check and build green locally, then fail at runtime inside the
 * mcp image. So the emitter is injected: `apps/api` calls
 * `setPoolTelemetrySink()` from its `register()` hook, and any consumer that
 * never registers a sink simply emits nothing (and says so once — see
 * `warnSinkMissingOnce`).
 *
 * ## Why contention is measured, not sampled
 *
 * The failure this exists to catch is triggered by *simultaneity*, not volume:
 * one request fanning out N concurrent queries against a pool of `max` starves
 * every other caller for as long as it holds the connections. A periodic gauge
 * is a low-frequency instrument aimed at a high-frequency event and can miss a
 * multi-second saturation entirely. So `db_pool_acquire_wait` times *every*
 * acquisition and emits only once the measured wait crosses a threshold: a warm
 * pool hit is sub-millisecond and emits nothing, while every contended
 * acquisition is recorded.
 *
 * ## Why every warning line carries both `status` and `level`
 *
 * These lines reach Datadog as JSON on stderr. `status` is Datadog's reserved
 * severity attribute and `level` is not, so a line carrying only `level` is
 * indexed at whatever severity per-service level remapping happens to assign.
 * Both are stamped at the source instead (ISS-6341) — the same fix the shared
 * logger applies, which this package still cannot import, per the above.
 */

/** Emitted metric names. `snake_case`, no dots, per the observability naming convention. */
export type PoolTelemetryMetric =
  | "db_pool_acquire_wait"
  | "db_pool_acquire_timeout"
  | "db_pool_checkout_duration"
  | "db_pool_wait_queue_depth"
  | "db_pool_in_use"
  | "db_pool_idle"
  | "db_pool_total";

export type PoolTelemetrySample = {
  metric: PoolTelemetryMetric;
  /** Gauge or measurement (ms for durations). Mutually exclusive with `count`. */
  value?: number;
  /** Additive counter; always 1. Mutually exclusive with `value`. */
  count?: number;
  /**
   * Effective pool ceiling, read from `pool.options.max` rather than assumed:
   * the DATABASE_URL branch sets 10, the IAM branch sets 20 (both explicit
   * since FEA-3315). Carried on every sample so utilization is computable
   * without a hardcoded constant.
   */
  poolMax: number;
  /** Callers currently queued for a connection. */
  waitingCount: number;
  /** Connections checked out (`totalCount - idleCount`). */
  inUse: number;
  idle: number;
  total: number;
};

export type PoolTelemetrySink = (sample: PoolTelemetrySample) => void;

/** A point-in-time reading of the pool's counters. */
type PoolCounters = Pick<
  PoolTelemetrySample,
  "poolMax" | "waitingCount" | "inUse" | "idle" | "total"
>;

/** A wait at or above this is contention worth reporting; below it is a warm-pool hit. */
const ACQUIRE_WAIT_THRESHOLD_MS = 10;
/** Waits at or above this always emit — they are the pathological cases and define the tail. */
const SLOW_ACQUIRE_MS = 1000;
/** Sub-`SLOW_ACQUIRE_MS` waits are throttled to this cadence to bound cost under sustained mild contention. */
const ACQUIRE_WAIT_THROTTLE_MS = 1000;
/** Checkouts held at or above this always emit. */
const SLOW_CHECKOUT_MS = 1000;
/** Cadence for the direct acquire-timeout warning; see `reportAcquireTimeout`. */
const ACQUIRE_TIMEOUT_WARN_WINDOW_MS = 10_000;
/** Cadence for the steady-state utilization gauges. */
const SAMPLE_INTERVAL_MS = 10_000;

/**
 * pg-pool's queue-wait timeout, raised once `connectionTimeoutMillis` elapses
 * while a caller is queued. Matched on the exact literal so it is not confused
 * with pg-pool's *handshake* timeout ("Connection terminated due to connection
 * timeout"), which is a different failure.
 */
const ACQUIRE_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";

const INSTRUMENTED = Symbol.for(
  "closedloop.database.poolTelemetryInstrumented"
);

type ConnectCallback = (
  err: Error,
  client: PoolClient,
  done: () => void
) => void;
type InstrumentablePool = Pool & { [INSTRUMENTED]?: true };

let sink: PoolTelemetrySink | null = null;
let warnedSinkMissing = false;
let warnedSinkThrew = false;
let lastGaugeSampleAt = 0;
let lastAcquireWaitAt = 0;
let lastCheckoutEmitAt = 0;
let lastAcquireTimeoutWarnAt = 0;
let suppressedAcquireTimeouts = 0;

/** Acquire timestamp per checked-out client. Weak so an unreleased client is collected, not leaked. */
const checkoutStartedAt = new WeakMap<PoolClient, number>();

/**
 * Install the telemetry emitter. Called once from `apps/api`'s `register()`
 * hook; last registration wins. Pass `null` to disable.
 */
export function setPoolTelemetrySink(next: PoolTelemetrySink | null): void {
  sink = next;
}

/** Test-only: clear sink and throttle state so cases cannot leak into each other. */
export function __resetPoolTelemetryForTests(): void {
  sink = null;
  warnedSinkMissing = false;
  warnedSinkThrew = false;
  lastGaugeSampleAt = 0;
  lastAcquireWaitAt = 0;
  lastCheckoutEmitAt = 0;
  lastAcquireTimeoutWarnAt = 0;
  suppressedAcquireTimeouts = 0;
}

/**
 * Attach telemetry to a freshly-constructed pool, before any reference to it
 * escapes. Idempotent: re-instrumenting the same pool is a no-op, so wrappers
 * and listeners cannot stack.
 */
export function instrumentPool(pool: Pool): Pool {
  const target = pool as InstrumentablePool;
  if (target[INSTRUMENTED]) {
    return pool;
  }
  target[INSTRUMENTED] = true;

  pool.on("acquire", (client) => {
    checkoutStartedAt.set(client, Date.now());
  });
  // `release` and `remove` are both terminal; whichever fires first wins.
  pool.on("release", (_err, client) => finishCheckout(pool, client));
  pool.on("remove", (client) => finishCheckout(pool, client));

  wrapConnect(pool, target);
  return pool;
}

/**
 * pg-pool's `query()` dispatches through `this.connect`, so wrapping the
 * instance's `connect` observes both plain queries and transactions.
 */
function wrapConnect(pool: Pool, target: InstrumentablePool): void {
  const original = pool.connect.bind(pool) as (cb?: ConnectCallback) => unknown;

  const instrumented = (cb?: ConnectCallback): unknown => {
    const startedAt = Date.now();
    // Counters are read here, at entry, not on settle. By the time an
    // acquisition settles its queue has drained, so a contended acquire would
    // otherwise report waitingCount: 0 — describing the moment the pressure
    // ended rather than the moment it existed.
    const entry = readCounters(pool);
    maybeSampleGauges(entry);

    if (typeof cb === "function") {
      // Forward all three args verbatim — dropping `done` would leak clients.
      return original((err, client, done) => {
        recordAcquire(startedAt, entry, err);
        cb(err, client, done);
      });
    }

    // Chain off pg-pool's own promise rather than re-wrapping it, so its
    // configured Promise implementation and rejection semantics are preserved.
    const result = original() as Promise<PoolClient>;
    return result.then(
      (client) => {
        recordAcquire(startedAt, entry, null);
        return client;
      },
      (err: unknown) => {
        recordAcquire(startedAt, entry, err);
        throw err;
      }
    );
  };

  (target as { connect: unknown }).connect = instrumented;
}

/**
 * Record an acquisition's outcome. Never throws: telemetry must not be able to
 * break a query, and this runs before the caller's callback is forwarded.
 */
function recordAcquire(
  startedAt: number,
  entry: PoolCounters,
  err: unknown
): void {
  try {
    const waitedMs = Date.now() - startedAt;

    if (isAcquireTimeout(err)) {
      reportAcquireTimeout(entry, waitedMs);
      emit(entry, { metric: "db_pool_acquire_timeout", count: 1 });
      // Also record the wait itself: a timed-out caller waited the full
      // `connectionTimeoutMillis`. Dropping it would truncate the wait
      // distribution exactly at its worst end.
      emit(entry, { metric: "db_pool_acquire_wait", value: waitedMs });
      return;
    }

    if (waitedMs < ACQUIRE_WAIT_THRESHOLD_MS) {
      return;
    }

    // A wait can mean two very different things: the pool was saturated and this
    // caller queued behind it (the failure mode this exists to catch), or the
    // pool simply had room and paid a one-off TCP/TLS/IAM handshake. Both are
    // real waits, but only the first is contention — so saturated waits are
    // never throttled. Without this, a cold-connect handshake burns the throttle
    // budget and silently suppresses the genuine contention that follows it.
    // The predicate only ever *promotes* a sample; a misread degrades it to
    // throttled, never to dropped.
    const wasSaturated = entry.idle === 0 && entry.total >= entry.poolMax;

    if (!(wasSaturated || waitedMs >= SLOW_ACQUIRE_MS)) {
      const now = Date.now();
      if (now - lastAcquireWaitAt < ACQUIRE_WAIT_THROTTLE_MS) {
        return;
      }
      lastAcquireWaitAt = now;
    }

    emit(entry, { metric: "db_pool_acquire_wait", value: waitedMs });
  } catch {
    warnSinkThrewOnce();
  }
}

/**
 * Emit the duration a connection was checked out, on the first terminal event
 * for that client.
 *
 * Deleting the entry here is load-bearing: pg removes a client on idle timeout
 * long after it was released, so leaving the entry in place would make that
 * later `remove` report `now - acquireTime` — a fabricated multi-minute
 * checkout. Handling `remove` at all matters for the opposite reason: a client
 * dropped on connection failure never emits `release`, and those are precisely
 * the pathological holds worth seeing.
 */
function finishCheckout(pool: Pool, client: PoolClient): void {
  try {
    const startedAt = checkoutStartedAt.get(client);
    if (startedAt === undefined) {
      // Never acquired, or already accounted for by the other terminal event.
      return;
    }
    checkoutStartedAt.delete(client);

    const heldMs = Date.now() - startedAt;
    if (heldMs < SLOW_CHECKOUT_MS) {
      const now = Date.now();
      if (now - lastCheckoutEmitAt < SAMPLE_INTERVAL_MS) {
        return;
      }
      lastCheckoutEmitAt = now;
    }

    emit(readCounters(pool), {
      metric: "db_pool_checkout_duration",
      value: heldMs,
    });
  } catch {
    warnSinkThrewOnce();
  }
}

/** Steady-state pool shape, which the contention signal alone cannot describe. */
function maybeSampleGauges(counters: PoolCounters): void {
  try {
    const now = Date.now();
    if (now - lastGaugeSampleAt < SAMPLE_INTERVAL_MS) {
      return;
    }
    lastGaugeSampleAt = now;

    emit(counters, { metric: "db_pool_in_use", value: counters.inUse });
    emit(counters, { metric: "db_pool_idle", value: counters.idle });
    emit(counters, { metric: "db_pool_total", value: counters.total });
    emit(counters, {
      metric: "db_pool_wait_queue_depth",
      value: counters.waitingCount,
    });
  } catch {
    warnSinkThrewOnce();
  }
}

function isAcquireTimeout(err: unknown): boolean {
  return err instanceof Error && err.message === ACQUIRE_TIMEOUT_MESSAGE;
}

function readCounters(pool: Pool): PoolCounters {
  const total = pool.totalCount;
  const idle = pool.idleCount;
  return {
    poolMax: pool.options.max,
    waitingCount: pool.waitingCount,
    inUse: total - idle,
    idle,
    total,
  };
}

function emit(
  counters: PoolCounters,
  sample: Pick<PoolTelemetrySample, "metric" | "value" | "count">
): void {
  if (!sink) {
    warnSinkMissingOnce();
    return;
  }
  try {
    sink({ ...sample, ...counters });
  } catch {
    warnSinkThrewOnce();
  }
}

/**
 * Registering no sink is legitimate (apps/mcp does not), but it should never be
 * silent — an unwired emitter is indistinguishable from a healthy pool.
 * Warn once rather than throwing: taking a service down because telemetry is
 * unwired would invert the risk this instrumentation exists to reduce.
 * console.warn (not a logger) keeps this package dependency-free.
 */
function warnSinkMissingOnce(): void {
  if (warnedSinkMissing) {
    return;
  }
  warnedSinkMissing = true;
  console.warn(
    JSON.stringify({
      level: "warn",
      status: "warn",
      event: "db_pool_telemetry.sink_missing",
      message:
        "database: pool telemetry is not wired up; samples are being dropped. Call setPoolTelemetrySink() during startup to emit them.",
    })
  );
}

function warnSinkThrewOnce(): void {
  if (warnedSinkThrew) {
    return;
  }
  warnedSinkThrew = true;
  console.warn(
    JSON.stringify({
      level: "warn",
      status: "warn",
      event: "db_pool_telemetry.sink_failed",
      message:
        "database: the pool telemetry sink threw; samples are being dropped. Queries are unaffected.",
    })
  );
}

/**
 * Report a pool-acquire timeout on stderr, aggregated, in addition to the
 * metric sample (FEA-3315).
 *
 * A timeout is not a sample that can be dropped for lack of a sink. It means a
 * caller waited the full `DB_POOL_ACQUIRE_TIMEOUT_MS` and then failed because
 * the pool was starved — the 2026-07-15 mechanism — and the consumer that most
 * needs to see it is exactly the one with no sink: `apps/mcp` registers none
 * (its narrow Docker context is why this module has no `@repo/*` imports), so
 * without this the whole event would reduce to one generic "sink missing" line
 * per process.
 *
 * The message embeds pg's verbatim `timeout exceeded when trying to connect`
 * because that literal — not the metric, which no rule reads — is what the
 * `cl-api — pg pool-acquire timeouts` Datadog monitor alerts on. Emitting it
 * from every service that runs this pool is what makes the same monitored
 * signal reachable beyond cl-api.
 *
 * ## Why this is rate limited, and the metric is not
 *
 * There is no inherent ceiling on the warn rate. pg-pool's `_pendingQueue` is
 * unbounded, so once the pool has been saturated for a full
 * `DB_POOL_ACQUIRE_TIMEOUT_MS` every arrival enqueues and timeouts retire at
 * exactly the arrival rate — the warn rate converges on the *request* rate,
 * which is the worst possible moment to multiply logging spend. So the warn is
 * the alert, emitted first-in-window and then at most once per
 * `ACQUIRE_TIMEOUT_WARN_WINDOW_MS`, carrying `suppressedSinceLastReport` so a
 * suppressed burst is stated rather than silently dropped; the
 * `db_pool_acquire_timeout` metric stays the exact per-timeout count.
 *
 * State is two module-level scalars, so it cannot grow. The tail of a burst is
 * reported on the next timeout, not at process exit — the metric, not this
 * line, is the counter of record.
 *
 * `console.warn` rather than a logger keeps this package dependency-free, the
 * same constraint documented at the top of this file.
 */
function reportAcquireTimeout(counters: PoolCounters, waitedMs: number): void {
  const now = Date.now();
  if (now - lastAcquireTimeoutWarnAt < ACQUIRE_TIMEOUT_WARN_WINDOW_MS) {
    suppressedAcquireTimeouts += 1;
    return;
  }
  lastAcquireTimeoutWarnAt = now;
  const suppressedSinceLastReport = suppressedAcquireTimeouts;
  suppressedAcquireTimeouts = 0;

  console.warn(
    JSON.stringify({
      level: "warn",
      status: "warn",
      event: "db_pool.acquire_timeout",
      message:
        "database: timeout exceeded when trying to connect — the pg pool is saturated and this caller failed to acquire a connection.",
      waitedMs,
      suppressedSinceLastReport,
      ...counters,
    })
  );
}
