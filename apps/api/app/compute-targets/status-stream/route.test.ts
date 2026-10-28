/**
 * Drives the real `GET` handler (real `createSseStream`, mocked auth + service)
 * under fake timers to pin the adaptive poll cadence introduced by FEA-3302 and
 * the failed-read reporting added by FEA-3301.
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
  scheduleLogFlush: vi.fn(),
  logError: vi.fn<(event: string, payload: Record<string, unknown>) => void>(),
  logWarn: vi.fn<(event: string, payload: Record<string, unknown>) => void>(),
}));

// Spied, not replaced: every other test drives the real stream, and this one
// only needs to read the budget the route computed for it.
vi.mock("@/lib/sse-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sse-stream")>();
  mocks.createSseStream = vi.fn(actual.createSseStream);
  return { ...actual, createSseStream: mocks.createSseStream };
});

vi.mock("@/lib/auth/resolve-any-auth-context", () => ({
  resolveAnyAuthContext: mocks.resolveAnyAuthContext,
}));

vi.mock("@/lib/route-utils", () => ({
  logRequestCompleted: vi.fn(),
  scheduleLogFlush: mocks.scheduleLogFlush,
}));

vi.mock("@/lib/auth/auth-context-failure", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/auth/auth-context-failure")>();
  return {
    ...actual,
    authContextFailureResponse: () =>
      new Response("unauthorized", { status: 401 }),
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, warn: mocks.logWarn, info: vi.fn() },
}));

vi.mock("../service", () => ({
  computeTargetsService: {
    getStatusSnapshot: mocks.getStatusSnapshot,
  },
}));

import { AuthContextFailure } from "@/lib/auth/auth-context-failure";
import { EmissionRollupCause } from "@/lib/observability/fixed-window-emission-throttle";
import {
  IDLE_BACKOFF_AFTER_MS,
  IDLE_POLL_INTERVAL_MS,
  MAX_STREAM_DURATION_MS,
  MIN_STREAM_DURATION_MS,
  POLL_FAILURE_LOG_INTERVAL_MS,
  POLL_INTERVAL_MS,
  pollFailureThrottle,
  SNAPSHOT_FAILURE_LOG_INTERVAL_MS,
  STATUS_POLL_FAILED_EVENT,
  snapshotFailureThrottle,
} from "./poll-helpers";
import { GET, maxDuration } from "./route";

const ORGANIZATION_ID = "org-1";
const OTHER_ORGANIZATION_ID = "org-2";
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

/** SSE comment frames — the keepalive the connection is held open by. */
function keepaliveFrames(frames: string[]): string[] {
  return frames.filter((frame) => frame.startsWith(":"));
}

/**
 * Payloads of the monitored failed-read event only. Filtered by name so an
 * unrelated `log.error` from the stream plumbing cannot satisfy these counts.
 */
function pollFailureLogs(): Record<string, unknown>[] {
  return mocks.logError.mock.calls
    .filter(([event]) => event === STATUS_POLL_FAILED_EVENT)
    .map(([, payload]) => payload);
}

