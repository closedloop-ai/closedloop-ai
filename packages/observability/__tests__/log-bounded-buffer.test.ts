// ISS-7219. `cl-api` emits `[observability] Dropping 1 log entries after 2
// retries` in production alongside Datadog flush timeouts, and the buffer those
// entries were dropped from had no maximum length at all. Two defects, and the
// second is the worse one: an UNCOUNTED drop makes every log-sourced count a
// floor rather than a measurement, and the loss is load-correlated, so the
// denominator goes unknown exactly when a monitor built on those counts fires.
//
// What these pin:
//   1. The buffer cannot grow without bound, through the production enqueue
//      path — not the class in isolation — and the DEFAULT ceiling binds even
//      when no operator override is set.
//   2. Every entry that leaves the pipeline increments the cumulative counter.
//      A silent drop is the bug, so a shed that does not move the counter must
//      fail here.
//   3. The shed policy is OLDEST-first, asserted on what was actually RETAINED
//      and shipped. A refactor that flips it to newest-first loses the incident
//      an operator is currently in, and must not be able to do so quietly.
//   4. The key-egress guards this flush path already carried — `redirect:
//      "error"` and the DD_SITE allowlist — still hold.
//
// The production-path cases run against a small configured ceiling so the fill
// and the drain stay cheap; the default ceiling is pinned separately against
// the buffer itself, where reaching it costs no serialization.
//
// LEAKED INSTANCES ARE THE HAZARD IN THIS SUITE. `vi.resetModules()` orphans a
// module instance without stopping its unref'd 5s flush interval or removing
// its `beforeExit` listener, so an orphan still holding entries will later fire
// into whichever test is running — calling that test's `fetch` mock and writing
// to its `console.error` spy. Two defences, and a case needs whichever applies:
//   - a case that finishes with entries buffered runs on the fake clock
//     (`useDeterministicTimers`), which teardown discards along with the
//     interval;
//   - a case that emits `beforeExit` itself calls `isolateExitListeners()`, so
//     only the instance under test answers.
// Every other case drains its buffer before finishing, which leaves nothing for
// an orphan to ship.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoundedLogBuffer,
  DROP_REPORT_INTERVAL_MS,
  MAX_BUFFER_ENTRIES,
  MAX_CONFIGURABLE_BUFFER_ENTRIES,
  resolveMaxBufferEntries,
  TelemetryDropReason,
  TelemetryFlushFailure,
} from "../log-buffer";
import {
  type DropReport,
  deleteEnvForTest,
  findReport,
  flushWithBackoff,
  importLogWithFetch,
  isolateExitListeners,
  parseDropReports,
  parseFlushedBody,
  silenceConsole,
  stubDatadogEnv as stubDatadogEnvWithCeiling,
  useDeterministicTimers,
} from "./test-helpers";

const API_KEY = "dd-api-key-value";
const TEST_CEILING = 300;
const IN_FLIGHT_BATCH = 100;
const OVERFLOW_ENTRIES = 250;
const TOTAL_ENTRIES = TEST_CEILING + OVERFLOW_ENTRIES;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stubDatadogEnv() {
  stubDatadogEnvWithCeiling(TEST_CEILING);
}

/**
 * A fetch whose FIRST call never settles, so exactly one 100-entry batch is
 * taken out of the buffer and held in flight while the rest of the intake
 * backlog accumulates. Resolving the deferred releases the drain, at which
 * point every later call succeeds and the retained entries are shipped — which
 * is how the shed policy becomes observable from outside the module.
 */
function makeStallingFetch() {
  let release: () => void = () => {
    // replaced synchronously on the first call
  };
  const fetchMock = vi.fn().mockImplementation(() => {
    if (fetchMock.mock.calls.length === 1) {
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 202 });
      });
    }
    return Promise.resolve({ ok: true, status: 202 });
  });
  return { fetchMock, release: () => release() };
}

