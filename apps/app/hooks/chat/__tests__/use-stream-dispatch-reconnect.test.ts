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

/**
 * An incomplete NDJSON response whose single event carries a `_seq`, so a
 * reconnect that reads it advances `lastSeq` — i.e. a *productive* reconnect
 * that delivered new events without terminating the stream.
 */
function makeProductiveRelayResponse(seq: number): Response {
  return makeIncompleteRelayResponse([
    `{"type":"text","content":"chunk ${seq}","_seq":${seq}}`,
  ]);
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

  test("a productive reconnect resets the budget so a live command survives more than MAX drops", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    // Initial: incomplete stream with a relay command id -> enters reconnect.
    fetchMock.mockResolvedValueOnce(makeIncompleteRelayResponse());
    // 15 successive drops (> MAX_RECONNECT_ATTEMPTS), but every reconnect is
    // PRODUCTIVE: it delivers a new event (advancing `_seq`) before the stream
    // ends again, proving the gateway command is still running. With a fixed
    // cumulative budget the command would be abandoned after 10 drops even
    // though it keeps making progress; resetting on progress lets it survive.
    const PRODUCTIVE_DROPS = 15;
    for (let i = 1; i <= PRODUCTIVE_DROPS; i += 1) {
      fetchMock.mockResolvedValueOnce(makeProductiveRelayResponse(i));
    }
    // Finally the command completes.
    fetchMock.mockResolvedValueOnce(
      makeCompletedResponse([`{"type":"done","_seq":${PRODUCTIVE_DROPS + 1}}`])
    );

    const { result } = renderHook(() => useChatStream());

    let sendResult: unknown;
    await act(async () => {
      const promise = result.current.sendMessage("/api/gateway/chat", {
        prompt: "hi",
      });
      // Backoff never climbs past 1s because each productive reconnect resets
      // `attempts` to 0; advance generously so every scheduled timer fires.
      await vi.advanceTimersByTimeAsync(120_000);
      sendResult = await promise;
    });

    // The command completed rather than being abandoned mid-flight.
    expect(sendResult).toEqual({ ok: true });
    expect(result.current.error).toBeNull();
    // 1 initial + 15 productive reconnects + 1 completion. This exceeds
    // 1 + MAX_RECONNECT_ATTEMPTS, which is only reachable because the budget
    // is reset on each productive reconnect.
    expect(fetchMock).toHaveBeenCalledTimes(1 + PRODUCTIVE_DROPS + 1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(
      1 + MAX_RECONNECT_ATTEMPTS
    );

    // Because the budget keeps resetting, backoff stays pinned at the 1s floor
    // instead of climbing the exponential curve.
    const delays = backoffDelaysScheduled();
    expect(delays.every((d) => d === 1000)).toBe(true);
  });

  test("mixed productive/unproductive reconnects track budget correctly", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(makeIncompleteRelayResponse());
    // 3 productive reconnects (each delivers new _seq), then 5 unproductive
    // (no new seq), then 1 productive, then 5 unproductive, then completion.
    // Budget resets on each productive, drains on unproductive.
    for (let i = 1; i <= 3; i += 1) {
      fetchMock.mockResolvedValueOnce(makeProductiveRelayResponse(i));
    }
    for (let i = 0; i < 5; i += 1) {
      fetchMock.mockResolvedValueOnce(makeIncompleteRelayResponse());
    }
    fetchMock.mockResolvedValueOnce(makeProductiveRelayResponse(4));
    for (let i = 0; i < 5; i += 1) {
      fetchMock.mockResolvedValueOnce(makeIncompleteRelayResponse());
    }
    fetchMock.mockResolvedValueOnce(
      makeCompletedResponse([`{"type":"done","_seq":5}`])
    );

    const { result } = renderHook(() => useChatStream());

    let sendResult: unknown;
    await act(async () => {
      const promise = result.current.sendMessage("/api/gateway/chat", {
        prompt: "hi",
      });
      await vi.advanceTimersByTimeAsync(600_000);
      sendResult = await promise;
    });

    expect(sendResult).toEqual({ ok: true });
    // 1 initial + 3 productive + 5 unproductive + 1 productive + 5 unproductive + 1 completion
    expect(fetchMock).toHaveBeenCalledTimes(16);

    // The backoff schedule tells the whole story. Each iteration bumps
    // `attempts`, computes `delay = min(1000 * 2 ** (attempts - 1), 30_000)`,
    // and a *productive* reconnect (one that advances `_seq`) resets
    // `attempts` back to 0 so the next delay drops to the 1s floor. Walking
    // the 15 reconnect fetches in order:
    //   #1 productive(1)  -> attempts 1 -> 1000, then reset
    //   #2 productive(2)  -> attempts 1 -> 1000, then reset
    //   #3 productive(3)  -> attempts 1 -> 1000, then reset
    //   #4 unproductive   -> attempts 1 -> 1000
    //   #5 unproductive   -> attempts 2 -> 2000
    //   #6 unproductive   -> attempts 3 -> 4000
    //   #7 unproductive   -> attempts 4 -> 8000
    //   #8 unproductive   -> attempts 5 -> 16_000   (exponential growth here)
    //   #9 productive(4)  -> attempts 6 -> 30_000 (32_000 clamped), then reset
    //   #10 unproductive  -> attempts 1 -> 1000
    //   #11 unproductive  -> attempts 2 -> 2000
    //   #12 unproductive  -> attempts 3 -> 4000
    //   #13 unproductive  -> attempts 4 -> 8000
    //   #14 unproductive  -> attempts 5 -> 16_000  (exponential growth again)
    //   #15 completion    -> attempts 6 -> 30_000 (32_000 clamped)
    const delays = backoffDelaysScheduled();
    expect(delays).toEqual([
      1000, 1000, 1000, 1000, 2000, 4000, 8000, 16_000, 30_000, 1000, 2000,
      4000, 8000, 16_000, 30_000,
    ]);

    // A productive reconnect resets the budget: every delay immediately
    // following one is pinned back to the 1s floor.
    expect(delays[0]).toBe(1000); // after initial (no prior productive), floor
    expect(delays[1]).toBe(1000); // after productive(1)
    expect(delays[2]).toBe(1000); // after productive(2)
    expect(delays[3]).toBe(1000); // after productive(3)
    expect(delays[9]).toBe(1000); // after productive(4)

    // The two consecutive unproductive runs each climb the exponential curve:
    // every successive unproductive delay in a run is exactly double the last,
    // proving real backoff (not a flat retry) once progress stalls.
    const firstUnproductiveRun = delays.slice(3, 9);
    expect(firstUnproductiveRun).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000,
    ]);
    for (let i = 1; i < firstUnproductiveRun.length - 1; i += 1) {
      // Below the 30s cap the delay strictly doubles each unproductive attempt.
      expect(firstUnproductiveRun[i]).toBe(firstUnproductiveRun[i - 1] * 2);
    }
    const secondUnproductiveRun = delays.slice(9, 15);
    expect(secondUnproductiveRun).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000,
    ]);
    for (let i = 1; i < secondUnproductiveRun.length - 1; i += 1) {
      expect(secondUnproductiveRun[i]).toBe(secondUnproductiveRun[i - 1] * 2);
    }

    // Backoff never exceeds the documented 30s cap.
    expect(Math.max(...delays)).toBe(30_000);
  });

  test("unproductive reconnects (no new events) still exhaust the budget", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(makeIncompleteRelayResponse());
    // Every reconnect connects (200) but delivers NO new events — the stream
    // opens and ends immediately without advancing `_seq`. Progress-gated
    // reset must NOT fire here, so the budget still drains and the loop gives
    // up (guards against an infinite reconnect loop). A fresh Response per call
    // is required because a body stream can only be read once.
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeIncompleteRelayResponse())
    );

    const { result } = renderHook(() => useChatStream());

    let sendResult: unknown;
    await act(async () => {
      const promise = result.current.sendMessage("/api/gateway/chat", {
        prompt: "hi",
      });
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
