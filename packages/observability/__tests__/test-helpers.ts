import { onTestFinished, vi } from "vitest";
import {
  TELEMETRY_DROPPED_CATEGORY,
  TELEMETRY_UNDELIVERED_CATEGORY,
  type TelemetryDropReason,
  type TelemetryFlushFailure,
} from "../log-buffer";

const TEST_API_KEY = "dd-api-key-value";

// Generic module-with-fetch importer: stub fetch, reset the module graph, then
// dynamically import the caller-supplied module. Used by importLogWithFetch
// below and directly by tests that need to re-import sibling modules (e.g.
// `../telemetry/emitter`) under the same fresh-module guarantee.
export function importModuleWithFetch<T>(
  fetchMock: ReturnType<typeof vi.fn>,
  importFn: () => Promise<T>
): Promise<T> {
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  return importFn();
}

export async function importLogWithFetch(fetchMock: ReturnType<typeof vi.fn>) {
  const mod = await importModuleWithFetch(fetchMock, () => import("../log"));
  return mod.log;
}

export function parseFlushedBody<T>(
  fetchMock: ReturnType<typeof vi.fn>,
  callIndex = 0
): T[] {
  // Bounds check produces a clear assertion failure instead of an opaque
  // TypeError ("Cannot read properties of undefined") when the expected
  // flush did not produce a fetch call.
  const callCount = fetchMock.mock.calls.length;
  if (callIndex >= callCount) {
    throw new Error(
      `parseFlushedBody: no call at index ${callIndex} — fetchMock was called ${callCount} time(s)`
    );
  }
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body as string) as T[];
}

/**
 * Open the agentless sink with a small, explicit buffer ceiling so a test can
 * fill and drain it cheaply.
 *
 * RELEASE_VERSION and VERCEL_GIT_COMMIT_SHA are not incidental: without them the
 * module-load fallback warnings enqueue two entries of their own and every
 * count in the calling test is off by two.
 */
export function stubDatadogEnv(maxBufferEntries: number): void {
  vi.stubEnv("DD_API_KEY", TEST_API_KEY);
  vi.stubEnv("DD_SITE", "datadoghq.com");
  vi.stubEnv("DD_ENV", "test");
  vi.stubEnv("RELEASE_VERSION", "1.0.0");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
  vi.stubEnv("DD_LOG_BUFFER_MAX_ENTRIES", String(maxBufferEntries));
}

/**
 * Silence the two console sinks a flushing test writes to, and hand back the
 * `console.error` spy — drop reports land there, so a test that asserts on the
 * report needs the same spy that suppresses the noise.
 */
export function silenceConsole(): ReturnType<typeof vi.spyOn> {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
    // drop reports are asserted through this spy, not printed
  });
  vi.spyOn(console, "info").mockImplementation(() => {
    // the local-dev console line is not under test
  });
  return errorSpy;
}

/**
 * Advance far enough to clear a full retry budget's backoffs (200ms + 400ms),
 * and DELIBERATELY not far enough to reach the module's 5s flush interval —
 * firing that would start an unrelated drain and add intake requests and drop
 * reports that these suites count exactly.
 */
const BACKOFF_ADVANCE_MS = 1000;

/**
 * Put the log module's clocks under test control, and keep them there.
 *
 * This is a correctness requirement, not a speed optimisation. `startFlushTimer()`
 * arms an unref'd 5s `setInterval`, and `vi.resetModules()` orphans the module
 * instance WITHOUT stopping it — so on the real clock every previously imported
 * instance stays armed, and any of them holding a non-empty buffer will later
 * fire into whichever test happens to be running, calling that test's `fetch`
 * mock and writing to its `console.error` spy. That is a genuine cross-test
 * flake: it made "reports the at-risk entry count" fail 5 times in 20 runs by
 * contributing a SECOND `telemetry.undelivered` report from an instance the
 * test had never heard of.
 *
 * Under fake timers the interval is registered on the fake clock, which
 * `vi.useRealTimers()` discards in teardown — so an orphaned instance can never
 * fire again. Every test in a suite that leaves entries buffered must use this.
 */
export function useDeterministicTimers(
  isoTime = "2026-08-21T00:00:00.000Z"
): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(isoTime));
}

/**
 * Drive `log.flush()` to completion across the retry backoffs under fake timers.
 *
 * The flush is started but not awaited first: its `delay()` calls schedule on
 * the fake clock, so nothing settles until the clock is advanced.
 */
