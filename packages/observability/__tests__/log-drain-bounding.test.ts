// ISS-7219 review follow-up. Three defects in the DRAIN, not the buffer:
//
//   1. Every log arriving while a flush was in flight and the buffer was at the
//      batch size chained ANOTHER `flushToDatadog()` onto the one running. A
//      sustained outage therefore accumulated an unbounded promise queue, and
//      each waiter in it started a fresh retry cycle against the same retained
//      batch — hitting the intake far past the retry budget. All callers now
//      share ONE bounded drain.
//   2. The batch was taken out of the buffer BEFORE `JSON.stringify` ran, and
//      `JSON.stringify` throws synchronously on circular metadata — from inside
//      the `fetch(...)` argument list, before any `.catch` existed. So a caller
//      that logged a circular object (which the console sink deliberately
//      accepts) got an exception thrown back out of `log.info`, and the entries
//      already removed from the buffer vanished uncounted.
//   3. The drop report's throttle was bypassed at the end of every automatic
//      drain, so a full queue could re-emit after each flush cycle — the log
//      storm the interval exists to cap.
//
// A second review round added three more, all on the drain's ERROR path:
//
//   4. The catch skipped `reportPending()`, stranding already-tallied drop
//      counts until the next drop event or process exit, and left `retryCount`
//      wherever the error struck — silently shrinking every later cycle's
//      retry budget.
//   5. A throw between `takeBatch` and `returnBatch` lost the in-flight batch
//      with no counter moving.
//   6. When the retry budget was spent the entries went back to the buffer and
//      `cumulativeDropped` stayed 0 — correct for a long-running process, but
//      a serverless freeze then evaporated them while every counter read zero.
//
// These drive the PRODUCTION entry points (`log.info`, `log.flush`), never the
// buffer class, because every one of them lives in the wiring between them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BATCH_SIZE, MAX_RETRY_COUNT } from "../log";
import {
  DROP_REPORT_INTERVAL_MS,
  TelemetryDropReason,
  TelemetryFlushFailure,
} from "../log-buffer";
import {
  flushWithBackoff,
  importLogWithFetch,
  isolateExitListeners,
  parseDropReports,
  parseFlushedBody,
  parseUndeliveredReports,
  silenceConsole,
  stubDatadogEnv,
  useDeterministicTimers,
} from "./test-helpers";

const TEST_CEILING = 500;

// EVERY case in this file runs on the fake clock. Cases here deliberately end
// with entries still buffered — that is the behaviour under test — and on the
// real clock each one would leave an armed 5s flush interval firing into later
// tests. See `useDeterministicTimers`.
beforeEach(() => {
  useDeterministicTimers();
  // This file imports the module 16 times, and each import registers a
  // `beforeExit` listener that `vi.resetModules()` does not remove — which is
  // what the suite's `MaxListenersExceededWarning` reports. Detaching them per
  // case stops the accumulation and keeps a leaked instance from answering an
  // exit event on behalf of the one under test.
  isolateExitListeners();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded drain during a sustained outage (ISS-7219 review)", () => {
  it("keeps intake requests independent of how many logs arrived", async () => {
    const few = await countIntakeRequestsDuringOutage(2);
    const many = await countIntakeRequestsDuringOutage(20);

    // The unbounded promise queue was observable exactly here: ten times the
    // arrivals meant ten times the queued drains, each spending its own retry
    // budget against the same retained batch. One shared drain makes the cost
    // of an outage a function of the retry budget, not of traffic.
    expect(many).toBe(few);
    expect(few).toBe(MAX_RETRY_COUNT + 1);
  });

  it("stops re-entering once a cycle has spent its retry budget", async () => {
    stubDatadogEnv(TEST_CEILING);
    silenceConsole();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < MAX_BATCH_SIZE; index++) {
      log.info(`entry-${index}`);
    }
    await flushWithBackoff(log);
    const afterFirstCycle = fetchMock.mock.calls.length;

    // A second explicit flush is a NEW cycle with a fresh budget — that is the
    // point of giving up rather than looping — but it must not be able to run
    // more than one budget's worth either.
    await flushWithBackoff(log);

    expect(afterFirstCycle).toBe(MAX_RETRY_COUNT + 1);
    expect(fetchMock.mock.calls.length).toBe((MAX_RETRY_COUNT + 1) * 2);
    // The data is not what a spent budget gives up on: it stays buffered.
    expect(log.droppedStats().bufferLength).toBe(MAX_BATCH_SIZE);
    expect(log.droppedStats().cumulativeDropped).toBe(0);
  });
});

