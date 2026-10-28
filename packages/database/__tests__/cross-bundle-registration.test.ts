import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSchemaBootstrapHook, withDb } from "../index";
import {
  __resetPoolTelemetryForTests,
  instrumentPool,
  type PoolTelemetrySample,
  setPoolTelemetrySink,
} from "../pool-telemetry";

// ---------------------------------------------------------------------------
// ISS-6942: both registration seams survive bundling.
//
// `apps/api` registers from `instrumentation.node.ts` while every reader is
// reached from route code, and the Turbopack build emits this package into two
// chunk groups. Confirmed in built output on the pre-fix tree: `setPoolTelemetrySink`
// and `setSchemaBootstrapHook` live only in `packages_database_0bbv58m._.js`,
// which **0 of 284** route entries load, while **274** load
// `packages_database_1f_ezet._.js` — where the bundler tree-shook both setters
// out, constant-folded the sink read away entirely (`emit` reduced to
// `function A(e,t){n||(n=!0,console.warn(…sink_missing…))}`) and left the
// bootstrap hook as a writer-less `let P=null`. Registration could never reach
// a reader, which is why FEA-3300 emitted zero `db_pool_*` samples.
//
// A second module registry reproduces that split here. Each case asserts the
// OBSERVABLE consequence through the production entry point — a sample reaching
// the sink, a hook running before the client — not that the source mentions
// `globalThis`. Sibling of `@repo/observability`'s ISS-5857 / ISS-6817 cases.
// ---------------------------------------------------------------------------

/**
 * Spelled out rather than imported from the production module, deliberately —
 * this is the attacker's view of the key, not a second declaration of ours. The
 * browser cases below plant a value the way anything sharing the realm could,
 * knowing only the registered symbol's name. Importing the key would make a
 * production rename invisible here; hard-coding it means the two cases that
 * assert the planted value IS reached go red on one, which they do.
 */
const POOL_TELEMETRY_SINK_KEY = Symbol.for(
  "closedloop.database.poolTelemetrySink"
);

const ENV_KEYS = ["DATABASE_URL", "PGHOST", "PGSCHEMA", "PGUSER"] as const;

/** `SAMPLE_INTERVAL_MS` in `../pool-telemetry`, which does not export it. */
const GAUGE_CADENCE_MS = 10_000;

const mocks = vi.hoisted(() => {
  class MockPool {
    options = { max: 10 };

    totalCount = 0;

    idleCount = 0;

    waitingCount = 0;

    on() {
      return this;
    }

    connect(cb?: (err: unknown, client: unknown, done: () => void) => void) {
      const client = { release: () => undefined };
      if (typeof cb === "function") {
        cb(null, client, () => undefined);
        return;
      }
      return Promise.resolve(client);
    }
  }

  class MockPrismaPg {}
  class MockPrismaClient {}

  return { MockPool, MockPrismaClient, MockPrismaPg };
});

vi.mock("pg", () => ({ default: { Pool: mocks.MockPool } }));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: mocks.MockPrismaPg }));
vi.mock("../generated/client", () => ({
  PrismaClient: mocks.MockPrismaClient,
}));

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.DATABASE_URL = "postgresql://user:pw@localhost:5432/app";
  // The slots are process-wide, so the unregistered state these cases assert
  // against has to be established, not assumed from a fresh module registry.
  __resetPoolTelemetryForTests();
  setSchemaBootstrapHook(null);
  resetDatabaseGlobals();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  __resetPoolTelemetryForTests();
  setSchemaBootstrapHook(null);
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  resetDatabaseGlobals();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("pool telemetry sink across module instances (ISS-6942)", () => {
  it("delivers samples to a sink registered on another module instance", async () => {
    vi.resetModules();
    // Stands in for the instrumentation entry's copy — the one
    // `registerPoolTelemetry` reaches, which is never a copy a route loads.
    const registrar = await import("../pool-telemetry");

    // Guard the guard: same instance on both sides and this would hold for the
    // ordinary single-module reason, proving nothing about the split.
    expect(registrar.setPoolTelemetrySink).not.toBe(setPoolTelemetrySink);

    const samples: PoolTelemetrySample[] = [];
    registrar.setPoolTelemetrySink((sample) => samples.push(sample));

    // Instrument and emit through the STATICALLY imported copy — the route side.
    const pool = new mocks.MockPool();
    instrumentPool(pool as never);
    await (pool.connect() as Promise<unknown>);

    expect(samples.map((sample) => sample.metric)).toContain("db_pool_in_use");
  });

  it("clears the sink for every module instance", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const registrar = await import("../pool-telemetry");
    const sink = vi.fn();
    registrar.setPoolTelemetrySink(sink);

    // Positive control. Without it the assertion at the end is satisfied by
    // the sink never having reached this copy AT ALL — which is the pre-fix
    // state, not a clear that propagated. It also fails if `set` is a no-op.
    const beforeClear = new mocks.MockPool();
    instrumentPool(beforeClear as never);
    await (beforeClear.connect() as Promise<unknown>);
    expect(sink).toHaveBeenCalled();
    const callsBeforeClear = sink.mock.calls.length;

    registrar.setPoolTelemetrySink(null);

    // Past the gauge cadence, so the second acquisition is not merely throttled
    // — otherwise "no new calls" would hold with the sink still registered.
    vi.advanceTimersByTime(GAUGE_CADENCE_MS);
    const afterClear = new mocks.MockPool();
    instrumentPool(afterClear as never);
    await (afterClear.connect() as Promise<unknown>);

    expect(sink).toHaveBeenCalledTimes(callsBeforeClear);
  });
});

