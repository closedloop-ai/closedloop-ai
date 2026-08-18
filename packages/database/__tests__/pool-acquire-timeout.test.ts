import { EventEmitter } from "node:events";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DB_POOL_ACQUIRE_TIMEOUT_MS,
  DB_POOL_MAX_DATABASE_URL_DEFAULT,
} from "../pool-config";
import {
  __resetPoolTelemetryForTests,
  instrumentPool,
} from "../pool-telemetry";

/**
 * FEA-3315 — what `connectionTimeoutMillis` actually buys.
 *
 * These cases drive a REAL `pg.Pool`, not a stand-in, because the behaviour
 * under test belongs to pg-pool rather than to this package: it only arms a
 * timer for a queued caller when `connectionTimeoutMillis` is set
 * (`pg-pool@3.13.0/index.js:206` short-circuits to an untimed
 * `_pendingQueue.push` otherwise). A fake pool could not tell the two apart.
 *
 * `Client` is swapped for a stub so no database is required; everything else —
 * the queue, the timer, the error — is pg's own.
 */
class StubClient extends EventEmitter {
  connect(cb: (err: Error | null, client: StubClient) => void): void {
    process.nextTick(() => cb(null, this));
  }

  query(): Promise<{ rows: unknown[] }> {
    return Promise.resolve({ rows: [] });
  }

  end(cb?: () => void): Promise<void> {
    cb?.();
    return Promise.resolve();
  }

  release(): void {
    // pg-pool attaches its own release; this satisfies the type only.
  }
}

const ACQUIRE_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";
const EPOCH = new Date("2026-08-10T00:00:00.000Z");

/** Build a saturated pool of `max: 1` and return the queued second acquisition. */
async function saturate(
  config: Record<string, unknown>
): Promise<{ pool: pg.Pool; queued: Promise<unknown> }> {
  const pool = new pg.Pool({
    Client: StubClient as unknown as typeof pg.Client,
    max: 1,
    ...config,
  });
  await pool.connect();
  return { pool, queued: pool.connect() };
}

beforeEach(() => {
  __resetPoolTelemetryForTests();
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
});

afterEach(() => {
  vi.useRealTimers();
  __resetPoolTelemetryForTests();
  vi.restoreAllMocks();
});

describe("pg pool acquire timeout", () => {
  it("rejects a queued caller with the classified error once the bound elapses", async () => {
    const { queued } = await saturate({
      connectionTimeoutMillis: DB_POOL_ACQUIRE_TIMEOUT_MS,
    });

    let settled = false;
    const assertion = expect(queued).rejects.toThrow(ACQUIRE_TIMEOUT_MESSAGE);
    queued.catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(DB_POOL_ACQUIRE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(settled).toBe(true);
  });

  it("never settles a queued caller when no timeout is configured", async () => {
    // The counterfactual, and the whole reason FEA-3315 exists: with the option
    // absent, pg-pool arms no timer at all, so the caller is not slow — it is
    // permanently stuck. Asserted with fake timers rather than a wall-clock
    // sleep, so this is a statement about the queue and not about elapsed time.
    const { pool, queued } = await saturate({});

    let settled = false;
    queued.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await vi.advanceTimersByTimeAsync(DB_POOL_ACQUIRE_TIMEOUT_MS * 10);

    expect(settled).toBe(false);
    expect(pool.waitingCount).toBe(1);
  });
});

describe("pool acquire timeout reporting", () => {
  it("reports every timeout on stderr with the monitored phrase, even with no telemetry sink", async () => {
    // apps/mcp registers no sink, so the sample path emits nothing there. The
    // failure must still reach the log stream the `cl-api — pg pool-acquire
    // timeouts` monitor pattern reads.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { pool, queued } = await saturate({
      connectionTimeoutMillis: DB_POOL_ACQUIRE_TIMEOUT_MS,
    });
    instrumentPool(pool);
    const requeued = pool.connect();

    const assertions = Promise.allSettled([queued, requeued]);
    await vi.advanceTimersByTimeAsync(DB_POOL_ACQUIRE_TIMEOUT_MS);
    await assertions;

    const reports = warn.mock.calls
      .map(([first]) => (typeof first === "string" ? first : ""))
      .filter((line) => line.includes('"db_pool.acquire_timeout"'));

    expect(reports).toHaveLength(1);
    const report = JSON.parse(reports[0]) as {
      level: string;
      status: string;
      message: string;
      waitedMs: number;
      poolMax: number;
      waitingCount: number;
    };
    expect(report.level).toBe("warn");
    // `status` is Datadog's reserved severity attribute; `level` alone leaves
    // the line's severity to per-service level remapping (ISS-6341).
    expect(report.status).toBe("warn");
    expect(report.message).toContain(ACQUIRE_TIMEOUT_MESSAGE);
    expect(report.waitedMs).toBeGreaterThanOrEqual(DB_POOL_ACQUIRE_TIMEOUT_MS);
    expect(report.poolMax).toBe(1);
    expect(report.waitingCount).toBeGreaterThanOrEqual(1);
  });
});

describe("pool-config contract", () => {
  it("keeps the DATABASE_URL ceiling at pg's default rather than raising it", () => {
    // Raising `max` is the tempting non-fix: task count x pool size marches
    // toward the server's `max_connections` ceiling (SQLSTATE 53300) and turns
    // an app-level failure into a database-level one. PRD-528 non-goals it.
    expect(DB_POOL_MAX_DATABASE_URL_DEFAULT).toBe(10);
  });

  it("keeps the acquire bound at the 30s the monitor runbook documents", () => {
    // Every other timeout assertion in this suite derives from the constant, so
    // without this the value could move to 1ms or 5m and leave the suite green.
    // 30s is the number the `cl-api — pg pool-acquire timeouts` runbook states.
    expect(DB_POOL_ACQUIRE_TIMEOUT_MS).toBe(30_000);
  });
});
