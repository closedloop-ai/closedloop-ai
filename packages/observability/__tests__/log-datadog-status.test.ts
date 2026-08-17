import { afterEach, describe, expect, it, vi } from "vitest";
import { type DatadogLogEntry, LogLevel } from "../log";
import {
  deleteEnvForTest,
  importLogWithFetch,
  importModuleWithFetch,
  parseFlushedBody,
} from "./test-helpers";

// ---------------------------------------------------------------------------
// log.ts — Datadog's reserved `status` attribute (ISS-6341).
//
// Datadog resolves a log's severity from the first of `status`, `severity`,
// `level`, `syslog.severity` the payload carries. The logger only emitted
// `level`, so any call site passing its own `status` (an HTTP code, a domain
// status) decided the severity instead of the log call: `log.error("…",
// { status: 403 })` was indexed as info, and an error-rate monitor over those
// lines could not be built.
//
// Both sinks must carry `status` AND `level` with the same severity, for every
// level: the agentless HTTP intake payload (buildEntry) and the structured
// console line the platform drain parses (writeConsole). A caller's own
// `status` must survive under `callerStatus` rather than be dropped.
// ---------------------------------------------------------------------------

const LEVELS = Object.values(LogLevel);

type Emitted = DatadogLogEntry & { callerStatus?: unknown };

// The module emits its own `telemetry.*_fallback` warnings at load time, so the
// buffer's first entry is not necessarily the one under test.
function entryFor(entries: readonly Emitted[], message: string): Emitted {
  const match = entries.find((entry) => entry.message === message);
  if (!match) {
    throw new Error(
      `no flushed entry with message "${message}" — got ${entries.map((entry) => entry.message).join(", ")}`
    );
  }
  return match;
}

/** Drive the agentless intake sink and return the entry for `message`. */
async function emitToIntake(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>
): Promise<Emitted> {
  vi.stubEnv("DD_API_KEY", "test-key");
  vi.spyOn(console, level).mockImplementation(() => {
    // silence the console sink; these cases assert the intake payload
  });

  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const log = await importLogWithFetch(fetchMock);

  log[level](message, ...(meta ? [meta] : []));
  await log.flush();

  return entryFor(parseFlushedBody<Emitted>(fetchMock), message);
}

/** Drive the structured console sink and return the single parsed JSON line. */
async function emitToConsole(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>
): Promise<Emitted> {
  vi.stubEnv("DD_LOGS_JSON", "1");
  // No DD_API_KEY → the intake path stays closed; only the console line is written.
  deleteEnvForTest("DD_API_KEY");
  const spy = vi.spyOn(console, level).mockImplementation(() => {
    // capture only; the platform drain sees this line and nothing else
  });

  const fetchMock = vi.fn();
  const { log } = await importModuleWithFetch(
    fetchMock,
    () => import("../log")
  );
  spy.mockClear();

  log[level](message, ...(meta ? [meta] : []));

  // A single string arg is what makes the drain JSON-parse the line into
  // attributes; anything else means the sink under test did not run.
  if (spy.mock.calls.length !== 1) {
    throw new Error(
      `expected exactly one console.${level} call, got ${spy.mock.calls.length}`
    );
  }
  const [line, ...rest] = spy.mock.calls[0];
  if (typeof line !== "string" || rest.length > 0) {
    throw new Error(
      `expected one JSON string arg, got ${spy.mock.calls[0].length} arg(s) starting with ${typeof line}`
    );
  }
  return JSON.parse(line) as Emitted;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe.each([
  ["agentless intake payload", emitToIntake],
  ["structured console line", emitToConsole],
])("%s carries status alongside level", (_sink, emit) => {
  it.each(
    LEVELS
  )("log.%s emits status and level as the same severity", async (level) => {
    const entry = await emit(level, "severity probe");

    expect(entry.level).toBe(level);
    expect(entry.status).toBe(level);
  });

  it("keeps the emitted severity authoritative over a caller's meta status", async () => {
    // The shape 45 production call sites use: an HTTP status code in meta,
    // colliding with Datadog's reserved severity attribute.
    const entry = await emit(LogLevel.Error, "Unable to fetch user", {
      status: 404,
    });

    expect(entry.status).toBe(LogLevel.Error);
    expect(entry.level).toBe(LogLevel.Error);
  });

  it("relocates the caller's status to callerStatus instead of dropping it", async () => {
    const entry = await emit(
      LogLevel.Warn,
      "Loop has unrecognized status value",
      {
        status: "owner_failure",
        loopId: "loop_1",
      }
    );

    expect(entry.callerStatus).toBe("owner_failure");
    expect(entry.status).toBe(LogLevel.Warn);
    expect(entry.loopId).toBe("loop_1");
  });

  it("leaves callerStatus off an entry whose meta had no status", async () => {
    const entry = await emit(LogLevel.Error, "Engineer relay request failed", {
      computeTargetId: "ct_1",
    });

    expect(entry).not.toHaveProperty("callerStatus");
    expect(entry.computeTargetId).toBe("ct_1");
  });
});
