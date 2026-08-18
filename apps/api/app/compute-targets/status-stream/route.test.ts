/**
 * Drives the real `GET` handler (real `createSseStream`, mocked auth + service)
 * under fake timers to pin the adaptive poll cadence introduced by FEA-3302.
 *
 * The assertions are call *counts* at exact ticks rather than shapes, because
 * the whole change is "how many times does this hit the database" — a test that
 * only proved the stream still emits would pass against the old fixed 5s
 * interval too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAnyAuthContext: vi.fn(),
  getStatusSnapshot: vi.fn(),
  createSseStream: vi.fn(),
}));

// Spied, not replaced: every other test drives the real stream, and this one
// only needs to read the budget the route computed for it.
vi.mock("@/lib/sse-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sse-stream")>();
  mocks.createSseStream.mockImplementation(actual.createSseStream);
  return { ...actual, createSseStream: mocks.createSseStream };
});

vi.mock("@/lib/auth/resolve-any-auth-context", () => ({
  resolveAnyAuthContext: mocks.resolveAnyAuthContext,
}));

vi.mock("@/lib/auth/auth-context-failure", () => ({
  authContextFailureResponse: () =>
    new Response("unauthorized", {
      status: 401,
    }),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("../service", () => ({
  computeTargetsService: {
    getStatusSnapshot: mocks.getStatusSnapshot,
  },
}));

import {
  IDLE_BACKOFF_AFTER_MS,
  IDLE_POLL_INTERVAL_MS,
  MAX_STREAM_DURATION_MS,
  MIN_STREAM_DURATION_MS,
  POLL_INTERVAL_MS,
} from "./poll-helpers";
import { GET, maxDuration } from "./route";

const ORGANIZATION_ID = "org-1";
const START_TIME = new Date("2026-08-10T00:00:00.000Z");
const decoder = new TextDecoder();

function snapshot(entries: [string, boolean][]): Map<string, boolean> {
  return new Map(entries);
}

/**
 * Open the stream and drain it in the background, so reads never block the test
 * body and every frame the route enqueues lands in the returned array.
 */
async function openStream(): Promise<{ frames: string[]; cancel: () => void }> {
  const response = await GET(new Request("https://api.test/status-stream"));
  const body = response.body;
  if (!body) {
    throw new Error("expected an SSE body");
  }
  const reader = body.getReader();
  const frames: string[] = [];

  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      frames.push(decoder.decode(value));
    }
  })().catch(() => {
    // Stream cancelled by the test.
  });

  return {
    frames,
    cancel: () => {
      reader.cancel().catch(() => {
        // Already closed.
      });
    },
  };
}

function dataFrames(frames: string[]): string[] {
  return frames.filter((frame) => frame.startsWith("data:"));
}

/** Polls after the initial snapshot taken during `GET`. */
function pollCount(): number {
  return mocks.getStatusSnapshot.mock.calls.length - 1;
}

/** The lifetime budget the route handed the stream it just constructed. */
function streamBudgetMs(): number | undefined {
  const [, options] = mocks.createSseStream.mock.calls.at(-1) ?? [];
  return options?.maxDurationMs;
}

/**
 * Make auth block for `delayMs` before succeeding, so the test can spend the
 * request's deadline on a slow-but-successful setup rather than on a failure.
 */
function delayAuthBy(delayMs: number): void {
  mocks.resolveAnyAuthContext.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({ ok: true, context: { organizationId: ORGANIZATION_ID } }),
          delayMs
        );
      })
  );
}

/** Drive `GET` to completion across a setup that blocks on fake timers. */
async function openStreamAfterSlowSetup(delayMs: number): Promise<void> {
  const responsePromise = GET(new Request("https://api.test/status-stream"));
  await vi.advanceTimersByTimeAsync(delayMs);
  await responsePromise;
}