describe("bounded telemetry buffer (ISS-7219)", () => {
  it("cannot grow without bound while the intake is stalled", async () => {
    stubDatadogEnv();
    silenceConsole();
    const { fetchMock, release } = makeStallingFetch();
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < TOTAL_ENTRIES; index++) {
      log.info(`entry-${index}`);
    }

    expect(log.droppedStats().bufferLength).toBeLessThanOrEqual(TEST_CEILING);
    expect(log.droppedStats().bufferLength).toBe(TEST_CEILING);

    release();
    await log.flush();
    expect(log.droppedStats().bufferLength).toBe(0);
  });

  it("accounts for every entry it sheds", async () => {
    stubDatadogEnv();
    silenceConsole();
    const { fetchMock, release } = makeStallingFetch();
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < TOTAL_ENTRIES; index++) {
      log.info(`entry-${index}`);
    }

    // Conservation: everything enqueued is either still buffered, held in the
    // one in-flight batch, or counted as dropped. Nothing may go missing
    // without moving the counter — that silence is the defect.
    const stats = log.droppedStats();
    expect(stats.bufferLength + IN_FLIGHT_BATCH + stats.cumulativeDropped).toBe(
      TOTAL_ENTRIES
    );
    expect(stats.cumulativeDropped).toBe(OVERFLOW_ENTRIES - IN_FLIGHT_BATCH);
    expect(stats.byReason[TelemetryDropReason.QueueFull]).toBe(
      stats.cumulativeDropped
    );

    release();
    await log.flush();
  });

  it("sheds the OLDEST entries and ships the newest", async () => {
    stubDatadogEnv();
    silenceConsole();
    const { fetchMock, release } = makeStallingFetch();
    const log = await importLogWithFetch(fetchMock);

    for (let index = 0; index < TOTAL_ENTRIES; index++) {
      log.info(`entry-${index}`);
    }

    release();
    await log.flush();

    // Call 0 is the batch that was already in flight (entries 0-99). Call 1 is
    // the head of what SURVIVED the shed. Oldest-first shedding means the
    // survivors start after the overflow; newest-first would put `entry-100`
    // here and would have thrown away the most recent entries instead.
    const survivors = parseFlushedBody<{ message: string }>(fetchMock, 1);
    expect(survivors[0].message).toBe(`entry-${OVERFLOW_ENTRIES}`);

    const lastCall = fetchMock.mock.calls.length - 1;
    const newest = parseFlushedBody<{ message: string }>(fetchMock, lastCall);
    expect(newest.at(-1)?.message).toBe(`entry-${TOTAL_ENTRIES - 1}`);
  });

  it("counts a batch the intake refuses with a non-retryable status", async () => {
    stubDatadogEnv();
    silenceConsole();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    const log = await importLogWithFetch(fetchMock);

    log.info("rejected-entry");
    await log.flush();

    const stats = log.droppedStats();
    expect(stats.cumulativeDropped).toBe(1);
    expect(stats.byReason[TelemetryDropReason.IntakeRejected]).toBe(1);
    expect(stats.lastFlushFailure).toBe(TelemetryFlushFailure.ClientError);
  });

  it("keeps a timed-out batch buffered instead of dropping it after 2 retries", async () => {
    stubDatadogEnv();
    silenceConsole();
    // The real shape: `AbortSignal.timeout()` rejects with a DOMException, NOT
    // an Error subclass. Hand-rolling `new Error()` with `name` reassigned
    // would leave the classifier's host-object handling untested, and a
    // misclassified timeout would put the wrong `cause` on the drop report.
    const timeout = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError"
    );
    const fetchMock = vi.fn().mockRejectedValue(timeout);
    // This is the one case in THIS file that deliberately finishes with an
    // entry still buffered, so it is the one that would otherwise leave an
    // armed 5s flush interval on the real clock. The fake clock is discarded in
    // teardown, so the orphaned instance can never fire into a later test.
    useDeterministicTimers();
    const log = await importLogWithFetch(fetchMock);

    log.info("survives-the-outage");
    await flushWithBackoff(log);

    // The production symptom was this entry being dropped right here. It is
    // not: the retry budget is what the cycle gives up on, not the data.
    const stats = log.droppedStats();
    expect(stats.cumulativeDropped).toBe(0);
    expect(stats.bufferLength).toBe(1);
    expect(stats.lastFlushFailure).toBe(TelemetryFlushFailure.Timeout);
  });

  it("attempts the exit flush at most once, so a stalled intake cannot wedge shutdown", async () => {
    stubDatadogEnv();
    silenceConsole();
    vi.useFakeTimers();
    // Only the instance under test may answer the event: orphaned instances
    // from earlier cases still carry their own `beforeExit` listener, and one
    // holding buffered entries would flush into THIS test's fetch mock and
    // inflate the very counts it asserts.
    isolateExitListeners();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const log = await importLogWithFetch(fetchMock);

    log.info("still-here-at-exit");
    process.emit("beforeExit", 0);
    // 2s covers the 200ms + 400ms retry backoffs without reaching the 5s flush
    // interval, which would never drain under runAllTimersAsync.
    await vi.advanceTimersByTimeAsync(2000);

    const afterFirstExit = fetchMock.mock.calls.length;
    expect(afterFirstExit).toBeGreaterThan(0);
    // The entry survived the outage — which is exactly what makes `beforeExit`
    // eligible to fire again, because `buffer.length > 0` stays true.
    expect(log.droppedStats().bufferLength).toBe(1);

    for (let index = 0; index < 5; index++) {
      process.emit("beforeExit", 0);
    }
    await vi.advanceTimersByTimeAsync(2000);

    // `beforeExit` re-fires every time the event loop drains, and a flush
    // schedules a fetch that keeps it alive. Without the one-shot guard this
    // is an unkillable process during a Datadog outage, not a slow one.
    expect(fetchMock.mock.calls.length).toBe(afterFirstExit);
  });

  it("still refuses redirects on the flush that carries the API key", async () => {
    stubDatadogEnv();
    silenceConsole();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const log = await importLogWithFetch(fetchMock);

    log.info("egress-guard");
    await log.flush();

    // A 307 would replay the batch AND the DD-API-KEY header to the redirect
    // target, past the site allowlist.
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
  });

  it("buffers nothing at all when DD_SITE fails the allowlist", async () => {
    vi.stubEnv("DD_API_KEY", API_KEY);
    vi.stubEnv("DD_SITE", "datadoghq.com@attacker.example");
    silenceConsole();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const log = await importLogWithFetch(fetchMock);

    log.info("must.not.egress");
    await log.flush();

    expect(fetchMock).not.toHaveBeenCalled();
    // The refused sink must not become a memory leak of its own: with the key
    // withheld nothing is buffered, and nothing is counted as dropped either.
    expect(log.droppedStats().bufferLength).toBe(0);
    expect(log.droppedStats().cumulativeDropped).toBe(0);
  });
});

