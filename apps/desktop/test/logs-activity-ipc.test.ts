/**
 * ISS-5300 (PRD-618): logs-activity-ipc.ts had no prior test coverage.
 *
 * Per apps/desktop/src/main/ipc/desktop-ipc-registration.ts:232-234:
 *   "Two registrars are deliberately ungated and read no renderer input:
 *   `registerLogsActivityIpcHandlers` (local log/activity reads) …"
 *
 * All six channels are invoked with UNTRUSTED_EVENT to assert that posture
 * directly: if a gate were introduced, each invocation would throw rather
 * than returning data, making these assertions falsifiable at the gate level.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vi } from "vitest";
import type { ActivityLogStore } from "../src/main/diagnostics/activity-log-store.js";
import {
  LogsActivityIpcChannel,
  registerLogsActivityIpcHandlers,
} from "../src/main/ipc/logs-activity-ipc.js";
import type { LogEntry } from "../src/main/logging/gateway-logger.js";
import type { ActivityEvent } from "../src/shared/activity-panel-contract.js";
import {
  createIpcRegistrar,
  UNTRUSTED_EVENT,
} from "./helpers/ipc-registrar.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_LOG_ENTRY: LogEntry = {
  timestamp: "2024-06-01T00:00:00.000Z",
  level: "info",
  tag: "gateway",
  message: "test log entry",
};

const SAMPLE_ACTIVITY_EVENT: ActivityEvent = {
  id: "evt-001",
  timestamp: "2024-06-01T00:00:00.000Z",
  method: "GET",
  path: "/health",
  statusCode: 200,
  durationMs: 5,
};

// ---------------------------------------------------------------------------
// ActivityLog double — mutable state in a closure mirrors the real store's
// clear-then-list contract without requiring electron-store on disk.
// ---------------------------------------------------------------------------

function makeActivityLogDouble(initial: ActivityEvent[] = []) {
  let events: ActivityEvent[] = [...initial];
  return {
    list: vi.fn((): ActivityEvent[] => [...events]),
    clear: vi.fn((): void => {
      events = [];
    }),
    add(
      _event: Omit<ActivityEvent, "id"> & {
        requestBody?: unknown;
        responseBody?: unknown;
      }
    ): ActivityEvent {
      throw new Error(
        "ActivityLogStore.add() is not invoked by any handler under test"
      );
    },
  };
}

function makeRegistration(
  opts: {
    logEntries?: LogEntry[];
    logFilePath?: string;
    initialActivityEvents?: ActivityEvent[];
  } = {}
) {
  const logEntries = opts.logEntries ?? [];
  const activityLog = makeActivityLogDouble(opts.initialActivityEvents ?? []);

  const getLogEntries = vi.fn((): LogEntry[] => logEntries);
  const clearLogs = vi.fn((): void => undefined);
  const getLogFilePath = vi.fn(
    (): string => opts.logFilePath ?? "/var/log/app.log"
  );
  const openLogFile = vi.fn((): void => undefined);

  const harness = createIpcRegistrar();
  registerLogsActivityIpcHandlers(harness.registrar, {
    getLogEntries,
    clearLogs,
    getLogFilePath,
    openLogFile,
    // `ActivityLogStore` is a class with private members (`maxEntries`,
    // `events`, `store`, `persist`), so TypeScript requires nominal identity
    // and a structural double cannot be assigned directly. AGENTS.md sanctions
    // the double cast on impractical-to-build test shapes; the sibling suites
    // (managed-key-hint, cost-reconciliation, command-signing-keys) do the same.
    activityLog: activityLog as unknown as ActivityLogStore,
  });

  return {
    harness,
    getLogEntries,
    clearLogs,
    getLogFilePath,
    openLogFile,
    activityLog,
  };
}

// ---------------------------------------------------------------------------
// Channel registration
// ---------------------------------------------------------------------------

describe("logs-activity IPC registration", () => {
  test("registers exactly the channels declared in LogsActivityIpcChannel", () => {
    const { harness } = makeRegistration();
    assert.deepEqual(
      [...harness.channels()].sort(),
      Object.values(LogsActivityIpcChannel).sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Per-channel behaviour
//
// All six channels are invoked with UNTRUSTED_EVENT to assert the
// "deliberately ungated" posture cited in desktop-ipc-registration.ts:232-234.
// A gate being added to any channel would flip its test from a data assertion
// to a thrown "untrusted sender" error.
// ---------------------------------------------------------------------------

describe("logs-activity IPC channels: ungated behaviour", () => {
  test("GetLogs returns the current log entries", () => {
    const { harness, getLogEntries } = makeRegistration({
      logEntries: [SAMPLE_LOG_ENTRY],
    });

    const result = harness.invoke(
      LogsActivityIpcChannel.GetLogs,
      UNTRUSTED_EVENT
    ) as LogEntry[];

    assert.equal(getLogEntries.mock.calls.length, 1);
    assert.deepEqual(result, [SAMPLE_LOG_ENTRY]);
  });

  test("ClearLogs delegates to clearLogs dep and returns nothing", () => {
    const { harness, clearLogs } = makeRegistration();

    const result = harness.invoke(
      LogsActivityIpcChannel.ClearLogs,
      UNTRUSTED_EVENT
    );

    assert.equal(clearLogs.mock.calls.length, 1);
    // Handler body: `{ deps.clearLogs(); }` — no explicit return.
    assert.equal(result, undefined);
  });

  test("GetLogFilePath returns the path from its dep", () => {
    const expectedPath = "/var/log/gateway-2024.log";
    const { harness, getLogFilePath } = makeRegistration({
      logFilePath: expectedPath,
    });

    const result = harness.invoke(
      LogsActivityIpcChannel.GetLogFilePath,
      UNTRUSTED_EVENT
    );

    assert.equal(getLogFilePath.mock.calls.length, 1);
    assert.equal(result, expectedPath);
  });

  test("OpenLogFile invokes openLogFile dep and returns nothing", () => {
    const { harness, openLogFile } = makeRegistration();

    const result = harness.invoke(
      LogsActivityIpcChannel.OpenLogFile,
      UNTRUSTED_EVENT
    );

    assert.equal(openLogFile.mock.calls.length, 1);
    assert.equal(result, undefined);
  });

  test("GetActivityEvents returns the current event list", () => {
    const { harness, activityLog } = makeRegistration({
      initialActivityEvents: [SAMPLE_ACTIVITY_EVENT],
    });

    const result = harness.invoke(
      LogsActivityIpcChannel.GetActivityEvents,
      UNTRUSTED_EVENT
    ) as ActivityEvent[];

    assert.equal(activityLog.list.mock.calls.length, 1);
    assert.deepEqual(result, [SAMPLE_ACTIVITY_EVENT]);
  });

  test("ClearActivityEvents clears and returns the post-clear (empty) list", () => {
    // The activity log is seeded with one entry before the call. If the
    // handler returned the PRE-clear list, result would be [SAMPLE_ACTIVITY_EVENT],
    // failing the deepEqual below. If clear() were skipped or called AFTER
    // list(), list() would still read the seeded entry, not [].
    const { harness, activityLog } = makeRegistration({
      initialActivityEvents: [SAMPLE_ACTIVITY_EVENT],
    });

    const result = harness.invoke(
      LogsActivityIpcChannel.ClearActivityEvents,
      UNTRUSTED_EVENT
    ) as ActivityEvent[];

    assert.equal(activityLog.clear.mock.calls.length, 1);
    assert.equal(activityLog.list.mock.calls.length, 1);
    // list() was called after clear() — result must be empty.
    assert.deepEqual(result, []);
  });
});