describe("compute-target status-stream poll cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME);
    mocks.resolveAnyAuthContext.mockReset();
    mocks.getStatusSnapshot.mockReset();
    // Cleared, never reset: resetting would strip the delegate to the real
    // `createSseStream` that the factory installed.
    mocks.createSseStream.mockClear();
    mocks.resolveAnyAuthContext.mockResolvedValue({
      ok: true,
      context: { organizationId: ORGANIZATION_ID },
    });
    mocks.getStatusSnapshot.mockResolvedValue(snapshot([["target-1", true]]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the base cadence until the idle threshold, then widens", async () => {
    const { cancel } = await openStream();

    await vi.advanceTimersByTimeAsync(IDLE_BACKOFF_AFTER_MS);

    // One poll per base interval, right up to and including the crossover tick.
    expect(pollCount()).toBe(IDLE_BACKOFF_AFTER_MS / POLL_INTERVAL_MS);

    // The base interval must stop firing entirely: nothing lands in the gap
    // between the crossover and the first widened tick. This is the assertion
    // the old fixed-interval implementation fails.
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS - 1);
    expect(pollCount()).toBe(IDLE_BACKOFF_AFTER_MS / POLL_INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(1);
    expect(pollCount()).toBe(IDLE_BACKOFF_AFTER_MS / POLL_INTERVAL_MS + 1);

    cancel();
  });

  it("re-aims a backed-off stream to the base cadence on an observed change", async () => {
    const { frames, cancel } = await openStream();

    await vi.advanceTimersByTimeAsync(
      IDLE_BACKOFF_AFTER_MS + IDLE_POLL_INTERVAL_MS
    );
    const backedOffPolls = pollCount();
    expect(dataFrames(frames)).toHaveLength(0);

    // A target drops offline; the next widened poll observes it.
    mocks.getStatusSnapshot.mockResolvedValue(snapshot([["target-1", false]]));
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS);
    expect(pollCount()).toBe(backedOffPolls + 1);
    expect(dataFrames(frames)).toHaveLength(1);
    expect(dataFrames(frames)[0]).toContain('"isOnline":false');

    // Having seen a change, the stream is back on the base cadence rather than
    // waiting out another ceiling.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(pollCount()).toBe(backedOffPolls + 2);

    cancel();
  });

  it("does not treat a failing read as a quiet stream", async () => {
    const { cancel } = await openStream();
    mocks.getStatusSnapshot.mockRejectedValue(new Error("pool timeout"));

    const elapsed = IDLE_BACKOFF_AFTER_MS + 4 * IDLE_POLL_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(elapsed);

    // Folding failures into the idle signature would march a broken lane to the
    // ceiling precisely because it is broken. Base cadence throughout instead.
    expect(pollCount()).toBe(elapsed / POLL_INTERVAL_MS);

    cancel();
  });

  it("closes itself before the platform ceiling instead of being killed", async () => {
    expect(MAX_STREAM_DURATION_MS).toBeLessThan(maxDuration * 1000);

    const { cancel } = await openStream();
    await vi.advanceTimersByTimeAsync(MAX_STREAM_DURATION_MS - 1);
    const pollsBeforeClose = pollCount();

    await vi.advanceTimersByTimeAsync(1);
    // The stream tore itself down, so no further database work is scheduled.
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS * 4);
    expect(pollCount()).toBe(pollsBeforeClose);

    cancel();
  });

  it("stops polling when the client disconnects", async () => {
    const { cancel } = await openStream();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    const pollsBeforeCancel = pollCount();
    expect(pollsBeforeCancel).toBeGreaterThan(0);

    cancel();
    await vi.advanceTimersByTimeAsync(IDLE_BACKOFF_AFTER_MS * 2);

    expect(pollCount()).toBe(pollsBeforeCancel);
  });

  it("charges a slow setup against the stream budget", async () => {
    // Comfortably inside a successful setup: auth does several database reads
    // and the pool allows a 30s connection wait.
    const setupMs = 45_000;
    delayAuthBy(setupMs);

    await openStreamAfterSlowSetup(setupMs);

    // Budgeting from stream construction instead of request entry would hand
    // over the full ceiling here, making the real lifetime `setup + 280s` and
    // putting the close past the platform's 300s clock.
    expect(streamBudgetMs()).toBe(MAX_STREAM_DURATION_MS - setupMs);
    expect(streamBudgetMs()).toBeLessThan(MAX_STREAM_DURATION_MS);
  });

  it("floors the budget when setup consumed the whole deadline", async () => {
    delayAuthBy(MAX_STREAM_DURATION_MS + POLL_INTERVAL_MS);

    await openStreamAfterSlowSetup(MAX_STREAM_DURATION_MS + POLL_INTERVAL_MS);

    // A short stream the client reconnects from, never a zero or negative
    // timer that would fire before the first frame.
    expect(streamBudgetMs()).toBe(MIN_STREAM_DURATION_MS);
  });
});