// Single-instance by design: this is the slot's own value contract, not the
// cross-instance seam. It lives in its own block so the count of cases above
// is not read as covering more of the seam than it does.
describe("slot value contract (ISS-6942)", () => {
  it("treats a non-callable value in the slot as no sink", async () => {
    // The slot is writable by anything sharing the realm. Reading a planted
    // non-function back as present would throw inside `emit` on every acquire.
    (globalThis as Record<symbol, unknown>)[POOL_TELEMETRY_SINK_KEY] =
      "not-a-sink";

    const pool = new mocks.MockPool();
    instrumentPool(pool as never);

    await expect(pool.connect() as Promise<unknown>).resolves.toBeDefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("db_pool_telemetry.sink_missing")
    );
  });
});

describe("schema bootstrap hook across module instances (ISS-6942)", () => {
  it("runs a hook registered on another module instance", async () => {
    vi.resetModules();
    const registrar = await import("../index");

    expect(registrar.setSchemaBootstrapHook).not.toBe(setSchemaBootstrapHook);

    const hook = vi.fn(() => Promise.resolve());
    registrar.setSchemaBootstrapHook(hook);

    // Drive the STATICALLY imported `withDb` — the route side.
    await withDb(() => null);

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("clears the hook for every module instance", async () => {
    vi.resetModules();
    const registrar = await import("../index");
    const hook = vi.fn(() => Promise.resolve());
    registrar.setSchemaBootstrapHook(hook);

    // Positive control. Without it the assertion at the end is satisfied two
    // ways that are not a clear: the hook never reaching this copy at all (the
    // pre-fix state), or `getDatabase` short-circuiting on a cached client and
    // never reading the slot.
    await withDb(() => null);
    expect(hook).toHaveBeenCalledTimes(1);

    registrar.setSchemaBootstrapHook(null);
    // A cached client skips the hook read entirely, so the second call has to
    // run against a cold instance for its result to mean anything.
    resetDatabaseGlobals();

    await withDb(() => null);

    expect(hook).toHaveBeenCalledTimes(1);
  });
});

describe("browser runtimes (ISS-6942)", () => {
  it("ignores a sink planted on globalThis by browser-side code", async () => {
    vi.stubGlobal("window", {});
    vi.resetModules();
    const browserModule = await import("../pool-telemetry");
    const planted = vi.fn();
    (globalThis as Record<symbol, unknown>)[POOL_TELEMETRY_SINK_KEY] = planted;

    const pool = new mocks.MockPool();
    browserModule.instrumentPool(pool as never);
    await (pool.connect() as Promise<unknown>);

    expect(planted).not.toHaveBeenCalled();
  });

  it("still honors a planted sink on the server, so the gate is what differs", async () => {
    vi.resetModules();
    const serverModule = await import("../pool-telemetry");
    const planted = vi.fn();
    (globalThis as Record<symbol, unknown>)[POOL_TELEMETRY_SINK_KEY] = planted;

    const pool = new mocks.MockPool();
    serverModule.instrumentPool(pool as never);
    await (pool.connect() as Promise<unknown>);

    expect(planted).toHaveBeenCalled();
  });

  it("does not write the slot from a browser runtime", async () => {
    vi.stubGlobal("window", {});
    vi.resetModules();
    const browserModule = await import("../pool-telemetry");

    browserModule.setPoolTelemetrySink(vi.fn());

    // Read back through the SERVER copy: a browser write must not become
    // visible to the server copy sharing the same realm.
    const pool = new mocks.MockPool();
    instrumentPool(pool as never);
    await (pool.connect() as Promise<unknown>);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("db_pool_telemetry.sink_missing")
    );
  });

  it("does not clear the slot from a browser runtime", async () => {
    const planted = vi.fn();
    (globalThis as Record<symbol, unknown>)[POOL_TELEMETRY_SINK_KEY] = planted;
    vi.stubGlobal("window", {});
    vi.resetModules();
    const browserModule = await import("../pool-telemetry");

    browserModule.setPoolTelemetrySink(null);

    // Read back through the SERVER copy: the planted value has to have survived
    // the browser copy's clear. A DELETE is a write too.
    const pool = new mocks.MockPool();
    instrumentPool(pool as never);
    await (pool.connect() as Promise<unknown>);

    expect(planted).toHaveBeenCalled();
  });
});

function resetDatabaseGlobals() {
  const globals = globalThis as typeof globalThis & {
    pool?: unknown;
    prisma?: unknown;
    signer?: unknown;
  };
  globals.pool = null;
  globals.prisma = null;
  globals.signer = null;
}
