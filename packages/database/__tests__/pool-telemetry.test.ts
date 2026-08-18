import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DB_POOL_ACQUIRE_TIMEOUT_MS } from "../pool-config";
import {
  __resetPoolTelemetryForTests,
  instrumentPool,
  type PoolTelemetrySample,
  setPoolTelemetrySink,
} from "../pool-telemetry";

const ACQUIRE_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";

type ConnectCallback = (
  err: unknown,
  client: unknown,
  done: () => void
) => void;

/**
 * Stands in for pg-pool: dual-form `connect` (callback + promise), the four
 * counters, and the acquire/release/remove events. `connectImpl` lets a case
 * decide how an acquisition settles.
 */
class FakePool extends EventEmitter {
  options = { max: 20 };

  totalCount = 0;

  idleCount = 0;

  waitingCount = 0;

  connectImpl: () => Promise<unknown> = () => Promise.resolve({ id: "client" });

  connect(cb?: ConnectCallback): unknown {
    const done = () => undefined;
    if (typeof cb === "function") {
      this.connectImpl().then(
        (client) => cb(null, client, done),
        (err) => cb(err, undefined, done)
      );
      return;
    }
    return this.connectImpl();
  }
}

function makePool(): Pool {
  return new FakePool() as unknown as Pool;
}

function fakeClient(): PoolClient {
  return { id: Math.random() } as unknown as PoolClient;
}

let samples: PoolTelemetrySample[];

function metricsEmitted(): string[] {
  return samples.map((sample) => sample.metric);
}

beforeEach(() => {
  __resetPoolTelemetryForTests();
  samples = [];
  setPoolTelemetrySink((sample) => samples.push(sample));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  __resetPoolTelemetryForTests();
  vi.restoreAllMocks();
});

describe("acquire latency", () => {
  it("emits no acquire_wait for a warm-pool hit below the threshold", async () => {
    const pool = makePool();
    instrumentPool(pool);

    await pool.connect();

    expect(metricsEmitted()).not.toContain("db_pool_acquire_wait");
  });

  it("emits acquire_wait when the acquisition actually waited", async () => {
    const pool = makePool();
    const fake = pool as unknown as FakePool;
    fake.connectImpl = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ id: "client" }), 250);
      });
    instrumentPool(pool);

    const pending = pool.connect();
    await vi.advanceTimersByTimeAsync(250);
    await pending;

    const wait = samples.find((s) => s.metric === "db_pool_acquire_wait");
    expect(wait).toBeDefined();
    expect(wait?.value).toBeGreaterThanOrEqual(250);
  });

  it("reports counters as they were at entry, not as they are once the queue drained", async () => {
    // Regression (found against real pg): reading counters on settle described
    // the moment the pressure ended — a contended acquire reported
    // waitingCount: 0 because by then it had been dequeued.
    const pool = makePool();
    const fake = pool as unknown as FakePool;
    fake.totalCount = 20;
    fake.idleCount = 0;
    fake.waitingCount = 9;
    fake.connectImpl = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          // The queue drains while this acquisition is in flight.
          fake.waitingCount = 0;
          fake.idleCount = 5;
          resolve({ id: "client" });
        }, 50);
      });
    instrumentPool(pool);

    const pending = pool.connect();
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    const wait = samples.find((s) => s.metric === "db_pool_acquire_wait");
    expect(wait?.waitingCount).toBe(9);
    expect(wait?.idle).toBe(0);
  });

  it("never throttles an acquire that was saturated at entry", async () => {
    // Regression (found against real pg): a cold-connect handshake counts as a
    // wait, and under the plain 1/s throttle it consumed the budget and silently
    // suppressed the genuine contention that followed — the exact signal this
    // feature exists to capture.
    const pool = makePool();
    const fake = pool as unknown as FakePool;

    // First, an unsaturated wait (a handshake) — this arms the throttle.
    fake.totalCount = 1;
    fake.idleCount = 1;
    fake.waitingCount = 0;
    fake.connectImpl = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ id: "cold" }), 50);
      });
    instrumentPool(pool);
    const cold = pool.connect();
    await vi.advanceTimersByTimeAsync(50);
    await cold;
    expect(
      samples.filter((s) => s.metric === "db_pool_acquire_wait")
    ).toHaveLength(1);

    // Now a saturated (contended) wait well inside the 1s throttle window.
    samples.length = 0;
    fake.totalCount = 20;
    fake.idleCount = 0;
    fake.waitingCount = 3;
    fake.connectImpl = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ id: "contended" }), 100);
      });
    const contended = pool.connect();
    await vi.advanceTimersByTimeAsync(100);
    await contended;

    expect(
      samples.filter((s) => s.metric === "db_pool_acquire_wait")
    ).toHaveLength(1);
  });

  it("still throttles repeated unsaturated waits", async () => {
    const pool = makePool();
    const fake = pool as unknown as FakePool;
    fake.totalCount = 1;
    fake.idleCount = 1;
    fake.connectImpl = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ id: "cold" }), 50);
      });
    instrumentPool(pool);

    const first = pool.connect();
    await vi.advanceTimersByTimeAsync(50);
    await first;
    samples.length = 0;

    const second = pool.connect();
    await vi.advanceTimersByTimeAsync(50);
    await second;

    expect(metricsEmitted()).not.toContain("db_pool_acquire_wait");
  });

  it("carries pool counters and poolMax as attributes, not tags", async () => {
    const pool = makePool();
    const fake = pool as unknown as FakePool;
    fake.totalCount = 20;
    fake.idleCount = 0;
    fake.waitingCount = 7;
    fake.connectImpl = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ id: "client" }), 50);
      });
    instrumentPool(pool);

    const pending = pool.connect();
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    const wait = samples.find((s) => s.metric === "db_pool_acquire_wait");
    expect(wait).toMatchObject({
      poolMax: 20,
      waitingCount: 7,
      inUse: 20,
      idle: 0,
      total: 20,
    });
  });
});