export async function flushWithBackoff(log: {
  flush: () => Promise<void>;
}): Promise<void> {
  const flushed = log.flush();
  await vi.advanceTimersByTimeAsync(BACKOFF_ADVANCE_MS);
  await flushed;
}

/**
 * Detach `beforeExit` listeners left by previously imported module instances,
 * restoring them when the test finishes.
 *
 * Every import of `log.ts` registers one, and `vi.resetModules()` orphans the
 * instance without removing it — which is what the `MaxListenersExceededWarning`
 * in this suite's output is actually reporting. A test that drives shutdown by
 * emitting `beforeExit` fires ALL of them, so any orphan still holding buffered
 * entries flushes into the current test's `fetch` mock and inflates the exact
 * request counts such a test asserts. Only the instance under test should
 * answer the event.
 */
export function isolateExitListeners(): void {
  const inherited = process.listeners("beforeExit");
  process.removeAllListeners("beforeExit");
  onTestFinished(() => {
    process.removeAllListeners("beforeExit");
    for (const listener of inherited) {
      process.on("beforeExit", listener);
    }
  });
}

/** The `telemetryDropped` payload as the platform drain receives it. */
export type DropReport = {
  reason: TelemetryDropReason;
  count: number;
  cause?: TelemetryFlushFailure;
  httpStatus?: number;
  cumulativeDropped: number;
  cumulativeByReason: Record<TelemetryDropReason, number>;
  /** Live buffer gauge at report time — NOT a running total. */
  bufferLength: number;
  maxBufferEntries: number;
};

/**
 * The first report matching `reason` AND `httpStatus`, or a throw carrying the
 * number of reports that were there instead.
 *
 * `httpStatus` is matched by strict equality, so omitting it is NOT a wildcard:
 * it selects the reports that carry no status, which is what a capacity shed
 * emits. Pass the status to reach an intake rejection.
 *
 * Rows are grouped per (reason, httpStatus, cause), so a pair is unique only
 * while one cause produced it; a window mixing causes leaves the earlier row
 * for the same pair reachable and the later one not.
 *
 * Throwing rather than returning undefined keeps a missing report a failure at
 * the lookup instead of an opaque TypeError one line later in the caller's
 * property read.
 */
export function findReport(
  reports: readonly DropReport[],
  reason: TelemetryDropReason,
  httpStatus?: number
): DropReport {
  const match = reports.find(
    (report) => report.reason === reason && report.httpStatus === httpStatus
  );
  if (!match) {
    throw new Error(
      `no ${reason} report with httpStatus ${httpStatus} among ${reports.length}`
    );
  }
  return match;
}

/** The `telemetryDropped` payloads a console.error spy captured, in order. */
export function parseDropReports<T>(
  errorSpy: ReturnType<typeof vi.spyOn>
): T[] {
  return parseReports<T>(
    errorSpy,
    TELEMETRY_DROPPED_CATEGORY,
    "telemetryDropped"
  );
}

/** The `telemetryUndelivered` payloads a console.error spy captured, in order. */
export function parseUndeliveredReports<T>(
  errorSpy: ReturnType<typeof vi.spyOn>
): T[] {
  return parseReports<T>(
    errorSpy,
    TELEMETRY_UNDELIVERED_CATEGORY,
    "telemetryUndelivered"
  );
}

function parseReports<T>(
  errorSpy: ReturnType<typeof vi.spyOn>,
  category: string,
  field: string
): T[] {
  const reports: T[] = [];
  for (const [line] of errorSpy.mock.calls) {
    if (
      typeof line !== "string" ||
      !line.includes(`"category":"${category}"`)
    ) {
      continue;
    }
    reports.push((JSON.parse(line) as Record<string, T>)[field]);
  }
  return reports;
}

// Delete an env var for the current test and register a restore callback so
// the parent environment's value is reinstated when the test finishes —
// even on failure. vi.unstubAllEnvs() does NOT restore keys mutated by
// Reflect.deleteProperty, so a bare delete would leak into sibling tests in
// the same worker whenever the runner starts with the key defined.
export function deleteEnvForTest(...keys: readonly string[]): void {
  const originals: [string, string | undefined][] = keys.map((key) => [
    key,
    process.env[key],
  ]);
  for (const key of keys) {
    Reflect.deleteProperty(process.env, key);
  }
  onTestFinished(() => {
    for (const [key, value] of originals) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });
}