describe("poison batch handling (ISS-7219 review)", () => {
  it("never throws out of a log call when metadata is circular", async () => {
    stubDatadogEnv(TEST_CEILING);
    silenceConsole();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < MAX_BATCH_SIZE - 1; index++) {
      log.info(`entry-${index}`);
    }

    // The entry that trips the batch-size flush is the circular one, so
    // serialization runs synchronously inside this very call. A logging API
    // that throws here takes its caller down for writing a log line.
    expect(() => log.info("poisoned", circularMeta())).not.toThrow();
    await flushWithBackoff(log);
  });

  it("accounts for a poison entry instead of losing it silently", async () => {
    stubDatadogEnv(TEST_CEILING);
    silenceConsole();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < MAX_BATCH_SIZE - 1; index++) {
      log.info(`entry-${index}`);
    }
    log.info("poisoned", circularMeta());
    await flushWithBackoff(log);

    // Conservation: the batch was already out of the buffer when serialization
    // refused it, so an entry that cannot be shipped has to be COUNTED. An
    // uncounted loss is the false completeness this whole change removes.
    const stats = log.droppedStats();
    expect(stats.byReason[TelemetryDropReason.Unserializable]).toBe(1);
    expect(stats.cumulativeDropped).toBe(1);
    expect(stats.bufferLength).toBe(0);
  });

  it("still ships the healthy entries that shared the poison batch", async () => {
    stubDatadogEnv(TEST_CEILING);
    silenceConsole();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < MAX_BATCH_SIZE - 1; index++) {
      log.info(`entry-${index}`);
    }
    log.info("poisoned", circularMeta());
    await flushWithBackoff(log);

    // One bad object must not cost the 99 good entries batched beside it.
    const shipped = parseFlushedBody<{ message: string }>(fetchMock, 0);
    expect(shipped).toHaveLength(MAX_BATCH_SIZE - 1);
    expect(shipped.at(-1)?.message).toBe(`entry-${MAX_BATCH_SIZE - 2}`);
    expect(shipped.some((entry) => entry.message === "poisoned")).toBe(false);
  });

  it("sends no request at all when every entry in the batch is poison", async () => {
    stubDatadogEnv(TEST_CEILING);
    silenceConsole();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < MAX_BATCH_SIZE; index++) {
      log.info(`poisoned-${index}`, circularMeta());
    }
    await flushWithBackoff(log);

    // An empty body is not a batch; posting `[]` would be a request that lies
    // about having shipped something.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      log.droppedStats().byReason[TelemetryDropReason.Unserializable]
    ).toBe(MAX_BATCH_SIZE);
  });

  it("does not return a poison entry to the buffer when the intake fails", async () => {
    stubDatadogEnv(TEST_CEILING);
    silenceConsole();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < MAX_BATCH_SIZE - 1; index++) {
      log.info(`entry-${index}`);
    }
    log.info("poisoned", circularMeta());
    await flushWithBackoff(log);
    const afterFirstOutage = log.droppedStats();

    await flushWithBackoff(log);

    // A retry replays what the payload was BUILT from, not the batch that was
    // taken. Handing the poison entry back would re-poison every batch it lands
    // in for the life of the process, and re-count it on every cycle.
    expect(afterFirstOutage.bufferLength).toBe(MAX_BATCH_SIZE - 1);
    expect(afterFirstOutage.byReason[TelemetryDropReason.Unserializable]).toBe(
      1
    );
    expect(
      log.droppedStats().byReason[TelemetryDropReason.Unserializable]
    ).toBe(1);
    expect(log.droppedStats().bufferLength).toBe(MAX_BATCH_SIZE - 1);
  });
});

describe("drop-report throttle on the drain path (ISS-7219 review)", () => {
  it("does not re-report after every automatic drain", async () => {
    stubDatadogEnv(TEST_CEILING);
    const errorSpy = silenceConsole();
    // A 400 is non-retryable, so each batch is counted as dropped and the drain
    // moves straight on — no backoff, several drop-producing cycles in one
    // five-second throttle window.
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    const log = await importLogWithFetch(fetchMock);

    for (let cycle = 0; cycle < 4; cycle++) {
      for (let index = 0; index < MAX_BATCH_SIZE; index++) {
        log.info(`cycle-${cycle}-entry-${index}`);
      }
      await flushWithBackoff(log);
    }

    // Four drains, four batches rejected, ONE report: the first drop reports
    // immediately and the rest coalesce. Bypassing the throttle at the end of a
    // normal drain is what recreated the storm.
    const reports = parseDropReports<{ reason: string }>(errorSpy);
    expect(reports).toHaveLength(1);
    expect(reports[0].reason).toBe(TelemetryDropReason.IntakeRejected);
    // Suppressed is not lost — the tally kept counting through the window.
    expect(log.droppedStats().cumulativeDropped).toBe(MAX_BATCH_SIZE * 4);
  });
});