describe("BoundedLogBuffer ceiling", () => {
  it("binds at the default ceiling when no override is configured", () => {
    silenceConsole();
    deleteEnvForTest("DD_LOG_BUFFER_MAX_ENTRIES");
    const buffer = new BoundedLogBuffer<string>(resolveMaxBufferEntries());

    for (let index = 0; index < MAX_BUFFER_ENTRIES + 1; index++) {
      buffer.push(`entry-${index}`);
    }

    expect(buffer.length).toBe(MAX_BUFFER_ENTRIES);
    expect(buffer.stats().cumulativeDropped).toBe(1);
  });

  it.each([
    ["0"],
    ["-1"],
    ["not-a-number"],
    [""],
    ["   "],
    // parseInt reads these as a ONE-entry ceiling, which would shed all but the
    // newest log — the loudest possible way to honour a typo.
    ["1oops"],
    ["1.5"],
    ["1e"],
    ["-1000"],
    ["Infinity"],
    // Over the hard ceiling: the ring is allocated up front, so an
    // out-of-range override is an allocation instruction, not a ceiling.
    [String(MAX_CONFIGURABLE_BUFFER_ENTRIES + 1)],
    ["9007199254740991"],
  ])("falls back to the default when the override is %s", (configured) => {
    vi.stubEnv("DD_LOG_BUFFER_MAX_ENTRIES", configured);

    // A non-ceiling is a misconfiguration. Honouring it would either shed
    // every entry on arrival or restore unbounded growth.
    expect(resolveMaxBufferEntries()).toBe(MAX_BUFFER_ENTRIES);
  });

  it.each([
    ["1", 1],
    ["250", 250],
    ["  2500  ", 2500],
    [String(MAX_CONFIGURABLE_BUFFER_ENTRIES), MAX_CONFIGURABLE_BUFFER_ENTRIES],
  ])("honours the whole value %s as a ceiling", (configured, expected) => {
    vi.stubEnv("DD_LOG_BUFFER_MAX_ENTRIES", configured);

    expect(resolveMaxBufferEntries()).toBe(expected);
  });

  it("refuses to allocate a ring larger than the hard ceiling", () => {
    silenceConsole();

    // The ring is allocated at construction. Unclamped, this is
    // `new Array(4e10)` — a RangeError raised while building the module-level
    // buffer, at import time, in a module imported almost everywhere. The upper
    // clamp is what keeps a bad number from being an allocation instruction.
    expect(() => new BoundedLogBuffer<string>(40_000_000_000)).not.toThrow();
    expect(() => new BoundedLogBuffer<string>(Number.NaN)).not.toThrow();
  });
});

