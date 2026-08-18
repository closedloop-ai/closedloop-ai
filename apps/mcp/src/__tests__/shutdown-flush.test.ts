import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FEA-3661: on ECS task stop (SIGTERM) the MCP process must drain the
// observability buffer before exiting so the final Datadog log batch isn't lost.
// This guards both halves: the signal handlers are actually registered, and the
// drain is bounded (a wedged intake can't hang task stop).

const { flush, mockRedisClient, warn } = vi.hoisted(() => ({
  flush: vi.fn(),
  warn: vi.fn(),
  mockRedisClient: {
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue("OK"),
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    pexpire: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    flush,
  },
}));

vi.mock("@repo/redis", () => ({
  createRedisClient: vi.fn(() => mockRedisClient),
}));

// index.js reads required env at module load (api-client → requireEnv).
process.env.INTERNAL_API_SECRET ??= "test-internal-secret";
const ORIGINAL_ENV = { ...process.env };

async function loadTestables() {
  const mod = await import("../index.js");
  return mod.__testables;
}

describe("mcp graceful shutdown log flush", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    flush.mockReset();
    warn.mockReset();
    mockRedisClient.connect.mockReset().mockResolvedValue(undefined);
    mockRedisClient.quit.mockReset().mockResolvedValue("OK");
    process.env = {
      ...ORIGINAL_ENV,
      INTERNAL_API_SECRET: "test-internal-secret",
    };
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.env = { ...ORIGINAL_ENV };
  });

  it("registers SIGTERM and SIGINT shutdown handlers", async () => {
    // Intercept registration so the test doesn't attach real signal handlers.
    const onceSpy = vi
      .spyOn(process, "once")
      .mockReturnValue(process as unknown as NodeJS.Process);

    const { installShutdownHandlers } = await loadTestables();
    installShutdownHandlers();

    const signals = onceSpy.mock.calls.map((call) => call[0]);
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGINT");
  });

  it("flushes logs then exits 0 on shutdown", async () => {
    flush.mockResolvedValue(undefined);

    const { shutdownAndExit } = await loadTestables();
    await shutdownAndExit();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("flushes logs then exits with the given code (fatal startup error path)", async () => {
    flush.mockResolvedValue(undefined);

    const { shutdownAndExit } = await loadTestables();
    await shutdownAndExit({ exitCode: 1 });

    expect(flush).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("still exits when flush never resolves (deadline reached)", async () => {
    vi.useFakeTimers();
    // A flush that never settles — only the wall-clock deadline can unblock exit.
    flush.mockReturnValue(new Promise<void>(() => undefined));

    const { shutdownAndExit } = await loadTestables();
    const pending = shutdownAndExit();

    await vi.advanceTimersByTimeAsync(5000);
    await pending;

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("closes the listener and Redis auth cache before the final flush", async () => {
    const calls: string[] = [];
    process.env.MCP_SESSION_STORE = "redis";
    process.env.REDIS_URL = "redis://localhost:6379";
    mockRedisClient.quit.mockImplementation(() => {
      calls.push("redis");
      return Promise.resolve("OK");
    });
    flush.mockImplementation(() => {
      calls.push("flush");
      return Promise.resolve();
    });
    const httpServer = {
      close: vi.fn((callback: () => void) => {
        calls.push("server");
        callback();
        return httpServer;
      }),
    };

    const { shutdownAndExit } = await loadTestables();
    await shutdownAndExit({ httpServer: httpServer as never });

    expect(httpServer.close).toHaveBeenCalledTimes(1);
    expect(mockRedisClient.quit).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["server", "redis", "flush"]);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("logs sanitized Redis close failures then flushes and exits", async () => {
    process.env.MCP_SESSION_STORE = "redis";
    process.env.REDIS_URL = "redis://:secret-token@cache.example:6379/0";
    mockRedisClient.quit.mockRejectedValueOnce(
      new Error(
        "redis://:secret-token@cache.example:6379/0 sk_test_secret auth:session-123"
      )
    );
    flush.mockResolvedValue(undefined);

    const { shutdownAndExit } = await loadTestables();
    await shutdownAndExit();

    expect(mockRedisClient.quit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("MCP auth cache close failed", {
      errorType: "Error",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-token");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sk_test_secret");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("auth:session-123");
    expect(flush).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("logs sanitized HTTP close failures then flushes and exits", async () => {
    flush.mockResolvedValue(undefined);
    const httpServer = {
      close: vi.fn((callback: (error: Error) => void) => {
        callback(new Error("redis://:secret-token@cache.example:6379/0"));
        return httpServer;
      }),
    };

    const { shutdownAndExit } = await loadTestables();
    await shutdownAndExit({ httpServer: httpServer as never });

    expect(httpServer.close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("MCP HTTP server close failed", {
      errorType: "Error",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-token");
    expect(flush).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("continues shutdown when Redis close reaches the deadline", async () => {
    vi.useFakeTimers();
    process.env.MCP_SESSION_STORE = "redis";
    process.env.REDIS_URL = "redis://localhost:6379";
    mockRedisClient.quit.mockReturnValueOnce(
      new Promise<string>(() => undefined)
    );
    flush.mockResolvedValue(undefined);

    const { shutdownAndExit } = await loadTestables();
    const pending = shutdownAndExit();

    await vi.advanceTimersByTimeAsync(5000);
    await pending;

    expect(mockRedisClient.quit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("MCP auth cache close failed", {
      errorType: "Timeout",
    });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("continues shutdown when listener drain reaches the deadline", async () => {
    vi.useFakeTimers();
    flush.mockResolvedValue(undefined);
    const httpServer = {
      close: vi.fn(() => httpServer),
    };

    const { shutdownAndExit } = await loadTestables();
    const pending = shutdownAndExit({ httpServer: httpServer as never });

    await vi.advanceTimersByTimeAsync(4000);
    await pending;

    expect(httpServer.close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("reserves final log flush time when listener drain hangs", async () => {
    vi.useFakeTimers();
    flush.mockReturnValue(new Promise<void>(() => undefined));
    const httpServer = {
      close: vi.fn(() => httpServer),
    };

    const { shutdownAndExit } = await loadTestables();
    const pending = shutdownAndExit({ httpServer: httpServer as never });

    await vi.advanceTimersByTimeAsync(4000);

    expect(httpServer.close).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(exitSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("does not duplicate cleanup or exit during repeated shutdown entry", async () => {
    vi.useFakeTimers();
    flush.mockResolvedValue(undefined);
    const httpServer = {
      close: vi.fn(() => httpServer),
    };

    const { shutdownAndExit } = await loadTestables();
    const firstShutdown = shutdownAndExit({ httpServer: httpServer as never });
    const secondShutdown = shutdownAndExit({ httpServer: httpServer as never });

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([firstShutdown, secondShutdown]);

    expect(httpServer.close).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