describe("drain cleanup after an unexpected error (log.ts:276)", () => {
  it("still emits pending drop counts when the drain throws mid-cycle", async () => {
    stubDatadogEnv(TEST_CEILING);
    vi.spyOn(console, "info").mockImplementation(() => {
      // the local-dev console line is not under test
    });
    const errorSpy = throwOnFlushErrorLog(1);
    // Two non-retryable rejections produce drops without touching capacity: the
    // first reports immediately and opens the throttle window, the second sits
    // PENDING behind it. The third call moves the clock past the window and
    // then fails transport-style, so the throwing console line runs while a
    // pending count is outstanding and the buffer has room — meaning NO new
    // drop can fire the report on its own. `reportPending()` in the drain's
    // cleanup is the only thing left that can emit it.
    const fetchMock = vi.fn().mockImplementation(() => {
      if (fetchMock.mock.calls.length <= 2) {
        return Promise.resolve({ ok: false, status: 400 });
      }
      vi.setSystemTime(new Date(Date.now() + DROP_REPORT_INTERVAL_MS + 1));
      return Promise.reject(new TypeError("fetch failed"));
    });
    const log = await importLogWithFetch(fetchMock);

    // Filling past the batch size starts the AUTOMATIC drain, which is the
    // point — `log.flush()` calls `reportPending()` in its own `.then`, so
    // driving this through the public flush would mask a drain that skipped
    // its own call.
    for (let index = 0; index < MAX_BATCH_SIZE * 3; index++) {
      log.info(`entry-${index}`);
    }
    // Let the drain run: two rejections, then the throwing one.
    await vi.advanceTimersByTimeAsync(1000);

    // The counts were already tallied; only their EMISSION lives on the path
    // the throw skipped. Stranded, they surface no earlier than the next drop
    // event or process exit — the exact window an operator is staring at.
    const reports = parseDropReports<DropReport>(errorSpy);
    expect(reports).toHaveLength(2);
    expect(reports[1].count).toBe(MAX_BATCH_SIZE);
  });

  it("does not shrink the next cycle's retry budget when the drain throws", async () => {
    stubDatadogEnv(TEST_CEILING);
    vi.spyOn(console, "info").mockImplementation(() => {
      // the local-dev console line is not under test
    });
    // Throw on the SECOND flush-failure line, so retryCount has already been
    // incremented to 1 when the error escapes.
    throwOnFlushErrorLog(2);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < MAX_BATCH_SIZE; index++) {
      log.info(`entry-${index}`);
    }
    await flushWithBackoff(log);
    fetchMock.mockClear();

    await flushWithBackoff(log);

    // Counted, not timed: `retryCount` is cycle-local state in a module-level
    // variable, so a value left behind by an unexpected throw is silently
    // subtracted from the NEXT cycle's budget. At retryCount=1 this second
    // cycle would make 2 requests instead of 3, and would keep shrinking.
    expect(fetchMock.mock.calls.length).toBe(MAX_RETRY_COUNT + 1);
  });

  it("does not lose the in-flight batch when the drain throws", async () => {
    stubDatadogEnv(TEST_CEILING);
    vi.spyOn(console, "info").mockImplementation(() => {
      // the local-dev console line is not under test
    });
    throwOnFlushErrorLog(1);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < MAX_BATCH_SIZE; index++) {
      log.info(`entry-${index}`);
    }
    await flushWithBackoff(log);

    // The batch is OUT of the buffer between `takeBatch` and `returnBatch`, so
    // anything throwing in that window would drop it with no counter moving —
    // the uncounted loss this change exists to remove. Conservation holds: every
    // entry is either buffered or counted.
    const stats = log.droppedStats();
    expect(stats.bufferLength + stats.cumulativeDropped).toBe(MAX_BATCH_SIZE);
    expect(stats.bufferLength).toBe(MAX_BATCH_SIZE);
  });
});

