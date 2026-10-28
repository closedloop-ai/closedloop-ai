import { EventEmitter } from "node:events";
import {
  __resetPoolTelemetryForTests,
  type instrumentPool,
} from "@repo/database/pool-telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ISS-5853 — a pool acquire timeout in apps/mcp must reach Datadog. The
// warning's default is stderr, which on ECS lands in CloudWatch only, so the
// `cl-api / cl-mcp — pg pool-acquire timeouts` monitor never saw an mcp
// timeout. These cases import the real entry module (whose import installs the
// routing) and assert on the agentless intake payload the logger ships.

// pg-pool's own text, and the literal the monitor matches, so it is written out
// rather than taken from this repo's constant.
const MONITORED_PHRASE = "timeout exceeded when trying to connect";

// The entry imports `withDb` from the package root; mocking it keeps Prisma out
// of the suite. The pool-telemetry subpath under test stays real.
vi.mock("@repo/database", () => ({ withDb: vi.fn() }));

type IntakeEntry = Record<string, unknown> & { message: string };
type InstrumentablePool = Parameters<typeof instrumentPool>[0];

/** A saturated pool whose every acquisition fails the way pg-pool's does. */
class TimingOutPool extends EventEmitter {
  options = { max: 10 };

  totalCount = 10;

  idleCount = 0;

  waitingCount = 3;

  connect(): Promise<never> {
    return Promise.reject(new Error(MONITORED_PHRASE));
  }
}

let fetchMock: ReturnType<typeof vi.fn>;
let logsDisabled: string | undefined;

beforeEach(() => {
  vi.resetModules();
  // CI sets this on instrumented lanes to close the intake; this case asserts
  // on the intake, so open it and put the exact previous state back after.
  logsDisabled = process.env.DD_LOGS_DISABLED;
  Reflect.deleteProperty(process.env, "DD_LOGS_DISABLED");
  vi.stubEnv("DD_API_KEY", "test-key");
  vi.stubEnv("DD_SITE", "datadoghq.com");
  vi.stubEnv("DD_SERVICE", "cl-mcp");
  vi.stubEnv("DD_ENV", "test");
  vi.stubEnv("RELEASE_VERSION", "1.0.0");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
  vi.stubEnv("INTERNAL_API_SECRET", "test-internal-secret");
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  // The writer sits in a process-wide slot; clear it so no later file inherits it.
  __resetPoolTelemetryForTests();
  if (logsDisabled === undefined) {
    Reflect.deleteProperty(process.env, "DD_LOGS_DISABLED");
  } else {
    process.env.DD_LOGS_DISABLED = logsDisabled;
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mcp pool warnings reach the Datadog intake (ISS-5853)", () => {
  it("ships an acquire timeout with the monitored phrase, the pool counters and status", async () => {
    await import("../index.js");
    const { instrumentPool } = await import("@repo/database/pool-telemetry");
    const { log } = await import("@repo/observability/log");

    const pool = instrumentPool(
      new TimingOutPool() as unknown as InstrumentablePool
    );
    await expect(pool.connect()).rejects.toThrow(MONITORED_PHRASE);
    await log.flush();

    const shipped = intakeEntries();
    const timeout = shipped.find(
      (entry) => entry.event === "db_pool.acquire_timeout"
    );
    expect(timeout).toMatchObject({
      service: "cl-mcp",
      ddsource: "nodejs",
      status: "warn",
      level: "warn",
      poolMax: 10,
      waitingCount: 3,
      inUse: 10,
      idle: 0,
      total: 10,
      saturated: true,
      suppressedSinceLastReport: 0,
    });
    expect(timeout?.message).toContain(MONITORED_PHRASE);
    expect(typeof timeout?.waitedMs).toBe("number");
    // The logger stamps severity itself; a forwarded `status` would be moved
    // aside to `callerStatus` on every record.
    expect(timeout).not.toHaveProperty("callerStatus");
  });

  it("ships the sink-missing warning on the same path, since mcp registers no telemetry sink", async () => {
    await import("../index.js");
    const { instrumentPool } = await import("@repo/database/pool-telemetry");
    const { log } = await import("@repo/observability/log");

    const pool = instrumentPool(
      new TimingOutPool() as unknown as InstrumentablePool
    );
    await expect(pool.connect()).rejects.toThrow(MONITORED_PHRASE);
    await log.flush();

    expect(
      intakeEntries().find(
        (entry) => entry.event === "db_pool_telemetry.sink_missing"
      )
    ).toMatchObject({ service: "cl-mcp", status: "warn" });
  });
});

/** Every entry the logger POSTed to the agentless intake, across all flushes. */
function intakeEntries(): IntakeEntry[] {
  return fetchMock.mock.calls.flatMap(
    ([, init]) => JSON.parse((init as { body: string }).body) as IntakeEntry[]
  );
}