describe("acquire timeout", () => {
  it("emits acquire_timeout and rethrows so the caller still fails", async () => {
    const pool = makePool();
    const fake = pool as unknown as FakePool;
    fake.connectImpl = () => Promise.reject(new Error(ACQUIRE_TIMEOUT_MESSAGE));
    instrumentPool(pool);

    await expect(pool.connect()).rejects.toThrow(ACQUIRE_TIMEOUT_MESSAGE);

    const timeout = samples.find((s) => s.metric === "db_pool_acquire_timeout");
    expect(timeout).toBeDefined();
    expect(timeout?.count).toBe(1);
  });

  it("also records the wait, so the distribution is not truncated at its worst end", async () => {
    const pool = makePool();
    const fake = pool as unknown as FakePool;
    fake.connectImpl = () =>
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error(ACQUIRE_TIMEOUT_MESSAGE)),
          DB_POOL_ACQUIRE_TIMEOUT_MS
        );
      });
    instrumentPool(pool);

    const pending = pool.connect();
    const assertion = expect(pending).rejects.toThrow(ACQUIRE_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(DB_POOL_ACQUIRE_TIMEOUT_MS);
    await assertion;

    const wait = samples.find((s) => s.metric === "db_pool_acquire_wait");
    expect(wait?.value).toBeGreaterThanOrEqual(DB_POOL_ACQUIRE_TIMEOUT_MS);
  });

  it("aggregates the direct warning per window while the metric counts every timeout", async () => {
    // Steady-state saturation retires timeouts at the arrival rate — pg-pool's
    // `_pendingQueue` is unbounded — so an unthrottled warn converges on the
    // request rate exactly during an outage. The warn is the alert (one per
    // window, carrying what it suppressed); the metric is the counter.
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pool = makePool();
    const fake = pool as unknown as FakePool;
    fake.connectImpl = () => Promise.reject(new Error(ACQUIRE_TIMEOUT_MESSAGE));
    instrumentPool(pool);

    for (let i = 0; i < 4; i += 1) {
      await expect(pool.connect()).rejects.toThrow(ACQUIRE_TIMEOUT_MESSAGE);
    }

    const reports = warn.mock.calls
      .map(([first]) => (typeof first === "string" ? first : ""))
      .filter((line) => line.includes('"db_pool.acquire_timeout"'));
    expect(reports).toHaveLength(1);
    const report = JSON.parse(reports[0]) as {
      message: string;
      suppressedSinceLastReport: number;
    };
    // The literal the `cl-api — pg pool-acquire timeouts` monitor alerts on.
    expect(report.message).toContain(ACQUIRE_TIMEOUT_MESSAGE);
    expect(report.suppressedSinceLastReport).toBe(0);
    expect(
      samples.filter((s) => s.metric === "db_pool_acquire_timeout")
    ).toHaveLength(4);

    // Crossing the window reports the three that were suppressed behind it.
    vi.setSystemTime(new Date("2026-08-10T00:00:10.000Z"));
    await expect(pool.connect()).rejects.toThrow(ACQUIRE_TIMEOUT_MESSAGE);

    const later = warn.mock.calls
      .map(([first]) => (typeof first === "string" ? first : ""))
      .filter((line) => line.includes('"db_pool.acquire_timeout"'));
    expect(later).toHaveLength(2);
    expect(
      (JSON.parse(later[1]) as { suppressedSinceLastReport: number })
        .suppressedSinceLastReport
    ).toBe(3);
    expect(
      samples.filter((s) => s.metric === "db_pool_acquire_timeout")
    ).toHaveLength(5);
  });

  it("does not count pg's handshake timeout as an acquire timeout", async () => {
    const pool = makePool();
    const fake = pool as unknown as FakePool;
    fake.connectImpl = () =>
      Promise.reject(
        new Error("Connection terminated due to connection timeout")
      );
    instrumentPool(pool);

    await expect(pool.connect()).rejects.toThrow("Connection terminated");

    expect(metricsEmitted()).not.toContain("db_pool_acquire_timeout");
  });
});