describe("undelivered accounting on the freeze path (log.ts:355)", () => {
  it("records an abandoned cycle when the budget is spent with entries buffered", async () => {
    stubDatadogEnv(TEST_CEILING);
    silenceConsole();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < MAX_BATCH_SIZE; index++) {
      log.info(`entry-${index}`);
    }
    await flushWithBackoff(log);

    const stats = log.droppedStats();
    // Still buffered, so still NOT drops — a long-running process delivers them
    // on the next interval, and counting them here would overstate loss.
    expect(stats.cumulativeDropped).toBe(0);
    expect(stats.bufferLength).toBe(MAX_BATCH_SIZE);
    // But this is the moment a serverless freeze evaporates them, and it used
    // to be completely silent: every counter read 0 straight through the loss.
    expect(stats.cumulativeAbandonedCycles).toBe(1);
  });

  it("reports the at-risk entry count and the failure behind it", async () => {
    stubDatadogEnv(TEST_CEILING);
    const errorSpy = silenceConsole();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < MAX_BATCH_SIZE; index++) {
      log.info(`entry-${index}`);
    }
    await flushWithBackoff(log);

    const reports = parseUndeliveredReports<UndeliveredReport>(errorSpy);
    expect(reports).toHaveLength(1);
    expect(reports[0].undeliveredEntries).toBe(MAX_BATCH_SIZE);
    expect(reports[0].cumulativeAbandonedCycles).toBe(1);
    expect(reports[0].cause).toBe(TelemetryFlushFailure.TransportError);
  });

  it("counts cycles rather than entries, so one backlog is not tallied twice", async () => {
    stubDatadogEnv(TEST_CEILING);
    silenceConsole();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < MAX_BATCH_SIZE; index++) {
      log.info(`entry-${index}`);
    }
    await flushWithBackoff(log);
    await flushWithBackoff(log);
    await flushWithBackoff(log);

    // The SAME 100 entries are abandoned three times. Summing the backlog size
    // would report 300 undelivered entries for 100 that were never lost — the
    // inflated-tally shape this counter is shaped to avoid.
    const stats = log.droppedStats();
    expect(stats.cumulativeAbandonedCycles).toBe(3);
    expect(stats.bufferLength).toBe(MAX_BATCH_SIZE);
    expect(stats.cumulativeDropped).toBe(0);
  });

  it("does not record an abandoned cycle when the drain completes", async () => {
    stubDatadogEnv(TEST_CEILING);
    const errorSpy = silenceConsole();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < MAX_BATCH_SIZE; index++) {
      log.info(`entry-${index}`);
    }
    await flushWithBackoff(log);

    // The flag tracks whether the CYCLE gave up, not whether the buffer happens
    // to be non-empty — an entry enqueued as a healthy drain finishes must not
    // be reported as at-risk.
    expect(log.droppedStats().cumulativeAbandonedCycles).toBe(0);
    expect(parseUndeliveredReports<UndeliveredReport>(errorSpy)).toHaveLength(
      0
    );
  });
});

/** The `telemetryUndelivered` payload as the platform drain receives it. */
type UndeliveredReport = {
  undeliveredEntries: number;
  cumulativeAbandonedCycles: number;
  cause?: TelemetryFlushFailure;
};

/** Minimal shape of a `telemetryDropped` payload for these tests. */
type DropReport = { reason: string; count: number };

/**
 * Make the flush-failure `console.error` throw on its `nth` call, simulating an
 * unexpected error escaping mid-drain.
 *
 * That line is the first statement of `handleFlushError`, which runs inside
 * `sendNextBatch`'s catch — so a throw there propagates out of `sendNextBatch`
 * into `drainBuffer`'s own catch, which is the path under test. Choosing `nth`
 * chooses how much cycle-local state (notably `retryCount`) has accumulated
 * before the error strikes.
 */
function throwOnFlushErrorLog(nth: number): ReturnType<typeof vi.spyOn> {
  let seen = 0;
  return vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (!first.startsWith("[observability] Failed to flush")) {
      return;
    }
    seen++;
    if (seen === nth) {
      throw new Error("console sink failed mid-drain");
    }
  });
}

/** A meta object `JSON.stringify` refuses and the console sink accepts. */
function circularMeta(): Record<string, unknown> {
  const meta: Record<string, unknown> = { name: "cycle" };
  meta.self = meta;
  return meta;
}

/**
 * Run one dead-intake outage with `batches` batches' worth of arrivals and
 * report how many times the intake was actually called.
 *
 * Every arrival past the batch size calls into the flush path, so the arrival
 * count is precisely the dimension the old chained-promise drain scaled on.
 */
async function countIntakeRequestsDuringOutage(
  batches: number
): Promise<number> {
  stubDatadogEnv(TEST_CEILING);
  silenceConsole();
  const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
  const log = await importLogWithFetch(fetchMock);

  for (let index = 0; index < MAX_BATCH_SIZE * batches; index++) {
    log.info(`entry-${index}`);
  }
  await flushWithBackoff(log);

  const calls = fetchMock.mock.calls.length;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  return calls;
}
