/**
 * Reconnect/backoff contract for the compute-targets status stream (FEA-3940).
 * A 401/403 from the SSE endpoint must stop the reconnect loop entirely — one
 * fetch, no reschedule — instead of running out the reconnect budget hammering
 * the API. A non-auth transport failure still reconnects (bounded).
 */

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComputeTargetStatusStream } from "../use-compute-target-status-stream";

const mockFetch = vi.fn();
const mockInvalidateQueries = vi.fn();
// Mutable token supplier so a test can simulate a transient token-acquisition
// gap (Clerk loaded but `getToken()` briefly returns `null`) and then recovery.
const mockGetToken = vi.fn<() => Promise<string | null>>(() =>
  Promise.resolve("token")
);

vi.mock("@repo/app/shared/auth/use-wait-for-auth-loaded", () => ({
  useWaitForAuthLoaded: () => () => Promise.resolve(),
}));

vi.mock("@repo/auth/client", () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

vi.mock("@/hooks/use-api-client", () => ({
  resolveApiUrl: () => "https://api.example.test",
}));

/**
 * Flush the microtask queue so awaited fetch/token promises settle. Reading a
 * (possibly multi-chunk) SSE ReadableStream body takes several await turns
 * per frame, so this drains more rounds than a single fetch+token chain needs.
 */
async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const textEncoder = new TextEncoder();

/** Builds an SSE response body that emits each chunk as its own stream read. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(textEncoder.encode(chunk));
      }
      controller.close();
    },
  });
}

// Mirrors the un-exported MAX_RECONNECT_ATTEMPTS in the production module.
const MAX_RECONNECT_ATTEMPTS = 10;

describe("useComputeTargetStatusStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks wipes implementations too, so restore the default token.
    mockGetToken.mockResolvedValue("token");
    vi.useFakeTimers();
    // Stub via vi.stubGlobal so vi.unstubAllGlobals() restores the original
    // fetch descriptor in teardown — a bare assignment would leak the mock
    // into later tests sharing this environment.
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stops reconnecting after a 401 (no reschedule)", async () => {
    mockFetch.mockResolvedValue(
      new Response(null, { status: 401, statusText: "Unauthorized" })
    );

    renderHook(() => useComputeTargetStatusStream(true));
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance well past any backoff window; a stopped loop must not fetch again.
    await vi.advanceTimersByTimeAsync(120_000);
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("stops reconnecting after a 403 (no reschedule)", async () => {
    mockFetch.mockResolvedValue(
      new Response(null, { status: 403, statusText: "Forbidden" })
    );

    renderHook(() => useComputeTargetStatusStream(true));
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000);
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("treats a 401 with no token as a transient gap and reconnects", async () => {
    // Transient token-acquisition gap: getToken briefly returns null, so the
    // first request carries no Authorization header and the API answers 401.
    // That must NOT latch as terminal — a bounded reconnect retries once the
    // token is available, instead of freezing the online indicator forever.
    mockGetToken.mockResolvedValueOnce(null);
    mockFetch.mockResolvedValue(
      new Response(null, { status: 401, statusText: "Unauthorized" })
    );

    renderHook(() => useComputeTargetStatusStream(true));
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // First (null-token) request went out with no Authorization header.
    const firstInit = mockFetch.mock.calls[0]?.[1] as RequestInit;
    const firstHeaders = firstInit.headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBeUndefined();

    // A reconnect fires after the first backoff window — not stopped.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it("reconnects on a non-auth transport failure (bounded)", async () => {
    mockFetch.mockResolvedValue(
      new Response(null, { status: 503, statusText: "Service Unavailable" })
    );

    renderHook(() => useComputeTargetStatusStream(true));
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // First backoff window elapses -> a reconnect attempt fires.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not open a stream when disabled", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 401 }));
    renderHook(() => useComputeTargetStatusStream(false));
    await flushMicrotasks();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("invalidates the compute-targets query once per SSE data frame and skips non-data frames", async () => {
    // Each array entry becomes its own stream chunk/read, matching how SSE
    // frames actually arrive one read at a time over the wire.
    mockFetch.mockResolvedValueOnce(
      new Response(
        sseStream(["data: online\n\n", ": heartbeat\n\n", "data: offline\n\n"]),
        {
          status: 200,
        }
      )
    );
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));

    renderHook(() => useComputeTargetStatusStream(true));
    await flushMicrotasks();

    // Two "data:" frames across the three reads -> two invalidations; the
    // ": heartbeat" comment frame must not trigger a third.
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("resets the reconnect backoff once a connection successfully opens", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(sseStream([]), { status: 200 }))
      .mockResolvedValue(new Response(null, { status: 503 }));

    renderHook(() => useComputeTargetStatusStream(true));
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // First backoff window (base delay, 2s) after the initial 503.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // That second attempt opens successfully against an empty stream that
    // closes immediately, which resets the reconnect budget via onOpen().
    // If the budget had NOT reset, the third attempt would need the doubled
    // 4s backoff — advancing only the base 2s again must still be enough.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("treats an ok response with no body as disconnected and reconnects", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));

    renderHook(() => useComputeTargetStatusStream(true));
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it("reconnects after a fetch rejection that is not an AbortError", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));

    renderHook(() => useComputeTargetStatusStream(true));
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it("silently ignores an AbortError from an aborted in-flight fetch instead of reconnecting", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    const { unmount } = renderHook(() => useComputeTargetStatusStream(true));
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    unmount();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(120_000);
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts the in-flight fetch and stops reconnecting on unmount", async () => {
    let capturedSignal: AbortSignal | null | undefined;
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Promise(() => {
        // Never resolves — simulates a stream that stays open.
      });
    });

    const { unmount } = renderHook(() => useComputeTargetStatusStream(true));
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);

    unmount();

    expect(capturedSignal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(120_000);
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("clears a pending reconnect timer on unmount so a scheduled reconnect never fires", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));

    const { unmount } = renderHook(() => useComputeTargetStatusStream(true));
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // A reconnect is now scheduled off the 503 — unmount before it can fire.
    unmount();

    await vi.advanceTimersByTimeAsync(120_000);
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not open a stream if the hook unmounts while waiting for the auth token", async () => {
    let resolveToken: (token: string | null) => void = () => {
      // overwritten below
    };
    mockGetToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        })
    );

    const { unmount } = renderHook(() => useComputeTargetStatusStream(true));
    unmount();

    resolveToken("token");
    await flushMicrotasks();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("stops reconnecting once the max reconnect attempt budget is exhausted", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));

    renderHook(() => useComputeTargetStatusStream(true));
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Drain every reconnect attempt. 30s comfortably exceeds the capped
    // backoff (max 30s) at every step, so each iteration fires exactly one
    // reconnect regardless of the current doubling.
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushMicrotasks();
    }
    const callsAfterBudget = mockFetch.mock.calls.length;
    expect(callsAfterBudget).toBe(MAX_RECONNECT_ATTEMPTS + 1);

    // Budget exhausted — further time must not produce any more fetches.
    await vi.advanceTimersByTimeAsync(120_000);
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(callsAfterBudget);
  });
});