describe("connect wrapper contract", () => {
  it("forwards all three callback args, including done", async () => {
    const pool = makePool();
    instrumentPool(pool);

    const received: unknown[] = [];
    (pool.connect as unknown as (cb: ConnectCallback) => void)(
      (err, client, done) => {
        received.push(err, client, done);
      }
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(received).toHaveLength(3);
    // Dropping `done` would leak the client back to no one.
    expect(typeof received[2]).toBe("function");
  });

  it("never lets a throwing sink break a query", async () => {
    const pool = makePool();
    const fake = pool as unknown as FakePool;
    fake.connectImpl = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ id: "client" }), 50);
      });
    setPoolTelemetrySink(() => {
      throw new Error("sink exploded");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    instrumentPool(pool);

    const pending = pool.connect();
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toBeDefined();
  });

  it("is idempotent — re-instrumenting does not stack wrappers or listeners", () => {
    const pool = makePool();
    instrumentPool(pool);
    const afterFirst = pool.connect;
    instrumentPool(pool);

    expect(pool.connect).toBe(afterFirst);
    expect((pool as unknown as FakePool).listenerCount("acquire")).toBe(1);
  });
});

describe("checkout duration", () => {
  it("emits once on release, using the acquire→release span", () => {
    const pool = makePool();
    instrumentPool(pool);
    const client = fakeClient();

    pool.emit("acquire", client);
    vi.advanceTimersByTime(5000);
    pool.emit("release", undefined, client);

    const checkouts = samples.filter(
      (s) => s.metric === "db_pool_checkout_duration"
    );
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]?.value).toBeGreaterThanOrEqual(5000);
  });

  it("emits on remove when the client never released", () => {
    const pool = makePool();
    instrumentPool(pool);
    const client = fakeClient();

    pool.emit("acquire", client);
    vi.advanceTimersByTime(300_000);
    pool.emit("remove", client);

    const checkouts = samples.filter(
      (s) => s.metric === "db_pool_checkout_duration"
    );
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]?.value).toBeGreaterThanOrEqual(300_000);
  });

  it("does not double-count when release is followed by a later remove", () => {
    // Regression: pg removes a client on idle timeout long after release. If the
    // acquire timestamp survived the release, this remove would report a
    // fabricated ~10-minute checkout and poison p95/max.
    const pool = makePool();
    instrumentPool(pool);
    const client = fakeClient();

    pool.emit("acquire", client);
    vi.advanceTimersByTime(2000);
    pool.emit("release", undefined, client);
    vi.advanceTimersByTime(10 * 60 * 1000);
    pool.emit("remove", client);

    const checkouts = samples.filter(
      (s) => s.metric === "db_pool_checkout_duration"
    );
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]?.value).toBeLessThan(10_000);
  });

  it("emits nothing for a client removed without ever being acquired", () => {
    const pool = makePool();
    instrumentPool(pool);

    pool.emit("remove", fakeClient());

    expect(metricsEmitted()).not.toContain("db_pool_checkout_duration");
  });
});

describe("utilization gauges", () => {
  it("samples pool shape at connect entry, then throttles", async () => {
    const pool = makePool();
    const fake = pool as unknown as FakePool;
    fake.totalCount = 12;
    fake.idleCount = 4;
    fake.waitingCount = 0;
    instrumentPool(pool);

    await pool.connect();

    expect(metricsEmitted()).toEqual(
      expect.arrayContaining([
        "db_pool_in_use",
        "db_pool_idle",
        "db_pool_total",
        "db_pool_wait_queue_depth",
      ])
    );
    expect(samples.find((s) => s.metric === "db_pool_in_use")?.value).toBe(8);

    samples.length = 0;
    await pool.connect();
    expect(samples).toHaveLength(0);

    vi.advanceTimersByTime(10_000);
    await pool.connect();
    expect(metricsEmitted()).toContain("db_pool_in_use");
  });

  it("reports the DATABASE_URL branch's effective max of 10, not the IAM branch's 20", async () => {
    const pool = makePool();
    (pool as unknown as FakePool).options = { max: 10 };
    instrumentPool(pool);

    await pool.connect();

    expect(samples.find((s) => s.metric === "db_pool_in_use")?.poolMax).toBe(
      10
    );
  });
});

describe("unregistered sink", () => {
  it("drops samples without throwing, and says so exactly once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setPoolTelemetrySink(null);
    const pool = makePool();
    instrumentPool(pool);

    await expect(pool.connect()).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(10_000);
    await pool.connect();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "db_pool_telemetry.sink_missing"
    );
  });
});
