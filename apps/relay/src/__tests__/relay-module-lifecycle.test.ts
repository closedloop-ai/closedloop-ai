/**
 * Tests for relay-server module lifecycle: startRelayServer/stopRelayServer
 * re-entrancy and no-op, handleShutdown keepalive-timer and redis-deregistration
 * paths, initializeTargetRegistry mode selection, module-init env guards
 * (RELAY_PORT, INTERNAL_API_SECRET, CLOSEDLOOP_API_URL), and
 * parseOptionalBoundedEnvInt bounds checking.
 *
 * No real HTTP port is bound — node:http is mocked via createMockHttpServerFactory.
 * Never call reserveTestPort here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mutable state — accessible from vi.mock factories before file body
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  // io.close call tracker (incremented by MockServer.close)
  ioCloseCallCount: 0,

  // ISS-8698: the options index.ts actually hands `new Server(...)`. Captured
  // rather than asserted inside the double so the assertion lives in a test body
  // that fails loudly, not in a mock that could stop running unnoticed.
  ioConstructorOptions: null as Record<string, unknown> | null,

  // node:http createServer call tracker — proves the re-entrancy guard skips
  // the whole bind path on a second startRelayServer(), not just the close.
  httpCreateServerCallCount: 0,

  // target-registry shared spy methods
  mockDeregisterAllByInstance: vi.fn().mockResolvedValue(0),
  mockDeregisterInstance: vi.fn().mockResolvedValue(undefined),
  mockRegisterInstance: vi.fn().mockResolvedValue(undefined),
  mockLookup: vi.fn().mockResolvedValue({ outcome: "missing" }),
  mockLookupInstance: vi.fn().mockResolvedValue({ outcome: "missing" }),

  // @repo/redis
  mockRedisConnect: vi.fn().mockResolvedValue(undefined),

  // ./instance-discovery.js
  mockResolvePrivateIp: vi.fn().mockResolvedValue("10.0.1.1"),
  mockResolveInstanceId: vi.fn().mockResolvedValue("test-instance"),

  // ./keyless-otlp-ingress.js
  mockRegisterKeylessTelemetryNamespace: vi.fn(),

  // @repo/observability/shutdown
  mockFlushLogsWithDeadline: vi.fn().mockResolvedValue(undefined),

  // @repo/observability/log — minimal stubs so module does not error
  mockLogWarn: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("socket.io", () => ({
  Server: class MockServer {
    // Engine.IO stub: index.ts attaches a `connection_error` listener to
    // `io.engine` at module load, so a Server double without one crashes on import.
    engine = { on: vi.fn() };
    constructor(_httpServer?: unknown, options?: Record<string, unknown>) {
      mocks.ioConstructorOptions = options ?? null;
    }
    of(_ns?: string) {
      return { use: vi.fn(), on: vi.fn() };
    }
    close() {
      mocks.ioCloseCallCount++;
      return Promise.resolve();
    }
  },
}));

vi.mock("node:http", async () => {
  const { createMockHttpServerFactory } = await import("./http-server-mock.js");
  const factory = createMockHttpServerFactory();
  return {
    createServer: vi.fn(() => {
      mocks.httpCreateServerCallCount++;
      return factory();
    }),
  };
});

vi.mock("../target-registry.js", () => {
  const RegistryLookupOutcome = {
    Found: "found",
    Missing: "missing",
    Unreadable: "unreadable",
    Error: "error",
  } as const;
  const TargetRegistryBackend = {
    InMemory: "in_memory",
    Redis: "redis",
  } as const;
  const ReclaimOutcome = {
    Reclaimed: "reclaimed",
    Refused: "refused",
    Error: "error",
  } as const;
  const RegistryOperation = {
    Reclaim: "reclaim",
  } as const;
  class MockRegistry {
    readonly backend = TargetRegistryBackend.Redis;

    lookup(...args: unknown[]) {
      return mocks.mockLookup(...args);
    }
    lookupInstance(...args: unknown[]) {
      return mocks.mockLookupInstance(...args);
    }
    register() {
      return Promise.resolve();
    }
    deregister() {
      return Promise.resolve(true);
    }
    refreshTtl() {
      return Promise.resolve(true);
    }
    deregisterAllByInstance(...args: unknown[]) {
      return mocks.mockDeregisterAllByInstance(...args);
    }
    deregisterInstance(...args: unknown[]) {
      return mocks.mockDeregisterInstance(...args);
    }
    registerInstance(...args: unknown[]) {
      return mocks.mockRegisterInstance(...args);
    }
  }
  return {
    InMemoryTargetRegistry: MockRegistry,
    RegistryLookupOutcome,
    RegistryOperation,
    ReclaimOutcome,
    RedisTargetRegistry: MockRegistry,
    TargetRegistryBackend,
  };
});

vi.mock("@repo/redis", () => ({
  createRedisClient: vi.fn(() => ({
    connect: (...args: unknown[]) => mocks.mockRedisConnect(...args),
    disconnect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../instance-discovery.js", () => ({
  resolvePrivateIp: () => mocks.mockResolvePrivateIp(),
  resolveInstanceId: () => mocks.mockResolveInstanceId(),
  isRoutablePrivateIpv4: vi.fn().mockReturnValue(true),
}));

vi.mock("../keyless-otlp-ingress.js", () => ({
  registerKeylessTelemetryNamespace: (...args: unknown[]) =>
    mocks.mockRegisterKeylessTelemetryNamespace(...args),
}));

vi.mock("@repo/observability/shutdown", () => ({
  flushLogsWithDeadline: (...args: unknown[]) =>
    mocks.mockFlushLogsWithDeadline(...args),
}));

vi.mock("@repo/observability/log", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/observability/log")>();
  return {
    ...actual,
    log: {
      ...(actual.log as object),
      warn: (...args: unknown[]) => mocks.mockLogWarn(...args),
      info: (...args: unknown[]) => mocks.mockLogInfo(...args),
      error: (...args: unknown[]) => mocks.mockLogError(...args),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_ENV = {
  INTERNAL_API_SECRET: "lifecycle-test-secret",
  RELAY_PORT: "20510",
  CLOSEDLOOP_API_URL: "http://127.0.0.1:19880",
  HEARTBEAT_DEGRADED_THRESHOLD_MS: "60000",
};

function applyValidEnv(): void {
  for (const [k, v] of Object.entries(VALID_ENV)) {
    process.env[k] = v;
  }
}

/** Restore exact snapshot — removes keys that were absent, restores values. */
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snap)) {
      Reflect.deleteProperty(process.env, key);
    }
  }
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) {
      Reflect.deleteProperty(process.env, k);
    } else {
      process.env[k] = v;
    }
  }
}