describe("BoundedLogBuffer shed policy", () => {
  it("evicts from the front so the newest entries are the survivors", () => {
    silenceConsole();
    const buffer = new BoundedLogBuffer<string>(3);

    for (const entry of ["a", "b", "c", "d", "e"]) {
      buffer.push(entry);
    }

    expect(buffer.peek()).toEqual(["c", "d", "e"]);
    expect(buffer.stats().cumulativeDropped).toBe(2);
  });

  it("returns a refused batch to the front, where it is shed first", () => {
    silenceConsole();
    const buffer = new BoundedLogBuffer<string>(3);
    buffer.push("d");
    buffer.push("e");
    buffer.push("f");

    // The batch is older than everything behind it, so restoring order puts it
    // in front — and being in front is what makes an already-refused batch the
    // first thing capacity takes. Newest-first shedding would have inverted
    // this: the refused batch would pin the buffer and evict d/e/f instead.
    buffer.returnBatch(["a", "b", "c"]);

    expect(buffer.peek()).toEqual(["d", "e", "f"]);
    expect(buffer.stats().cumulativeDropped).toBe(3);
  });

  it("clamps a nonsensical ceiling instead of shedding every entry", () => {
    silenceConsole();
    const buffer = new BoundedLogBuffer<string>(-5);

    buffer.push("kept");

    expect(buffer.peek()).toEqual(["kept"]);
    expect(buffer.stats().cumulativeDropped).toBe(0);
  });

  it("never counts a drop that did not happen", () => {
    silenceConsole();
    const buffer = new BoundedLogBuffer<string>(2);

    buffer.recordRejected(0, 400);

    expect(buffer.stats().cumulativeDropped).toBe(0);
    expect(buffer.stats().byReason[TelemetryDropReason.IntakeRejected]).toBe(0);
  });

  it("preserves FIFO order across the ring's wrap point", () => {
    silenceConsole();
    const buffer = new BoundedLogBuffer<number>(4);

    for (const entry of [0, 1, 2, 3]) {
      buffer.push(entry);
    }
    const taken = buffer.takeBatch(3);
    for (const entry of [4, 5, 6, 7]) {
      buffer.push(entry);
    }

    // The head is mid-array by now, so every read wraps. A ring that loses
    // chronological order here would ship an out-of-order timeline to Datadog
    // and shed the wrong end of the buffer.
    expect(taken).toEqual([0, 1, 2]);
    expect(buffer.peek()).toEqual([4, 5, 6, 7]);
    expect(buffer.stats().cumulativeDropped).toBe(1);
  });

  it("stores an arriving entry at a cost independent of the ceiling", () => {
    silenceConsole();
    const arrivals = 200;
    const small = filledBuffer(SMALL_CEILING);
    const large = filledBuffer(LARGE_CEILING);
    const smallBefore = small.slotWrites;
    const largeBefore = large.slotWrites;

    for (let index = 0; index < arrivals; index++) {
      small.push(`arrival-${index}`);
      large.push(`arrival-${index}`);
    }

    // Counted, never timed (repo bans timing assertions, and a clock would
    // measure the machine rather than the algorithm). Splicing the head of an
    // array moved every remaining entry per arrival, so this cost scaled with
    // the ceiling: at 100x the capacity it was 100x the work on the request
    // process. A ring pays one eviction release plus one store, always.
    const smallCost = small.slotWrites - smallBefore;
    const largeCost = large.slotWrites - largeBefore;
    expect(largeCost).toBe(smallCost);
    expect(smallCost).toBe(arrivals * 2);
  });

  it("returns a refused batch at a cost set by the batch, not the ceiling", () => {
    silenceConsole();
    const batch = Array.from({ length: 100 }, (_, index) => `refused-${index}`);
    // Both ceilings clear the batch, so nothing is shed and the only work
    // measured is the prepend itself.
    const small = new BoundedLogBuffer<string>(SMALL_RETURN_CEILING);
    const large = new BoundedLogBuffer<string>(LARGE_RETURN_CEILING);

    small.returnBatch(batch);
    large.returnBatch(batch);

    // Prepending is where an array would have paid twice: `unshift` relocates
    // the whole buffer. The ring walks the head backwards instead.
    expect(large.slotWrites).toBe(small.slotWrites);
    expect(small.slotWrites).toBe(batch.length);
  });

  it("labels every coalesced count with the group it describes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const errorSpy = silenceConsole();
    const buffer = new BoundedLogBuffer<string>(1);

    // Spend the first, unthrottled report so everything after it coalesces.
    buffer.push("a");
    buffer.push("b");
    errorSpy.mockClear();

    // Three distinct groups inside one throttle window.
    buffer.push("c");
    buffer.recordRejected(7, 400);
    buffer.recordRejected(3, 413);

    vi.setSystemTime(new Date(Date.now() + DROP_REPORT_INTERVAL_MS + 1));
    buffer.reportPending();

    const reports = parseDropReports<DropReport>(errorSpy);
    const queueFull = findReport(reports, TelemetryDropReason.QueueFull);
    const rejected400 = findReport(
      reports,
      TelemetryDropReason.IntakeRejected,
      400
    );
    const rejected413 = findReport(
      reports,
      TelemetryDropReason.IntakeRejected,
      413
    );

    // Before this split, the three collapsed into ONE report of 11 stamped with
    // whichever reason and status arrived last — a query grouped by reason then
    // read a confidently wrong number for every group it produced.
    expect(reports).toHaveLength(3);
    expect(queueFull.count).toBe(1);
    expect(queueFull.httpStatus).toBeUndefined();
    expect(rejected400.count).toBe(7);
    expect(rejected413.count).toBe(3);

    // Each cumulative value describes the label it is attached to; the
    // process-wide total is emitted under the name that says process-wide.
    expect(queueFull.cumulativeByReason[TelemetryDropReason.QueueFull]).toBe(2);
    expect(
      rejected400.cumulativeByReason[TelemetryDropReason.IntakeRejected]
    ).toBe(10);
    expect(
      rejected413.cumulativeByReason[TelemetryDropReason.IntakeRejected]
    ).toBe(10);
    expect(queueFull.cumulativeDropped).toBe(12);
    expect(queueFull.maxBufferEntries).toBe(1);
  });

  it("carries each group's own cause rather than the latest one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const errorSpy = silenceConsole();
    const buffer = new BoundedLogBuffer<string>(1);

    buffer.push("a");
    buffer.push("b");
    errorSpy.mockClear();

    buffer.noteFlushFailure(TelemetryFlushFailure.Timeout);
    buffer.push("shed-during-timeout");
    buffer.noteFlushFailure(TelemetryFlushFailure.TransportError);
    buffer.push("shed-during-transport-error");

    vi.setSystemTime(new Date(Date.now() + DROP_REPORT_INTERVAL_MS + 1));
    buffer.reportPending();

    // `cause` answers "why did the backlog build", so it belongs to the drops
    // that happened while it was true — not to whatever the intake was doing
    // when the throttle finally let a report out.
    const causes = parseDropReports<DropReport>(errorSpy).map(
      (report) => report.cause
    );
    expect(causes).toContain(TelemetryFlushFailure.Timeout);
    expect(causes).toContain(TelemetryFlushFailure.TransportError);
  });

  it("holds a coalesced report until the window elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const errorSpy = silenceConsole();
    const buffer = new BoundedLogBuffer<string>(1);
    buffer.push("a");
    // The first drop always reports — that transition is the signal. It is also
    // what OPENS the throttle window, so everything after it is coalesced.
    buffer.push("b");
    errorSpy.mockClear();

    buffer.push("c");
    expect(parseDropReports<DropReport>(errorSpy)).toHaveLength(0);

    // reportPending() runs on every flush completion and on every
    // `log.flush()`, which serverless callers make once per request. If it
    // forced a report it would defeat the throttle under exactly the sustained
    // backlog the throttle exists to survive.
    buffer.reportPending();
    buffer.reportPending();
    buffer.reportPending();
    expect(parseDropReports<DropReport>(errorSpy)).toHaveLength(0);

    // Process teardown has no "later", so that one forces.
    buffer.reportFinal();
    const forced = parseDropReports<DropReport>(errorSpy);
    expect(forced).toHaveLength(1);
    expect(forced[0].count).toBe(1);

    // And forcing consumes the pending drops rather than double-counting them.
    buffer.reportFinal();
    expect(parseDropReports<DropReport>(errorSpy)).toHaveLength(1);
  });

  it("never reports one reason's drops under another reason", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const errorSpy = silenceConsole();
    const buffer = new BoundedLogBuffer<string>(1);

    // Two pushes: the second overflows, and that first drop reports
    // immediately, which is what opens the throttle window.
    buffer.push("a");
    buffer.push("b");
    errorSpy.mockClear();

    // Both reasons inside ONE window: capacity shedding while a batch is
    // refused. A single coalesced row would stamp all 8 with whichever reason
    // happened to fire the report.
    buffer.push("shed-1");
    buffer.push("shed-2");
    buffer.recordRejected(6, 400);

    vi.setSystemTime(new Date(Date.now() + DROP_REPORT_INTERVAL_MS + 1));
    buffer.reportFinal();

    const rows = parseDropReports<DropReport>(errorSpy);
    expect(findReport(rows, TelemetryDropReason.QueueFull).count).toBe(2);
    expect(
      findReport(rows, TelemetryDropReason.IntakeRejected, 400).count
    ).toBe(6);
    // A capacity shed has no HTTP status; inventing one would be a lie.
    expect(
      findReport(rows, TelemetryDropReason.QueueFull).httpStatus
    ).toBeUndefined();
  });

  it("gives each rejection status its own row when a window mixes them", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const errorSpy = silenceConsole();
    const buffer = new BoundedLogBuffer<string>(1);
    // The second push overflows; that first drop reports and opens the window.
    buffer.push("a");
    buffer.push("b");
    errorSpy.mockClear();

    buffer.recordRejected(4, 400);
    buffer.recordRejected(1, 422);
    vi.setSystemTime(new Date(Date.now() + DROP_REPORT_INTERVAL_MS + 1));
    buffer.reportFinal();

    // One status standing in for several would misreport why entries were lost,
    // and a single row listing both statuses could not say how many belonged to
    // each. Grouping the pending tally by status is what makes 4-vs-1 sayable.
    const rows = parseDropReports<DropReport>(errorSpy);
    expect(rows).toHaveLength(2);
    expect(
      findReport(rows, TelemetryDropReason.IntakeRejected, 400).count
    ).toBe(4);
    expect(
      findReport(rows, TelemetryDropReason.IntakeRejected, 422).count
    ).toBe(1);
  });

  it("coalesces reports without losing a single count", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // the report sink; the counter is the contract, this is the throttle
    });
    const buffer = new BoundedLogBuffer<string>(1);

    for (let index = 0; index < 50; index++) {
      buffer.push(`entry-${index}`);
    }
    const reportsInWindow = errorSpy.mock.calls.length;

    vi.setSystemTime(new Date(Date.now() + DROP_REPORT_INTERVAL_MS + 1));
    buffer.push("after-the-window");

    // A full buffer sheds once per arriving entry, so the report is throttled —
    // but the tally is not, which is why a coalesced window loses no count.
    expect(reportsInWindow).toBe(1);
    expect(errorSpy.mock.calls.length).toBe(2);
    expect(buffer.stats().cumulativeDropped).toBe(50);
  });
});

/**
 * Two ceilings 100x apart. The ring's per-arrival cost must be identical at
 * both; an implementation that relocates the buffer's contents cannot be.
 */
const SMALL_CEILING = 10;
const LARGE_CEILING = 1000;

/** The same 100x spread, but both clearing a 100-entry returned batch. */
const SMALL_RETURN_CEILING = 200;
const LARGE_RETURN_CEILING = 20_000;

function filledBuffer(capacity: number): BoundedLogBuffer<string> {
  const buffer = new BoundedLogBuffer<string>(capacity);
  for (let index = 0; index < capacity; index++) {
    buffer.push(`seed-${index}`);
  }
  return buffer;
}
