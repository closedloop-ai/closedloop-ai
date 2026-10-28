import type { Pool, PoolClient } from "pg";
import { willQueueForPermit } from "./acquisition-budget";
import { DB_POOL_ACQUIRE_TIMEOUT_MESSAGE } from "./pool-config";
import { createServerGlobalSlot } from "./server-global-slot";

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
 * By default these lines are JSON on stderr. `status` is Datadog's reserved
 * severity attribute and `level` is not, so a line carrying only `level` is
 * indexed at whatever severity per-service level remapping happens to assign.
 * Both are stamped at the source instead (ISS-6341) — the same fix the shared
 * logger applies, which this package still cannot import, per the above.
 *
 * ## Why the warning writer is injectable too (ISS-5853)
 *
 * stderr reaches Datadog only where the platform ships it. On Vercel that is
 * the log drain; on ECS it is CloudWatch alone, so `apps/mcp`'s warnings never
 * arrived: over 15d to 2026-09-22 its `db_pool_telemetry.sink_missing` line
 * appeared 25 times in CloudWatch and 0 times in Datadog. A consumer whose
 * logger ships to Datadog registers it with `setPoolWarningWriter()`; one that
 * registers nothing keeps the stderr line, which is `apps/api`'s path.
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

/** A point-in-time reading of the pool's counters, carried on every sample. */
type PoolCounters = {
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

/**
 * One acquisition's wait — the only metric that describes an acquisition, so
 * the only one that carries `saturated` and `permitQueued`, and it always
 * carries both. They are required rather than optional because an omitted
 * attribute and a measured `false` are different query results: an adapter
 * that could drop them would silently recreate the ambiguity they remove.
 *
 * WHY THEY ARE EMITTED RATHER THAN DERIVED AT QUERY TIME (ISS-10293). A wait is
 * several findings wearing one number, and a dashboard reading p95
 * `db_pool_acquire_wait` reads all of it as contention. `saturated` is a
 * comparison between two attributes, which a Datadog log query cannot express,
 * and `permitQueued` is decided by state no attribute carries at all.
 *
 * Both are booleans, so they are safe to promote to metric tags; every other
 * field stays a log attribute. `packages/observability/README.md` carries the
 * query contract and the sampling caveat: an unsaturated wait below 1s is
 * throttled and a saturated one never is, so neither counts nor percentiles
 * compare across the two.
 */
type PoolAcquireWaitSample = PoolCounters & {
  metric: "db_pool_acquire_wait";
  /** ms, from the caller's arrival — so it includes any permit wait. */
  value: number;
  count?: never;
  /**
   * The pool had nothing to give when this caller ARRIVED: no idle connection
   * and no headroom to open one (`idle === 0 && total >= poolMax`).
   *
   * `false` is not "a connection was free" — `idle === 0` below `poolMax` is
   * connection establishment, which `@idle` separates. Nor is it proof the
   * caller did not queue: `idle` does not yet reflect siblings that arrived in
   * the same tick, so at the ceiling a fan-out wider than `idle` queues
   * anyway. And when `permitQueued` is true it describes the pool the caller
   * arrived at, not the one it reached once the permit was granted, which is
   * not observed.
   */
  saturated: boolean;
  /**
   * The caller's own unit of work had already spent its acquisition budget
   * (`gateDbAcquisitions`), so it queued for a permit before it could reach
   * the pool. That wait sits inside `value` and is neither pool contention nor
   * the event loop: its fix is that unit of work's fan-out.
   */
  permitQueued: boolean;
};

/** Every other metric. None describes a wait, so none carries the labels. */
type PoolStateSample = PoolCounters & {
  metric: Exclude<PoolTelemetryMetric, "db_pool_acquire_wait">;
  /** Gauge or measurement (ms for durations). Mutually exclusive with `count`. */
  value?: number;
  /** Additive counter; always 1. Mutually exclusive with `value`. */
  count?: number;
  saturated?: never;
  permitQueued?: never;
};

export type PoolTelemetrySample = PoolAcquireWaitSample | PoolStateSample;

export type PoolTelemetrySink = (sample: PoolTelemetrySample) => void;

/** What a wait was, decided at the caller's arrival. */
type WaitLabels = Pick<PoolAcquireWaitSample, "saturated" | "permitQueued">;

/** A sample without the counters `emit` stamps on, per metric. */
type SampleBody<T = PoolTelemetrySample> = T extends PoolTelemetrySample
  ? Omit<T, keyof PoolCounters>
  : never;

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

const INSTRUMENTED = Symbol.for(
  "closedloop.database.poolTelemetryInstrumented"
);

type ConnectCallback = (
  err: Error,
  client: PoolClient,
  done: () => void
) => void;
type InstrumentablePool = Pool & { [INSTRUMENTED]?: true };

/**
 * Where the registered sink lives: one process-wide slot, not a module-local
 * binding (ISS-6942).
 *
 * `apps/api` registers from its instrumentation entry while every reader is
 * reached from route code, and Turbopack emits this module into more than one
 * chunk group. A module-local `let` is therefore written in one copy and read
 * in another — the third instance of the defect ISS-5857 and ISS-6817 fixed in
 * `@repo/observability`. The throttle and warn-once state below stays
 * module-local on purpose: those bound cost per copy, they do not carry a
 * registration across one.
 */
const sinkSlot = createServerGlobalSlot<PoolTelemetrySink>(
  "closedloop.database.poolTelemetrySink"
);

/** Where the injected warning writer lives; process-wide for the same reason as the sink. */
const warningWriterSlot = createServerGlobalSlot<PoolWarningWriter>(
  "closedloop.database.poolWarningWriter"
);

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
  sinkSlot.set(next);
}

