/**
 * Unit tests for createSseStream / encodeSseData — the shared SSE primitive
 * behind every streaming API route (compute-target status, loop streams,
 * operation streams, command events).
 *
 * Drives createSseStream with a real ReadableStream reader plus fake timers to
 * assert: data-frame send, keepalive frames, max-duration close, idempotent
 * double-close, sync vs async onStart result handling, null-unsub immediate
 * close, onStart rejection cleanup, cancel cleanup, and the post-cleanup send
 * guard. encodeSseData framing is asserted directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logError, logInfo } = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: logError,
    info: logInfo,
  },
}));

import {
  createSseResponse,
  createSseStream,
  encodeSseData,
} from "../sse-stream";

const decoder = new TextDecoder();

function decode(value: Uint8Array | undefined): string {
  return value ? decoder.decode(value) : "";
}

describe("encodeSseData", () => {
  it("frames a JSON payload as an SSE data event", () => {
    expect(decode(encodeSseData({ a: 1, b: "two" }))).toBe(
      'data: {"a":1,"b":"two"}\n\n'
    );
  });
});

describe("createSseResponse", () => {
  it("sets event-stream headers", () => {
    const response = createSseResponse(new ReadableStream());
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe(
      "no-cache, no-transform"
    );
    expect(response.headers.get("Connection")).toBe("keep-alive");
  });
});

describe("createSseStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logError.mockClear();
    logInfo.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const longTimers = {
    keepaliveIntervalMs: 1_000_000,
    maxDurationMs: 1_000_000,
  };

  it("delivers a data frame sent during a synchronous onStart", async () => {
    const stream = createSseStream(({ send }) => {
      send(encodeSseData({ hello: "world" }));
      return () => {};
    }, longTimers);

    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(decode(value)).toBe('data: {"hello":"world"}\n\n');
  });

  it("emits a keepalive frame after the keepalive interval", async () => {
    const stream = createSseStream(() => () => {}, {
      keepaliveIntervalMs: 1000,
      maxDurationMs: 1_000_000,
    });

    const reader = stream.getReader();
    await vi.advanceTimersByTimeAsync(1000);
    const { value } = await reader.read();
    expect(decode(value)).toBe(": keepalive\n\n");
    expect(logError).not.toHaveBeenCalled();
  });

  it("closes the stream and cleans up when max duration is reached", async () => {
    const onCleanup = vi.fn();
    const stream = createSseStream(() => () => {}, {
      keepaliveIntervalMs: 1_000_000,
      maxDurationMs: 5000,
      logContext: { route: "test" },
      onCleanup,
    });

    const reader = stream.getReader();
    await vi.advanceTimersByTimeAsync(5000);
    const { done } = await reader.read();

    expect(done).toBe(true);
    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith("SSE max duration reached", {
      route: "test",
    });
  });

  it("unsubscribes and cleans up exactly once across a double close", () => {
    const unsubscribe = vi.fn();
    const onCleanup = vi.fn();
    let close = () => {};

    createSseStream(
      (controls) => {
        close = controls.close;
        return unsubscribe;
      },
      { ...longTimers, onCleanup }
    );

    close();
    close();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(onCleanup).toHaveBeenCalledTimes(1);
  });

  it("arms timers from an async onStart that resolves to an unsubscribe", async () => {
    const stream = createSseStream(() => Promise.resolve(() => {}), {
      keepaliveIntervalMs: 1000,
      maxDurationMs: 1_000_000,
    });

    const reader = stream.getReader();
    // Flush the onStart promise, then trip the keepalive timer.
    await vi.advanceTimersByTimeAsync(1000);
    const { value } = await reader.read();
    expect(decode(value)).toBe(": keepalive\n\n");
  });

  it("closes immediately when an async onStart resolves to null", async () => {
    const onCleanup = vi.fn();
    const stream = createSseStream(() => Promise.resolve(null), { onCleanup });

    const reader = stream.getReader();
    await vi.advanceTimersByTimeAsync(0);
    const { done } = await reader.read();

    expect(done).toBe(true);
    expect(onCleanup).toHaveBeenCalledTimes(1);
  });

  it("logs and cleans up when the async onStart rejects", async () => {
    const onCleanup = vi.fn();
    const stream = createSseStream(() => Promise.reject(new Error("boom")), {
      logContext: { route: "test" },
      onCleanup,
    });

    const reader = stream.getReader();
    await vi.advanceTimersByTimeAsync(0);
    const { done } = await reader.read();

    expect(done).toBe(true);
    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      "SSE stream setup failed",
      expect.objectContaining({ route: "test" })
    );
  });

  it("cleans up and unsubscribes when the consumer cancels", async () => {
    const unsubscribe = vi.fn();
    const onCleanup = vi.fn();
    const stream = createSseStream(() => unsubscribe, {
      ...longTimers,
      onCleanup,
    });

    const reader = stream.getReader();
    await reader.cancel();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it("ignores sends after the stream has been closed", async () => {
    let controls!: { send: (data: Uint8Array) => void; close: () => void };
    const stream = createSseStream((c) => {
      controls = c;
      return () => {};
    }, longTimers);

    const reader = stream.getReader();
    controls.close();
    controls.send(encodeSseData({ ignored: true }));

    const { done } = await reader.read();
    expect(done).toBe(true);
    expect(logError).not.toHaveBeenCalled();
  });
});