function snapshotFailureLogs(): Record<string, unknown>[] {
  return mocks.logError.mock.calls
    .filter(([event]) => event === "compute_target_status_snapshot_failed")
    .map(([, payload]) => payload);
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

describe("compute-target status-stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME);
    mocks.resolveAnyAuthContext.mockReset();
    mocks.getStatusSnapshot.mockReset();
    mocks.scheduleLogFlush.mockReset();
    // Its constructor implementation delegates to the real stream builder, so
    // the config-level reset clears overrides while restoring that baseline.
    mocks.createSseStream.mockClear();
    mocks.logError.mockReset();
    mocks.logWarn.mockReset();
    // The emission bound is a module-level singleton keyed on the org, so it
    // outlives a case. Without this, one case's spent window silences the next.
    pollFailureThrottle.clear();
    snapshotFailureThrottle.clear();
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

  it("reports an org-attributed initial snapshot outage and returns its coded 500", async () => {
    mocks.getStatusSnapshot.mockRejectedValue(
      new Error("database unavailable")
    );

    const response = await GET(new Request("https://api.test/status-stream"));

    expect(snapshotFailureLogs()).toEqual([
      {
        organizationId: ORGANIZATION_ID,
        suppressedSinceLastReport: 0,
        error: "database unavailable",
      },
    ]);
    expect(mocks.scheduleLogFlush).toHaveBeenCalledOnce();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: "Failed to load initial status",
      code: "compute_target_status_snapshot_failed",
    });
    expect(response.headers.get("Content-Type")).not.toBe("text/event-stream");
    expect(mocks.createSseStream).not.toHaveBeenCalled();
  });

  it("bounds reconnect snapshot failures per org without silencing another org", async () => {
    mocks.getStatusSnapshot.mockRejectedValue(
      new Error("database unavailable")
    );

    await GET(new Request("https://api.test/status-stream"));
    await GET(new Request("https://api.test/status-stream"));
    await GET(new Request("https://api.test/status-stream"));

    mocks.resolveAnyAuthContext.mockResolvedValue({
      ok: true,
      context: { organizationId: OTHER_ORGANIZATION_ID },
    });
    await GET(new Request("https://api.test/status-stream"));

    expect(snapshotFailureLogs().map((entry) => entry.organizationId)).toEqual([
      ORGANIZATION_ID,
      OTHER_ORGANIZATION_ID,
    ]);

    vi.advanceTimersByTime(SNAPSHOT_FAILURE_LOG_INTERVAL_MS);
    mocks.resolveAnyAuthContext.mockResolvedValue({
      ok: true,
      context: { organizationId: ORGANIZATION_ID },
    });
    await GET(new Request("https://api.test/status-stream"));

    expect(snapshotFailureLogs()[2]).toEqual({
      organizationId: ORGANIZATION_ID,
      suppressedSinceLastReport: 2,
      error: "database unavailable",
    });
  });

  it("returns the auth-failure response without reading a status snapshot", async () => {
    mocks.resolveAnyAuthContext.mockResolvedValue({
      ok: false,
      failure: AuthContextFailure.Unauthenticated,
    });

    const response = await GET(new Request("https://api.test/status-stream"));

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("unauthorized");
    expect(mocks.getStatusSnapshot).not.toHaveBeenCalled();
  });

  describe("failed-read reporting", () => {
    const POOL_TIMEOUT =
      "Timed out fetching a new connection from the connection pool";

    // The raw string, deliberately not derived from the constant: a Datadog
    // monitor in `example-infrastructure` keys on this literal, and every other
    // assertion here imports the symbol, so a rename would travel silently.
    it("pins the event name the example-infrastructure monitor keys on", () => {
      expect(STATUS_POLL_FAILED_EVENT).toBe(
        "compute_target_status_poll_failed"
      );
    });

    it("reports a failed read against the org that owns the stream", async () => {
      const { cancel } = await openStream();
      mocks.getStatusSnapshot.mockRejectedValue(new Error(POOL_TIMEOUT));

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(pollFailureLogs()).toHaveLength(1);
      expect(pollFailureLogs()[0]).toEqual({
        organizationId: ORGANIZATION_ID,
        consecutiveFailures: 1,
        suppressedSinceLastReport: 0,
        error: POOL_TIMEOUT,
      });

      cancel();
    });

    it("emits one line per window rather than one per failed read", async () => {
      const { cancel } = await openStream();
      mocks.getStatusSnapshot.mockRejectedValue(new Error(POOL_TIMEOUT));

      // Long enough for the window to roll several times, short enough that the
      // stream does not reach its own lifetime ceiling and stop polling.
      const failingForMs = 250_000;
      await vi.advanceTimersByTimeAsync(failingForMs);

      const failedReads = failingForMs / POLL_INTERVAL_MS;
      expect(pollCount()).toBe(failedReads);

      const logs = pollFailureLogs();
      expect(logs.length).toBeLessThan(failedReads);
      expect(logs.map((entry) => entry.consecutiveFailures)).toEqual([
        1, 13, 25, 37, 49,
      ]);
      // Nothing suppressed is lost: 5 emitted plus 44 carried accounts for 49 of
      // the 50 failed reads, the last sitting in the window still open.
      expect(logs.map((entry) => entry.suppressedSinceLastReport)).toEqual([
        0, 11, 11, 11, 11,
      ]);

      cancel();
    });

    it("holds the window across a recovered read and carries what it suppressed", async () => {
      const { cancel } = await openStream();

      mocks.getStatusSnapshot.mockRejectedValueOnce(new Error(POOL_TIMEOUT));
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(pollFailureLogs()).toHaveLength(1);

      // Recover, then fail again inside the SAME window. Clearing the window on
      // the good read would report this second failure immediately, which is the
      // per-failure flood the window exists to stop.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      mocks.getStatusSnapshot.mockRejectedValue(new Error(POOL_TIMEOUT));
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(pollFailureLogs()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(POLL_FAILURE_LOG_INTERVAL_MS);

      const logs = pollFailureLogs();
      expect(logs).toHaveLength(2);
      // 11, not 12: the recovered read ended the first streak. And the ten reads
      // the window swallowed are stated rather than dropped — without them an
      // interleaved outage would report as a single blip.
      expect(logs[1]).toMatchObject({
        consecutiveFailures: 11,
        suppressedSinceLastReport: 10,
      });

      cancel();
    });

    // A rejection is `unknown` at the boundary: a driver or a library is free to
    // reject with something that is not an `Error`, and the payload must still
    // name the lane rather than degrade to "[object Object]".
    it("describes a rejection that is not an Error", async () => {
      const { cancel } = await openStream();
      mocks.getStatusSnapshot.mockRejectedValue("pool gone");

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(pollFailureLogs()[0]).toMatchObject({
        organizationId: ORGANIZATION_ID,
        error: "pool gone",
      });

      cancel();
    });

    it("keeps the stream alive and delivering across failed reads", async () => {
      const { frames, cancel } = await openStream();
      mocks.getStatusSnapshot.mockRejectedValue(new Error(POOL_TIMEOUT));

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
      expect(pollFailureLogs()).toHaveLength(1);

      // Reporting must not have cost the resilience it was added to: the
      // connection is still held open for the client.
      expect(keepaliveFrames(frames).length).toBeGreaterThan(0);

      // And it is a live stream rather than merely an open socket — the next
      // good read still reaches the client.
      mocks.getStatusSnapshot.mockResolvedValue(
        snapshot([["target-1", false]])
      );
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(dataFrames(frames)).toHaveLength(1);
      expect(dataFrames(frames)[0]).toContain('"isOnline":false');

      cancel();
    });

    it("does not report a read that lost its race with the client leaving", async () => {
      const { cancel } = await openStream();
      let rejectPoll: ((error: Error) => void) | undefined;
      mocks.getStatusSnapshot.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectPoll = reject;
          })
      );

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      // The poll really is in flight, so the assertion below is about the guard
      // and not about a read that never happened.
      expect(pollCount()).toBe(1);
      expect(rejectPoll).toBeDefined();

      cancel();
      await vi.advanceTimersByTimeAsync(0);
      rejectPoll?.(new Error(POOL_TIMEOUT));
      await vi.advanceTimersByTimeAsync(0);

      // A torn-down stream is the routine end of every stream. Alerting on it
      // would put a line on the monitor every ~280s per client.
      expect(pollFailureLogs()).toHaveLength(0);
    });

    /**
     * THE AMPLIFICATION BOUND (#5646 review, whitlockk). Window state held in the
     * stream's own closure bounds one stream, so a single authenticated caller
     * opening N streams turns one database outage into N lines per window.
     *
     * The concurrency is real rather than narrated: all `CONCURRENT_STREAMS`
     * are opened BEFORE the clock moves, so every one of them schedules its
     * first poll at the same instant and a single timer advance fires all of
     * them inside one window. `failedReadsSince` re-measures that from the
     * service mock, so a test that had quietly serialised the streams would
     * fail its own precondition instead of passing vacuously.
     */
    const CONCURRENT_STREAMS = 5;

    async function openConcurrentStreams(): Promise<{ cancel: () => void }[]> {
      return await Promise.all(
        Array.from({ length: CONCURRENT_STREAMS }, () => openStream())
      );
    }

    function failedReadsSince(baseline: number): number {
      return mocks.getStatusSnapshot.mock.calls.length - baseline;
    }

    it("bounds emission per org rather than per concurrent stream", async () => {
      const streams = await openConcurrentStreams();
      const afterOpen = mocks.getStatusSnapshot.mock.calls.length;
      expect(afterOpen).toBe(CONCURRENT_STREAMS);
      mocks.getStatusSnapshot.mockRejectedValue(new Error(POOL_TIMEOUT));

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      // Precondition, not decoration: every stream really did run its own
      // failed read inside this one window.
      expect(failedReadsSince(afterOpen)).toBe(CONCURRENT_STREAMS);
      // One line for the org, not one per stream.
      expect(pollFailureLogs()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(POLL_FAILURE_LOG_INTERVAL_MS);

      const logs = pollFailureLogs();
      expect(logs).toHaveLength(2);
      expect(logs[1]).toMatchObject({ organizationId: ORGANIZATION_ID });
      // Collapsing five streams onto one line must not lose the other four
      // streams' failures. Every failed read is emitted, carried, or sitting in
      // the window still open — and the only reads in that window are the
      // boundary tick's, whose first read is what rolled it over.
      const pendingInOpenWindow = CONCURRENT_STREAMS - 1;
      expect(logs.length + Number(logs[1].suppressedSinceLastReport)).toBe(
        failedReadsSince(afterOpen) - pendingInOpenWindow
      );

      for (const stream of streams) {
        stream.cancel();
      }
    });

    // The remedy must bound the org, not silence the fleet: a second org's
    // outage is a different incident and still has to reach the monitor.
    it("keeps a second org's failures on their own line", async () => {
      const first = await openStream();
      mocks.resolveAnyAuthContext.mockResolvedValue({
        ok: true,
        context: { organizationId: OTHER_ORGANIZATION_ID },
      });
      const second = await openStream();
      mocks.getStatusSnapshot.mockRejectedValue(new Error(POOL_TIMEOUT));

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(pollFailureLogs().map((entry) => entry.organizationId)).toEqual([
        ORGANIZATION_ID,
        OTHER_ORGANIZATION_ID,
      ]);

      first.cancel();
      second.cancel();
    });

    // A suppressed count is materialised by an event, never by a clock, so an
    // org that goes quiet after a burst holds its count in process memory until
    // it fails again — on a serverless instance that then freezes, never.
    // `drainPollFailures` is wired to stream teardown, a terminal path this
    // route already runs, so the rollup reaches the monitor instead.
    it("flushes a quiet org's suppressed failures when the stream tears down", async () => {
      const { cancel } = await openStream();

      mocks.getStatusSnapshot.mockRejectedValueOnce(new Error(POOL_TIMEOUT));
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      mocks.getStatusSnapshot.mockRejectedValueOnce(new Error(POOL_TIMEOUT));
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(pollFailureLogs()).toHaveLength(1);

      // Reads recover, so nothing will ever roll this org's window over.
      await vi.advanceTimersByTimeAsync(POLL_FAILURE_LOG_INTERVAL_MS * 2);
      expect(pollFailureLogs()).toHaveLength(1);

      cancel();
      await vi.advanceTimersByTimeAsync(0);

      const logs = pollFailureLogs();
      expect(logs).toHaveLength(2);
      // `flushedBy` is not decoration: an `expiry` rollup is a quiet org being
      // drained, which is a different operational story from `eviction`.
      expect(logs[1]).toMatchObject({
        organizationId: ORGANIZATION_ID,
        occurrences: 1,
        aggregated: true,
        flushedBy: EmissionRollupCause.Expiry,
      });
    });

    // `reportPollFailure`'s own docstring says "Never throws": a failure to
    // REPORT a failed read must not also decide whether the polling stream
    // survives it. `pollFailureThrottle.record` is spied directly rather than
    // driven through some input, since nothing about a normal failed read can
    // make the throttle itself throw.
    // `poll()` invokes `reportPollFailure` from inside a bare `setTimeout`
    // callback with nothing downstream awaiting its result, so a `finally`
    // block still runs `scheduleNextPoll()` even if the catch body above it
    // throws -- polling would continue either way. The only OBSERVABLE
    // difference an uncaught throw makes is an unhandled rejection escaping
    // that timer callback, which is exactly what would crash a shared
    // serverless instance out from under every other stream on it. A listener
    // is the only thing that can see that, so the contract is pinned on it
    // rather than on poll counts alone.
    it("keeps polling and never lets a throwing record() call escape as an unhandled rejection", async () => {
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);

      try {
        const { cancel } = await openStream();
        mocks.getStatusSnapshot.mockRejectedValue(new Error(POOL_TIMEOUT));
        const recordSpy = vi
          .spyOn(pollFailureThrottle, "record")
          .mockImplementationOnce(() => {
            throw new Error("throttle exploded");
          });

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        expect(recordSpy).toHaveBeenCalledTimes(1);
        const pollsAfterThrowingRecord = pollCount();

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        expect(pollCount()).toBe(pollsAfterThrowingRecord + 1);

        cancel();
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
        expect(pollCount()).toBe(pollsAfterThrowingRecord + 1);

        recordSpy.mockRestore();
        expect(unhandledRejections).toHaveLength(0);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    });

    // Same "Never throws" contract, for `drainPollFailures` on the teardown
    // path. `unsubscribe` calls it directly, so an uncaught throw here would
    // abort cleanup before `createSseStream` clears its own keepalive and
    // max-duration timers.
    it("finishes teardown when the throttle's drainExpired() call throws", async () => {
      const { cancel } = await openStream();
      const drainSpy = vi
        .spyOn(pollFailureThrottle, "drainExpired")
        .mockImplementationOnce(() => {
          throw new Error("drain exploded");
        });

      cancel();
      await vi.advanceTimersByTimeAsync(0);

      expect(vi.getTimerCount()).toBe(0);

      drainSpy.mockRestore();
    });
  });
});
