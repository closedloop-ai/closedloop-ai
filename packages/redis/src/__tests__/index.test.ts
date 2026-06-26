import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockOn, mockPing, MockRedis } = vi.hoisted(() => {
  const mockOn = vi.fn();
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const mockPing = vi.fn();
  const MockRedis = vi.fn(function (this: Record<string, unknown>) {
    this.on = mockOn;
    this.connect = mockConnect;
    this.ping = mockPing;
  });
  return { mockOn, mockPing, MockRedis };
});

vi.mock("ioredis", () => ({
  default: MockRedis,
}));

import { checkRedisHealth, createRedisClient } from "../index.js";

describe("createRedisClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates client with lazyConnect and retry strategy", () => {
    createRedisClient({ url: "redis://localhost:6379" });

    expect(MockRedis).toHaveBeenCalledWith("redis://localhost:6379", {
      keyPrefix: undefined,
      tls: undefined,
      maxRetriesPerRequest: 3,
      retryStrategy: expect.any(Function),
      lazyConnect: true,
    });
  });

  it("enables TLS for rediss:// URLs", () => {
    createRedisClient({ url: "rediss://cache.example.com:6379" });

    expect(MockRedis).toHaveBeenCalledWith(
      "rediss://cache.example.com:6379",
      expect.objectContaining({ tls: {} })
    );
  });

  it("passes keyPrefix to ioredis", () => {
    createRedisClient({ url: "redis://localhost:6379", keyPrefix: "mcp:" });

    expect(MockRedis).toHaveBeenCalledWith(
      "redis://localhost:6379",
      expect.objectContaining({ keyPrefix: "mcp:" })
    );
  });

  it("registers error, connect, and close event handlers", () => {
    createRedisClient({ url: "redis://localhost:6379" });

    const eventNames = mockOn.mock.calls.map((call) => call[0] as string);
    expect(eventNames).toContain("error");
    expect(eventNames).toContain("connect");
    expect(eventNames).toContain("close");
  });

  it("calls custom onError handler when provided", () => {
    const onError = vi.fn();
    createRedisClient({ url: "redis://localhost:6379", onError });

    const errorHandler = mockOn.mock.calls.find(
      (call) => call[0] === "error"
    )?.[1] as (error: Error) => void;
    const testError = new Error("connection refused");
    errorHandler(testError);

    expect(onError).toHaveBeenCalledWith(testError);
  });

  it("retry strategy caps at 5000ms", () => {
    createRedisClient({ url: "redis://localhost:6379" });

    const args = MockRedis.mock.calls[0] as unknown[];
    const options = args[1] as { retryStrategy: (times: number) => number };
    expect(options.retryStrategy(1)).toBe(200);
    expect(options.retryStrategy(10)).toBe(2000);
    expect(options.retryStrategy(100)).toBe(5000);
  });

  it("routes lifecycle events through an injected logger", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    createRedisClient({
      url: "redis://localhost:6379",
      keyPrefix: "relay:",
      logger,
    });

    const handlerFor = (event: string) =>
      mockOn.mock.calls.find((call) => call[0] === event)?.[1] as (
        arg?: unknown
      ) => void;

    handlerFor("connect")();
    expect(logger.info).toHaveBeenCalledWith("[redis] connected", {
      keyPrefix: "relay:",
    });

    handlerFor("close")();
    expect(logger.info).toHaveBeenCalledWith("[redis] connection closed");
  });

  it("logs connection errors via the injected logger when no onError given", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    createRedisClient({ url: "redis://localhost:6379", logger });

    const errorHandler = mockOn.mock.calls.find(
      (call) => call[0] === "error"
    )?.[1] as (error: Error) => void;
    errorHandler(new Error("connection refused"));

    expect(logger.warn).toHaveBeenCalledWith("[redis] connection error", {
      error: "connection refused",
    });
  });

  it("prefers onError over the logger for connection errors", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const onError = vi.fn();
    createRedisClient({ url: "redis://localhost:6379", logger, onError });

    const errorHandler = mockOn.mock.calls.find(
      (call) => call[0] === "error"
    )?.[1] as (error: Error) => void;
    const testError = new Error("boom");
    errorHandler(testError);

    expect(onError).toHaveBeenCalledWith(testError);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("checkRedisHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when ping returns PONG", async () => {
    mockPing.mockResolvedValue("PONG");
    const client = createRedisClient({ url: "redis://localhost:6379" });

    const result = await checkRedisHealth(client);
    expect(result).toBe(true);
  });

  it("returns false when ping throws", async () => {
    mockPing.mockRejectedValue(new Error("connection refused"));
    const client = createRedisClient({ url: "redis://localhost:6379" });

    const result = await checkRedisHealth(client);
    expect(result).toBe(false);
  });

  it("returns false when ping returns unexpected value", async () => {
    mockPing.mockResolvedValue("ERROR");
    const client = createRedisClient({ url: "redis://localhost:6379" });

    const result = await checkRedisHealth(client);
    expect(result).toBe(false);
  });
});
