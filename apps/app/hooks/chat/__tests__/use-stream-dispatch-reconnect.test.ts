import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useChatStream } from "../use-chat-stream";

/**
 * Exercises the reconnect loop in use-stream-dispatch.ts that the existing
 * use-chat-stream.test.ts never reaches: an OK initial response whose stream
 * ends WITHOUT a terminal `done`/`result` event and carries a relay command id
 * (via the `x-relay-command-id` header). That combination yields
 * `completed=false`, `terminalError=false`, and a `commandId`, which is the
 * sole trigger for the exponential-backoff reconnect loop
 * (1s, 2s, 4s, … capped at 30s; MAX_RECONNECT_ATTEMPTS = 10; a 4xx halts
 * retries while a 5xx keeps trying).
 *
 * Real timers would force these tests to wait minutes, so they pin
 * `vi.useFakeTimers()` and drive the backoff with `advanceTimersByTimeAsync`,
 * which flushes both pending timers and the microtask queue so the awaited
 * fetch/stream-read chain makes progress between ticks.
 */

const RELAY_COMMAND_ID = "cmd-relay-123";
const MAX_RECONNECT_ATTEMPTS = 10;

/** An NDJSON response that ends WITHOUT a `done`/`result` event. */
function makeIncompleteRelayResponse(lines: string[] = []): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "x-relay-command-id": RELAY_COMMAND_ID,
    },
  });
}

/** A completed NDJSON response (terminal `done`). */
function makeCompletedResponse(
  lines: string[] = ['{"type":"done"}']
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

describe("useStreamDispatch — relay reconnect loop", () => {
  const originalFetch = globalThis.fetch;
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn();
    // Keep reconnect diagnostics out of the test output.
    vi.spyOn(console, "log").mockImplementation(() => {
      /* noop */
    });
    vi.spyOn(console, "error").mockImplementation(() => {
      /* noop */
    });
    setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Backoff delays the loop schedules per attempt: 1s, 2s, 4s, … capped 30s. */
  function backoffDelaysScheduled(): number[] {
    const calls = setTimeoutSpy.mock.calls as unknown[][];
    return calls
      .map((call) => call[1])
      .filter((delay): delay is number => typeof delay === "number");
  }

  test("5xx reconnect retries with exponential backoff capped at 30s", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    // Initial: incomplete stream with a relay command id -> enters reconnect.
    fetchMock.mockResolvedValueOnce(makeIncompleteRelayResponse());
    // Six transient 5xx reconnect failures, then a successful completion. Six
    // failures push the backoff past the cap (attempt 6 -> 32s -> clamped 30s).
    for (let i = 0; i < 6; i += 1) {
      fetchMock.mockResolvedValueOnce(
        new Response("upstream down", { status: 503 })
      );
    }
    fetchMock.mockResolvedValueOnce(makeCompletedResponse());

    const { result } = renderHook(() => useChatStream());

    let sendResult: unknown;
    await act(async () => {
      const promise = result.current.sendMessage("/api/gateway/chat", {
        prompt: "hi",
      });
      // Advance well past the summed backoff (1+2+4+8+16+30+30 = 91s) so every
      // scheduled reconnect timer fires and the chain resolves.
      await vi.advanceTimersByTimeAsync(120_000);
      sendResult = await promise;
    });

    // Eventually completes once the relay reconnects.
    expect(sendResult).toEqual({ ok: true });

    const delays = backoffDelaysScheduled();
    // Exponential growth, each attempt larger or equal, never above the cap.
    expect(delays.length).toBeGreaterThanOrEqual(6);
    expect(delays.slice(0, 6)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000,
    ]);
    expect(Math.max(...delays)).toBe(30_000);
    // 1 initial fetch + 6 failed reconnects + 1 successful reconnect.
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  test("a 4xx reconnect response halts retries and surfaces stream-lost", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(makeIncompleteRelayResponse());
    // First reconnect returns a 4xx -> the loop must stop, NOT keep retrying.
    fetchMock.mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 })
    );

    const { result } = renderHook(() => useChatStream());

    let sendResult: unknown;
    await act(async () => {
      const promise = result.current.sendMessage("/api/gateway/chat", {
        prompt: "hi",
      });
      await vi.advanceTimersByTimeAsync(120_000);
      sendResult = await promise;
    });

    // Reconnect halted on the 4xx; stream never completed -> stream-read error.
    expect(sendResult).toEqual({ ok: false, reason: "stream-read" });
    // Exactly one reconnect was attempted before halting (plus initial fetch).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe(
      "Stream connection lost. Please try again."
    );
  });

  test("exhausting MAX_RECONNECT_ATTEMPTS surfaces the stream-lost error path", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(makeIncompleteRelayResponse());
    // Every reconnect attempt fails transiently (5xx) so the loop runs the
    // full MAX_RECONNECT_ATTEMPTS budget and then gives up.
    fetchMock.mockResolvedValue(new Response("upstream down", { status: 502 }));

    const { result } = renderHook(() => useChatStream());

    let sendResult: unknown;
    await act(async () => {
      const promise = result.current.sendMessage("/api/gateway/chat", {
        prompt: "hi",
      });
      // Far beyond the worst-case cumulative backoff for 10 capped attempts.
      await vi.advanceTimersByTimeAsync(600_000);
      sendResult = await promise;
    });

    expect(sendResult).toEqual({ ok: false, reason: "stream-read" });
    expect(result.current.error).toBe(
      "Stream connection lost. Please try again."
    );
    // 1 initial fetch + exactly MAX_RECONNECT_ATTEMPTS reconnect fetches.
    expect(fetchMock).toHaveBeenCalledTimes(1 + MAX_RECONNECT_ATTEMPTS);
  });

  test("abort during backoff returns {ok:true} without further reconnects", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(makeIncompleteRelayResponse());
    // If the loop wrongly continued past the abort it would consume this 5xx.
    fetchMock.mockResolvedValue(new Response("upstream down", { status: 503 }));

    const { result } = renderHook(() => useChatStream());

    let sendResult: unknown;
    await act(async () => {
      const promise = result.current.sendMessage("/api/gateway/chat", {
        prompt: "hi",
      });
      // Let the initial stream drain and the loop schedule its first backoff
      // timer (1s) without firing it yet.
      await vi.advanceTimersByTimeAsync(0);
      // Abort while parked in the backoff sleep.
      result.current.stopStreaming();
      // Fire the backoff sleep's resolve so the loop observes the abort.
      await vi.advanceTimersByTimeAsync(5000);
      sendResult = await promise;
    });

    // User-initiated abort is treated as success, not an error.
    expect(sendResult).toEqual({ ok: true });
    // No reconnect fetch was ever issued — only the initial request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