/**
 * Install the writer for this module's warning lines (sink missing, sink
 * failed, acquire timeout). Last registration wins; `null` restores stderr.
 */
export function setPoolWarningWriter(next: PoolWarningWriter | null): void {
  warningWriterSlot.set(next);
}

/** Test-only: clear sink, writer and throttle state so cases cannot leak into each other. */
export function __resetPoolTelemetryForTests(): void {
  sinkSlot.set(null);
  warningWriterSlot.set(null);
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
    // Labelled here for the same reason. In production `original` is the
    // acquisition gate, called synchronously below, so this is the instant —
    // and the predicate — on which it decides whether this caller queues for a
    // permit.
    const labels: WaitLabels = {
      saturated: wasPoolSaturated(entry),
      permitQueued: willQueueForPermit(pool),
    };
    maybeSampleGauges(entry);

    if (typeof cb === "function") {
      // Forward all three args verbatim — dropping `done` would leak clients.
      return original((err, client, done) => {
        recordAcquire(startedAt, entry, labels, err);
        cb(err, client, done);
      });
    }

    // Chain off pg-pool's own promise rather than re-wrapping it, so its
    // configured Promise implementation and rejection semantics are preserved.
    const result = original() as Promise<PoolClient>;
    return result.then(
      (client) => {
        recordAcquire(startedAt, entry, labels, null);
        return client;
      },
      (err: unknown) => {
        recordAcquire(startedAt, entry, labels, err);
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
  labels: WaitLabels,
  err: unknown
): void {
  try {
    const waitedMs = Date.now() - startedAt;
    if (isAcquireTimeout(err)) {
      reportAcquireTimeout(entry, labels, waitedMs);
      emit(entry, { metric: "db_pool_acquire_timeout", count: 1 });
      // Also record the wait itself: a timed-out caller waited the full
      // `connectionTimeoutMillis`. Dropping it would truncate the wait
      // distribution exactly at its worst end.
      emit(entry, {
        metric: "db_pool_acquire_wait",
        value: waitedMs,
        ...labels,
      });
      return;
    }

    if (waitedMs < ACQUIRE_WAIT_THRESHOLD_MS) {
      return;
    }

    // A wait can mean the pool was saturated and this caller queued behind it
    // (the failure mode this exists to catch), or several things that are not
    // pool contention — see the labels on `PoolAcquireWaitSample`.
    //
    // `saturated` decides two things, and they are deliberately the same
    // predicate: saturated waits are never throttled (without this, a
    // cold-connect handshake burns the throttle budget and silently suppresses
    // the genuine contention that follows it), and it rides on the sample so a
    // reader can tell them apart. Here it only ever *promotes* a sample; a
    // misread degrades it to throttled, never to dropped. A permit wait is
    // throttled like any other unsaturated one — see `gateDbAcquisitions`.
    if (!(labels.saturated || waitedMs >= SLOW_ACQUIRE_MS)) {
      const now = Date.now();
      if (now - lastAcquireWaitAt < ACQUIRE_WAIT_THROTTLE_MS) {
        return;
      }
      lastAcquireWaitAt = now;
    }

    emit(entry, { metric: "db_pool_acquire_wait", value: waitedMs, ...labels });
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
  return (
    err instanceof Error && err.message === DB_POOL_ACQUIRE_TIMEOUT_MESSAGE
  );
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

function emit(counters: PoolCounters, sample: SampleBody): void {
  const sink = sinkSlot.read();
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
 */
function warnSinkMissingOnce(): void {
  if (warnedSinkMissing) {
    return;
  }
  warnedSinkMissing = true;
  writeWarning({
    level: "warn",
    status: "warn",
    event: "db_pool_telemetry.sink_missing",
    message:
      "database: pool telemetry is not wired up; samples are being dropped. Call setPoolTelemetrySink() during startup to emit them.",
  });
}

function warnSinkThrewOnce(): void {
  if (warnedSinkThrew) {
    return;
  }
  warnedSinkThrew = true;
  writeWarning({
    level: "warn",
    status: "warn",
    event: "db_pool_telemetry.sink_failed",
    message:
      "database: the pool telemetry sink threw; samples are being dropped. Queries are unaffected.",
  });
}

/**
 * Report a pool-acquire timeout as a warning line, aggregated, in addition to
 * the metric sample (FEA-3315).
 *
 * A timeout is not a sample that can be dropped for lack of a sink. It means a
 * caller waited the full `DB_POOL_ACQUIRE_TIMEOUT_MS` and then failed because
 * the pool was starved — the 2026-07-15 mechanism — and the consumer that most
 * needs to see it is exactly the one with no sink: `apps/mcp` registers none
 * (its narrow Docker context is why this module has no `@repo/*` imports), so
 * without this the whole event would reduce to one generic "sink missing" line
 * per process. It registers a warning writer instead, so this line ships.
 *
 * The message embeds pg's verbatim `timeout exceeded when trying to connect`
 * because that literal — not the metric, which no rule reads — is what the
 * `cl-api / cl-mcp — pg pool-acquire timeouts` Datadog monitor alerts on. The
 * monitor reads the agentless `source:nodejs` path only, so this line reaches it
 * only through a registered writer (`apps/mcp` registers its logger, ISS-5853).
 * On stderr, `apps/api`'s copy lands on the Vercel drain, which that monitor
 * excludes; cl-api pages on its request error logs instead.
 *
 * The literal is on every line; the cause after it is not (ISS-10293). The
 * acquisition gate fails a permit wait with the same literal, so a timeout is
 * not proof of a starved pool, and a line claiming one would send an operator
 * to the pool for a unit of work's own fan-out. The labels describe the
 * reported caller only — `suppressedSinceLastReport` is not split by them.
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
 * The writer is injected rather than imported, the same constraint documented
 * at the top of this file.
 */
function reportAcquireTimeout(
  counters: PoolCounters,
  labels: WaitLabels,
  waitedMs: number
): void {
  const now = Date.now();
  if (now - lastAcquireTimeoutWarnAt < ACQUIRE_TIMEOUT_WARN_WINDOW_MS) {
    suppressedAcquireTimeouts += 1;
    return;
  }
  lastAcquireTimeoutWarnAt = now;
  const suppressedSinceLastReport = suppressedAcquireTimeouts;
  suppressedAcquireTimeouts = 0;

  writeWarning({
    level: "warn",
    status: "warn",
    event: "db_pool.acquire_timeout",
    message: `database: ${DB_POOL_ACQUIRE_TIMEOUT_MESSAGE} — ${describeTimeoutCause(labels)}`,
    waitedMs,
    suppressedSinceLastReport,
    ...counters,
    ...labels,
  });
}

function describeTimeoutCause({ saturated, permitQueued }: WaitLabels): string {
  if (permitQueued) {
    return "this caller's unit of work had already spent its acquisition budget, so it queued for a permit before reaching the pool, and the queue that expired may be that one rather than the pool's.";
  }
  if (saturated) {
    return "the pg pool is saturated and this caller failed to acquire a connection.";
  }
  return "the pg pool was not saturated when this caller arrived, and what it then waited behind (callers that reached the pool first, or a slow new connection) is not recorded here.";
}

/**
 * Whether the pool had nothing to give when an acquisition started: no idle
 * connection AND no headroom to open one.
 *
 * `idle === 0` alone is not the same predicate and is the one an operator
 * reaches for when re-deriving this from the emitted attributes — a pool below
 * its ceiling can open a new connection, so a wait there is handshake or
 * event-loop time, not queueing.
 */
function wasPoolSaturated(counters: PoolCounters): boolean {
  return counters.idle === 0 && counters.total >= counters.poolMax;
}

/**
 * One warning line: an `event` name, the message, and the fields beside it.
 * `level` and `status` travel with it so the stderr default stays byte-for-byte
 * what it was before the writer existed.
 */
export type PoolWarning = {
  level: "warn";
  status: "warn";
  event: string;
  message: string;
} & Record<string, unknown>;

export type PoolWarningWriter = (warning: PoolWarning) => void;

/**
 * Hand a warning to the registered writer, else to stderr. A writer that
 * throws falls back to stderr, which keeps the stderr copy of the line.
 */
function writeWarning(warning: PoolWarning): void {
  const writer = warningWriterSlot.read();
  if (writer) {
    try {
      writer(warning);
      return;
    } catch {
      // fall through to stderr
    }
  }
  console.warn(JSON.stringify(warning));
}