function resetAllMocks(): void {
  mocks.ioCloseCallCount = 0;
  mocks.httpCreateServerCallCount = 0;
  mocks.mockDeregisterAllByInstance.mockReset().mockResolvedValue(0);
  mocks.mockDeregisterInstance.mockReset().mockResolvedValue(undefined);
  mocks.mockRegisterInstance.mockReset().mockResolvedValue(undefined);
  mocks.mockLookup.mockReset().mockResolvedValue(null);
  mocks.mockLookupInstance.mockReset().mockResolvedValue(null);
  mocks.mockRedisConnect.mockReset().mockResolvedValue(undefined);
  mocks.mockResolvePrivateIp.mockReset().mockResolvedValue("10.0.1.1");
  mocks.mockResolveInstanceId.mockReset().mockResolvedValue("test-instance");
  mocks.mockRegisterKeylessTelemetryNamespace.mockReset();
  mocks.mockFlushLogsWithDeadline.mockReset().mockResolvedValue(undefined);
  mocks.mockLogWarn.mockReset();
  mocks.mockLogInfo.mockReset();
  mocks.mockLogError.mockReset();
}

// ---------------------------------------------------------------------------
// 1. startRelayServer — re-entrancy guard (L1617)
// ---------------------------------------------------------------------------

describe("startRelayServer — re-entrancy guard (L1617)", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = { ...process.env };
    resetAllMocks();
    applyValidEnv();
  });

  afterEach(() => {
    restoreEnv(envSnap);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stops the server exactly once after two startRelayServer calls (L1617 early-return arm)", async () => {
    vi.resetModules();
    const relayModule = await import("../index");

    await relayModule.startRelayServer();
    expect(mocks.httpCreateServerCallCount).toBe(1);

    // Second call: relayServerStarted=true → early return without re-binding
    await relayModule.startRelayServer();

    // The discriminating assertion: the guard skipped the bind path entirely.
    // Without it the second call would create and listen on a second server;
    // ioCloseCallCount alone cannot see that, because closing the single
    // module-level io still yields exactly one close either way.
    expect(mocks.httpCreateServerCallCount).toBe(1);
    expect(mocks.ioCloseCallCount).toBe(0);

    // stopRelayServer should close io exactly once — not twice
    await relayModule.stopRelayServer();

    expect(mocks.ioCloseCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. stopRelayServer — no-op when server not started (L1644)
// ---------------------------------------------------------------------------

describe("stopRelayServer — no-op when not started (L1644)", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = { ...process.env };
    resetAllMocks();
    applyValidEnv();
  });

  afterEach(() => {
    restoreEnv(envSnap);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves without calling io.close() when relay has never been started", async () => {
    vi.resetModules();
    const relayModule = await import("../index");

    // Do NOT call startRelayServer — relayServerStarted=false, server.listening=false
    await relayModule.stopRelayServer();

    expect(mocks.ioCloseCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. handleShutdown — timer cleared and redis deregistration (L1659/L1663)
//
// handleShutdown is triggered via SIGTERM, registered when NODE_ENV !== "test".
// process.exit is stubbed to resolve a sentinel promise so we can await shutdown
// completion from outside.
// ---------------------------------------------------------------------------

describe("handleShutdown (L1659/L1663)", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = { ...process.env };
    resetAllMocks();
  });

  afterEach(() => {
    // Remove any SIGTERM/SIGINT handlers added by the dynamically imported module
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    restoreEnv(envSnap);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("deregisters redis targets and calls process.exit(0) on SIGTERM (L1663 redis arm + L1659 timer clear)", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RELAY_RUNTIME_MODE", "redis");
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379");
    applyValidEnv();

    // Sentinel: process.exit resolves the exitPromise so we can await shutdown
    let exitResolve!: (code: number | undefined) => void;
    const exitPromise = new Promise<number | undefined>((r) => {
      exitResolve = r;
    });
    vi.spyOn(process, "exit").mockImplementation(
      (code?: number | string | null) => {
        exitResolve(typeof code === "number" ? code : undefined);
        return undefined as never;
      }
    );

    vi.resetModules();
    // Module auto-starts server and registers SIGTERM handler in non-test mode
    await import("../index");
    // Allow the automatic startRelayServer() to complete
    await vi.advanceTimersByTimeAsync(0);

    // Trigger handleShutdown
    process.emit("SIGTERM");

    const exitCode = await exitPromise;

    expect(exitCode).toBe(0);
    expect(mocks.mockDeregisterAllByInstance).toHaveBeenCalled();
    expect(mocks.mockDeregisterInstance).toHaveBeenCalled();
  });

  it("reports how many targets the shutdown sweep actually deregistered (ISS-7976)", async () => {
    // The caller used to append `.catch(() => {})` AND discard the return
    // value, so a sweep that deregistered nothing was indistinguishable from
    // one that deregistered everything — no signal at all, not even the 0.
    // Anything the sweep misses stays routable to this dead instance for the
    // full TARGET_TTL_MS, so this count is the only pre-mortem evidence.
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RELAY_RUNTIME_MODE", "redis");
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379");
    applyValidEnv();
    mocks.mockDeregisterAllByInstance.mockResolvedValue(3);

    let exitResolve!: (code: number | undefined) => void;
    const exitPromise = new Promise<number | undefined>((r) => {
      exitResolve = r;
    });
    vi.spyOn(process, "exit").mockImplementation(
      (code?: number | string | null) => {
        exitResolve(typeof code === "number" ? code : undefined);
        return undefined as never;
      }
    );

    vi.resetModules();
    await import("../index");
    await vi.advanceTimersByTimeAsync(0);

    process.emit("SIGTERM");
    await exitPromise;

    // The 3 is what makes this non-vacuous: a caller that still discarded the
    // return value could log the line but never this number.
    expect(mocks.mockLogInfo).toHaveBeenCalledWith(
      "Relay shutdown: deregistered instance targets",
      expect.objectContaining({ deregisteredTargets: 3 })
    );
  });

  it("skips redis deregistration in in-memory mode on SIGTERM (L1663 in-memory arm)", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "development");
    // Default mode: RELAY_RUNTIME_MODE not set → "inmemory"
    applyValidEnv();

    let exitResolve!: (code: number | undefined) => void;
    const exitPromise = new Promise<number | undefined>((r) => {
      exitResolve = r;
    });
    vi.spyOn(process, "exit").mockImplementation(
      (code?: number | string | null) => {
        exitResolve(typeof code === "number" ? code : undefined);
        return undefined as never;
      }
    );

    vi.resetModules();
    await import("../index");
    await vi.advanceTimersByTimeAsync(0);

    process.emit("SIGTERM");

    const exitCode = await exitPromise;

    expect(exitCode).toBe(0);
    expect(mocks.mockDeregisterAllByInstance).not.toHaveBeenCalled();
    expect(mocks.mockDeregisterInstance).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. initializeTargetRegistry — mode selection (L1692/L1703/L1747)
// ---------------------------------------------------------------------------

describe("initializeTargetRegistry", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = { ...process.env };
    resetAllMocks();
  });

  afterEach(() => {
    restoreEnv(envSnap);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("stays in-memory without contacting redis when RELAY_RUNTIME_MODE is not redis (L1692 arm-a)", async () => {
    // Default: RELAY_RUNTIME_MODE not set → "inmemory"
    applyValidEnv();
    vi.resetModules();
    const relayModule = await import("../index");

    await relayModule.startRelayServer();

    expect(mocks.mockRedisConnect).not.toHaveBeenCalled();

    await relayModule.stopRelayServer();
  });

  it("falls back to in-memory when redis mode but resolvePrivateIp returns null (L1703 arm-b)", async () => {
    mocks.mockResolvePrivateIp.mockResolvedValue(null);

    applyValidEnv();
    vi.stubEnv("RELAY_RUNTIME_MODE", "redis");
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379");

    vi.resetModules();
    const relayModule = await import("../index");
    await relayModule.startRelayServer();

    expect(mocks.mockRedisConnect).not.toHaveBeenCalled();
    expect(mocks.mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("no routable private IP")
    );

    await relayModule.stopRelayServer();
  });

  it("falls back to in-memory when redis connect throws (L1747 arm-c)", async () => {
    const connectError = new Error("ECONNREFUSED");
    mocks.mockRedisConnect.mockRejectedValue(connectError);

    applyValidEnv();
    vi.stubEnv("RELAY_RUNTIME_MODE", "redis");
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379");

    vi.resetModules();
    const relayModule = await import("../index");
    await relayModule.startRelayServer();

    expect(mocks.mockLogWarn).toHaveBeenCalledWith(
      "[relay] redis init failed, falling back to in-memory mode",
      expect.objectContaining({ error: connectError })
    );

    await relayModule.stopRelayServer();
  });
});

// ---------------------------------------------------------------------------
// 5. Module-init env guards (L59/L61, L110/L120/L125)
// ---------------------------------------------------------------------------

describe("module-init env guards", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = { ...process.env };
    resetAllMocks();
  });

  afterEach(() => {
    restoreEnv(envSnap);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls process.exit(1) for RELAY_PORT=0 (below range, L61)", async () => {
    const sentinel = new Error("exit-sentinel-port-zero");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw sentinel;
    });

    applyValidEnv();
    process.env.RELAY_PORT = "0";
    vi.resetModules();

    await expect(import("../index")).rejects.toBe(sentinel);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("calls process.exit(1) for RELAY_PORT=65536 (above range, L61)", async () => {
    const sentinel = new Error("exit-sentinel-port-overflow");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw sentinel;
    });

    applyValidEnv();
    process.env.RELAY_PORT = "65536";
    vi.resetModules();

    await expect(import("../index")).rejects.toBe(sentinel);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("calls process.exit(1) for RELAY_PORT=abc (non-numeric, L61)", async () => {
    const sentinel = new Error("exit-sentinel-port-nan");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw sentinel;
    });

    applyValidEnv();
    process.env.RELAY_PORT = "abc";
    vi.resetModules();

    await expect(import("../index")).rejects.toBe(sentinel);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("warns and defaults HEARTBEAT_DEGRADED_THRESHOLD_MS to 60000 when the value is empty", async () => {
    applyValidEnv();
    process.env.HEARTBEAT_DEGRADED_THRESHOLD_MS = "";
    vi.resetModules();

    await import("../index");

    expect(mocks.mockLogWarn).toHaveBeenCalledWith(
      "Invalid HEARTBEAT_DEGRADED_THRESHOLD_MS, defaulting to 60000",
      { value: "" }
    );
  });

  it("warns and defaults HEARTBEAT_DEGRADED_THRESHOLD_MS to 60000 when the value is non-numeric", async () => {
    applyValidEnv();
    process.env.HEARTBEAT_DEGRADED_THRESHOLD_MS = "abc";
    vi.resetModules();

    await import("../index");

    expect(mocks.mockLogWarn).toHaveBeenCalledWith(
      "Invalid HEARTBEAT_DEGRADED_THRESHOLD_MS, defaulting to 60000",
      { value: "abc" }
    );
  });

  it("accepts a valid HEARTBEAT_DEGRADED_THRESHOLD_MS without warning", async () => {
    applyValidEnv();
    process.env.HEARTBEAT_DEGRADED_THRESHOLD_MS = "45000";
    vi.resetModules();

    await import("../index");

    const warnedAboutThreshold = mocks.mockLogWarn.mock.calls.some(
      ([message]: unknown[]) =>
        typeof message === "string" &&
        message.includes("HEARTBEAT_DEGRADED_THRESHOLD_MS")
    );
    expect(warnedAboutThreshold).toBe(false);
  });

  it("calls process.exit(1) when INTERNAL_API_SECRET is missing (L120-L123)", async () => {
    const sentinel = new Error("exit-sentinel-no-secret");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw sentinel;
    });

    applyValidEnv();
    Reflect.deleteProperty(process.env, "INTERNAL_API_SECRET");
    vi.resetModules();

    await expect(import("../index")).rejects.toBe(sentinel);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("calls process.exit(1) when CLOSEDLOOP_API_URL is missing (L125-L128)", async () => {
    const sentinel = new Error("exit-sentinel-no-apiurl");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw sentinel;
    });

    applyValidEnv();
    Reflect.deleteProperty(process.env, "CLOSEDLOOP_API_URL");
    vi.resetModules();

    await expect(import("../index")).rejects.toBe(sentinel);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// 6. parseOptionalBoundedEnvInt (L751/L755) — observable via registerKeylessTelemetryNamespace args
// ---------------------------------------------------------------------------

describe("parseOptionalBoundedEnvInt (L751/L755)", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = { ...process.env };
    resetAllMocks();
  });

  afterEach(() => {
    restoreEnv(envSnap);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("passes undefined when RELAY_OTLP_MAX_INFLIGHT_EXPORTS is unset (L753 unset arm)", async () => {
    applyValidEnv();
    Reflect.deleteProperty(process.env, "RELAY_OTLP_MAX_INFLIGHT_EXPORTS");
    vi.resetModules();

    await import("../index");

    expect(mocks.mockRegisterKeylessTelemetryNamespace).toHaveBeenCalledOnce();
    const [, opts] = mocks.mockRegisterKeylessTelemetryNamespace.mock
      .calls[0] as [unknown, { maxInflightExports?: number }];
    expect(opts.maxInflightExports).toBeUndefined();
  });

  it("warns and passes undefined when RELAY_OTLP_MAX_INFLIGHT_EXPORTS is not a valid integer (L755 invalid arm)", async () => {
    applyValidEnv();
    process.env.RELAY_OTLP_MAX_INFLIGHT_EXPORTS = "three";
    vi.resetModules();

    await import("../index");

    expect(mocks.mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("Invalid RELAY_OTLP_MAX_INFLIGHT_EXPORTS"),
      expect.anything()
    );
    const [, opts] = mocks.mockRegisterKeylessTelemetryNamespace.mock
      .calls[0] as [unknown, { maxInflightExports?: number }];
    expect(opts.maxInflightExports).toBeUndefined();
  });

  it("passes the parsed integer when RELAY_OTLP_MAX_INFLIGHT_EXPORTS is a valid bounded value (L758 valid arm)", async () => {
    applyValidEnv();
    process.env.RELAY_OTLP_MAX_INFLIGHT_EXPORTS = "7";
    vi.resetModules();

    await import("../index");

    const [, opts] = mocks.mockRegisterKeylessTelemetryNamespace.mock
      .calls[0] as [unknown, { maxInflightExports?: number }];
    expect(opts.maxInflightExports).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// ISS-8698 — socket.io ping policy is explicit at the call site
// ---------------------------------------------------------------------------

describe("socket.io ping policy (ISS-8698)", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = { ...process.env };
    resetAllMocks();
    applyValidEnv();
    // applyValidEnv does not clear the override, and an inherited value would
    // satisfy the default case below without the default ever being read.
    Reflect.deleteProperty(process.env, "RELAY_PING_TIMEOUT_MS");
  });

  afterEach(() => {
    restoreEnv(envSnap);
    vi.restoreAllMocks();
  });

  it("hands the relay Server 25s/60s ping options, not socket.io's 25s/20s defaults", async () => {
    // Force a fresh evaluation: an earlier test in this file already imported
    // the module, and ESM caches it — without this the capture below would be
    // whatever that import left behind, i.e. a test-order dependency rather
    // than a measurement.
    vi.resetModules();
    mocks.ioConstructorOptions = null;
    await import("../index");

    const options = mocks.ioConstructorOptions;
    expect(options).not.toBeNull();
    // Literals, deliberately, not the module's own constants: importing those
    // back would make this assertion restate whatever the source currently
    // says, so lowering PING_TIMEOUT_MS would leave it green. These are the
    // approved values, and an edit to either has to come back through here.
    expect(options?.pingInterval).toBe(25_000);
    expect(options?.pingTimeout).toBe(60_000);
  });

  it("lets RELAY_PING_TIMEOUT_MS raise the pong deadline without a relay build", async () => {
    process.env.RELAY_PING_TIMEOUT_MS = "90000";
    vi.resetModules();

    const { PING_TIMEOUT_MS } = await import("../socket-server.js");

    expect(PING_TIMEOUT_MS).toBe(90_000);
  });

  it("raises a RELAY_PING_TIMEOUT_MS under two ping intervals to the floor, and says so", async () => {
    // The knob's failure mode: 30s is still above socket.io's 20s default and
    // still "wider than the interval", so it reads plausible — but it leaves
    // barely 5s of lateness tolerated, which is the incident condition back
    // again. The floor is what stops an env rollback from reinstating it.
    process.env.RELAY_PING_TIMEOUT_MS = "30000";
    vi.resetModules();

    const { PING_TIMEOUT_MS } = await import("../socket-server.js");

    expect(PING_TIMEOUT_MS).toBe(50_000);
    expect(mocks.mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("RELAY_PING_TIMEOUT_MS"),
      expect.objectContaining({ value: "30000" })
    );
  });
});
