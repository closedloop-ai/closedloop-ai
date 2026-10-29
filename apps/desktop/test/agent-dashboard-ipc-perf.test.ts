import assert from "node:assert/strict";
import {
  IpcQueryExecution as ContractIpcQueryExecution,
  IpcQueryRefusal as ContractIpcQueryRefusal,
  IpcQuerySource as ContractIpcQuerySource,
} from "@closedloop-ai/telemetry-contract/ipc";
import { ListQueryRefusal } from "@repo/api/src/types/list-query-expression";
import {
  ListQueryExecution,
  ListQuerySource,
} from "@repo/api/src/types/list-query-observability";
import { afterEach, test } from "vitest";
import {
  instrumentIpcPerf,
  ipcErrorTypeName,
  ipcSessionCount,
  measureIpcResult,
} from "../src/main/dashboard/agent-dashboard-ipc-perf.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import { readAgentDashboardSessionList } from "../src/main/dashboard/agent-dashboard-session-list-projection.js";
import type {
  DbHostAgentDatabase,
  SqliteAgentDatabase,
} from "../src/main/database/sqlite.js";
import { SessionListQueryRefusedError } from "../src/main/session/session-list-query-compiler.js";
import {
  recordSessionListQueryObservation,
  sanitizeDbHostSessionListQueryObservation,
} from "../src/main/session/session-list-query-observability.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import { getSharedAgentSessionsPageData } from "../src/main/session/shared-agent-sessions-page-data.js";
import {
  DesktopIpcOperation,
  type DesktopIpcPerfEventInput,
} from "../src/main/telemetry/app-otel-runtime-ipc.js";
import { DB_HOST_TELEMETRY_REFUSED_CATEGORY } from "../src/main/telemetry/db-host-telemetry-refusal.js";
import { Observability } from "../src/main/telemetry/observability.js";
import {
  DbHostTelemetryRefusalReason,
  type TelemetryEventPayload,
} from "../src/main/telemetry/telemetry-protocol.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";
import {
  createFakeSource,
  cursor,
  session,
  usageAggregate,
} from "./shared-agent-sessions-test-helpers.js";

// `instrumentIpcPerf` reads two `performance.now()` samples (start, end) to
// compute the handler duration; stub them so the head-sampler's slow/fast
// branches are deterministic without real waiting.
const realPerformanceNow = performance.now.bind(performance);
const realGetTelemetryEmitter = Observability.getTelemetryEmitter;
const BOOM_PATTERN = /boom/;
const HANDLER_BOOM_PATTERN = /handler boom/;
const DB_LOCKED_PATTERN = /db locked/;

afterEach(() => {
  performance.now = realPerformanceNow;
  Observability.getTelemetryEmitter = realGetTelemetryEmitter;
});

function stubPerfNow(values: number[]): void {
  const queue = [...values];
  performance.now = () => queue.shift() ?? 0;
}

type SessionCounter = {
  db: SqliteAgentDatabase;
  calls: () => number;
};

function fakeDatabase(count: number | (() => Promise<number>)): SessionCounter {
  let calls = 0;
  const countFn = (): Promise<number> => {
    calls += 1;
    return typeof count === "function" ? count() : Promise.resolve(count);
  };
  // `ipcSessionCount` counts via the clone-safe `agentDatabase.sessions.count()`
  // method (FEA-2252), which the db host runs as a raw `COUNT(*)` on the reader
  // pool (FEA-2211). It does NOT issue a `prisma.read(callback)` from the main
  // process; a callback can't cross the FEA-2038 db-host IPC boundary
  // ("An object could not be cloned"). Model that exact call path here, with no
  // `prisma` on the fake so a regression back to `prisma.read` would fault.
  const db = {
    sessions: {
      count: (): Promise<number> => countFn(),
    },
  } as unknown as SqliteAgentDatabase;
  return { db, calls: () => calls };
}

function collectingEmit() {
  const events: DesktopIpcPerfEventInput[] = [];
  return {
    emit: (input: DesktopIpcPerfEventInput) => events.push(input),
    events,
  };
}

test("passes through unwrapped when no emit sink is provided", async () => {
  const { db, calls } = fakeDatabase(99);
  let handlerCalls = 0;
  const wrapped = instrumentIpcPerf(
    DesktopIpcOperation.List,
    undefined,
    (_db, value: number) => {
      handlerCalls += 1;
      return value * 2;
    }
  );

  assert.equal(await wrapped(db, 21), 42);
  assert.equal(handlerCalls, 1);
  // No telemetry work at all — the session COUNT is never issued.
  assert.equal(calls(), 0);
});

test("keeps the API and telemetry query vocabularies in parity", () => {
  assert.deepEqual(ContractIpcQuerySource, ListQuerySource);
  assert.deepEqual(ContractIpcQueryExecution, ListQueryExecution);
  assert.deepEqual(ContractIpcQueryRefusal, ListQueryRefusal);
});

test("always emits slow calls regardless of the baseline RNG", async () => {
  stubPerfNow([1000, 3500]); // duration = 2500ms >= 2000ms slow threshold
  const { db } = fakeDatabase(2048);
  const { emit, events } = collectingEmit();
  const wrapped = instrumentIpcPerf(
    DesktopIpcOperation.List,
    emit,
    // Real list shape: `{ items: [...] }` (NOT `{ sessions }`).
    () => ({ items: [{ id: "a" }, { id: "b" }], total: 2 }),
    { random: () => 0.99 } // 99 >= baseline 10 → dropped if it were not slow
  );

  await wrapped(db);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.operation, DesktopIpcOperation.List);
  assert.equal(events[0]?.durationMs, 2500);
  assert.equal(events[0]?.resultCount, 2);
  assert.equal(events[0]?.sessionCount, 2048);
  assert.equal(events[0]?.errorType, undefined);
});

test("adds bounded query source and fallback to the existing monitored list span", async () => {
  stubPerfNow([1000, 3500]);
  const { db } = fakeDatabase(2048);
  const { emit, events } = collectingEmit();
  const wrapped = instrumentIpcPerf(
    DesktopIpcOperation.List,
    emit,
    (_database, _request: unknown) => {
      recordSessionListQueryObservation({
        execution: ListQueryExecution.HydratedFallback,
      });
      return { items: [{ id: "a" }], total: 128 };
    },
    { random: () => 0.99 }
  );

  await wrapped(db, {
    listQuery: {
      version: 1,
      filters: [{ field: "status", values: ["private-filter-value"] }],
    },
  });

  assert.equal(events[0]?.source, ListQuerySource.Canonical);
  assert.equal(events[0]?.execution, ListQueryExecution.HydratedFallback);
  assert.ok(!JSON.stringify(events[0]).includes("private-filter-value"));
});

test.each([
  [DesktopIpcOperation.List, false],
  [DesktopIpcOperation.PageData, true],
] as const)(
  "%s reports distinct store, scanned, matched, and returned populations",
  async (operation, pageData) => {
    stubPerfNow([0, 2500]);
    const { db } = fakeDatabase(100);
    const { emit, events } = collectingEmit();
    const cursorRows = Array.from({ length: 10 }, (_, index) =>
      cursor(`${index < 5 ? "match" : "other"}-${index}`)
    );
    const sessions = Object.fromEntries(
      cursorRows.map((row) => [
        row.id,
        session({
          id: row.id,
          status: "inactive",
        }),
      ])
    );
    const source = createFakeSource({
      aggregateUsage: () => usageAggregate({ totalSessions: 10 }),
      cursorRows,
      sessions,
    });
    source.listSessionCursorPage = undefined;
    const request = {
      limit: 2,
      offset: 0,
      quality: "all" as const,
      search: "match",
      statuses: ["inactive"],
    };
    const list = () =>
      getSharedAgentSessions(source, request, {
        onQueryObservation: recordSessionListQueryObservation,
      });
    const handler = async (
      _database: DbHostAgentDatabase,
      _request: unknown
    ): Promise<unknown> =>
      pageData
        ? await getSharedAgentSessionsPageData(
            source,
            request,
            { onQueryObservation: recordSessionListQueryObservation },
            list
          )
        : await list();
    const wrapped = instrumentIpcPerf(operation, emit, handler, {
      random: () => 0.99,
    });

    await wrapped(db, request);

    assert.equal(events[0]?.operation, operation);
    assert.equal(events[0]?.sessionCount, 100);
    assert.equal(events[0]?.scannedCount, 10);
    assert.equal(events[0]?.matchedCount, 5);
    assert.equal(events[0]?.resultCount, 2);
    assert.equal(events.length, 1);
  }
);

test("carries DB-host projection populations through the real list reader", async () => {
  stubPerfNow([0, 2500]);
  const { db: counterDb } = fakeDatabase(100);
  const { emit, events } = collectingEmit();
  const request = { limit: 2, quality: "all" as const };
  const source = createFakeSource({
    cursorRows: [cursor("one"), cursor("two"), cursor("three")],
    sessions: {
      one: session({ id: "one" }),
      two: session({ id: "two" }),
      three: session({ id: "three" }),
    },
  });
  const projected = await getSharedAgentSessions(source, request);
  source.projectSessionList = () =>
    Promise.resolve({
      ...projected,
      pendingOutboxAvailable: false,
      queryExecution: ListQueryExecution.DatabasePage,
      queryMatchedCount: 7,
      queryScannedCount: 11,
    });
  const db = {
    ...counterDb,
    syncSource: source,
  } as unknown as SqliteAgentDatabase;
  const wrapped = instrumentIpcPerf(
    DesktopIpcOperation.List,
    emit,
    (_database, listRequest: typeof request) =>
      readAgentDashboardSessionList(
        db,
        {} as AgentDashboardDesignSystemRuntimeOptions,
        listRequest
      ),
    { random: () => 0.99 }
  );

  await wrapped(db, request);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.sessionCount, 100);
  assert.equal(events[0]?.scannedCount, 11);
  assert.equal(events[0]?.matchedCount, 7);
  assert.equal(events[0]?.resultCount, 2);
  assert.equal(events[0]?.execution, ListQueryExecution.DatabasePage);
});

test.each([
  ["unknown", "future_execution" as ListQueryExecution],
  ["omitted", undefined],
] as const)(
  "omits %s DB-host execution metadata without inventing a local fallback",
  async (_case, queryExecution) => {
    stubPerfNow([0, 2500]);
    const { db: counterDb } = fakeDatabase(100);
    const { emit, events } = collectingEmit();
    const request = { limit: 2, quality: "all" as const };
    const source = createFakeSource({
      cursorRows: [cursor("one"), cursor("two"), cursor("three")],
      sessions: {
        one: session({ id: "one" }),
        two: session({ id: "two" }),
        three: session({ id: "three" }),
      },
    });
    const projected = await getSharedAgentSessions(source, request);
    source.projectSessionList = () =>
      Promise.resolve({
        ...projected,
        pendingOutboxAvailable: false,
        queryExecution,
        queryMatchedCount: -1,
        queryScannedCount: 11,
      });
    const db = {
      ...counterDb,
      syncSource: source,
    } as unknown as SqliteAgentDatabase;
    const wrapped = instrumentIpcPerf(
      DesktopIpcOperation.List,
      emit,
      (_database, listRequest: typeof request) =>
        readAgentDashboardSessionList(
          db,
          {} as AgentDashboardDesignSystemRuntimeOptions,
          listRequest
        ),
      { random: () => 0.99 }
    );

    await wrapped(db, request);

    assert.equal(events.length, 1);
    assert.equal(events[0]?.execution, undefined);
    assert.equal(events[0]?.matchedCount, undefined);
    assert.equal(events[0]?.scannedCount, 11);
    assert.equal(events[0]?.resultCount, 2);
    assert.equal(events[0]?.sessionCount, 100);
  }
);

test.each([
  ["negative", -1],
  ["fractional", 1.5],
  ["non-finite", Number.POSITIVE_INFINITY],
  ["unsafe", Number.MAX_SAFE_INTEGER + 1],
] as const)(
  "reports %s DB-host counts one field at a time",
  (_case, invalid) => {
    const monitored: TelemetryEventPayload[] = [];
    Observability.getTelemetryEmitter = () => ({
      emit: (event) => monitored.push(event),
    });
    assert.deepEqual(
      sanitizeDbHostSessionListQueryObservation({
        matchedCount: invalid,
        scannedCount: 9,
      }),
      { scannedCount: 9 }
    );
    assert.deepEqual(
      sanitizeDbHostSessionListQueryObservation({
        matchedCount: 7,
        scannedCount: invalid,
      }),
      { matchedCount: 7 }
    );
    assert.deepEqual(
      monitored.map((event) => ({
        category: event.category,
        diagnostics: event.diagnostics,
        severity: event.severity,
      })),
      [
        {
          category: DB_HOST_TELEMETRY_REFUSED_CATEGORY,
          diagnostics: {
            dbHostTelemetryRefused: {
              reason: DbHostTelemetryRefusalReason.UnknownShape,
            },
          },
          severity: "error",
        },
        {
          category: DB_HOST_TELEMETRY_REFUSED_CATEGORY,
          diagnostics: {
            dbHostTelemetryRefused: {
              reason: DbHostTelemetryRefusalReason.UnknownShape,
            },
          },
          severity: "error",
        },
      ]
    );
  }
);

test("retains count execution when the count read fails", async () => {
  stubPerfNow([0, 7]);
  const { db } = fakeDatabase(100);
  const { emit, events } = collectingEmit();
  const source = createFakeSource({
    countSessions: () => {
      throw new Error("count failed");
    },
  });

  await assert.rejects(
    instrumentIpcPerf(
      DesktopIpcOperation.List,
      emit,
      (_database, _request: unknown) =>
        getSharedAgentSessions(
          source,
          { completedAfter: "2026-01-01T00:00:00.000Z", countOnly: true },
          { onQueryObservation: recordSessionListQueryObservation }
        )
    )(db, { countOnly: true })
  );

  assert.equal(events[0]?.execution, ListQueryExecution.Count);
  assert.equal(events[0]?.errorType, "Error");
});

test("does not invent DB-host execution when the projection fails", async () => {
  stubPerfNow([0, 7]);
  const { db: counterDb } = fakeDatabase(100);
  const { emit, events } = collectingEmit();
  const source = createFakeSource({ cursorRows: [cursor("session-1")] });
  source.projectSessionList = () => {
    throw new Error("db-host cursor failed");
  };
  const db = {
    ...counterDb,
    syncSource: source,
  } as unknown as SqliteAgentDatabase;

  await assert.rejects(
    instrumentIpcPerf(
      DesktopIpcOperation.List,
      emit,
      (_database, request: unknown) =>
        readAgentDashboardSessionList(
          db,
          {} as AgentDashboardDesignSystemRuntimeOptions,
          request as { limit?: number }
        )
    )(db, { limit: 1 })
  );

  assert.equal(events[0]?.execution, undefined);
  assert.equal(events[0]?.errorType, "Error");
});

test("keeps the historical error type and records refusal separately", async () => {
  stubPerfNow([0, 7]);
  const { db } = fakeDatabase(5);
  const { emit, events } = collectingEmit();
  const wrapped = instrumentIpcPerf(
    DesktopIpcOperation.List,
    emit,
    (_database, _request: unknown) => {
      throw new SessionListQueryRefusedError({
        code: ListQueryRefusal.UnsupportedVersion,
        details: {},
      });
    }
  );

  await assert.rejects(wrapped(db, { listQuery: { version: 99 } }));

  assert.equal(events[0]?.source, ListQuerySource.Canonical);
  assert.equal(events[0]?.execution, ListQueryExecution.Refused);
  assert.equal(events[0]?.errorType, "SessionListQueryRefusedError");
  assert.equal(events[0]?.refusal, ListQueryRefusal.UnsupportedVersion);
});

test("does not let success observations override measured results or leak refusals", async () => {
  stubPerfNow([0, 2500]);
  const { db } = fakeDatabase(5);
  const { emit, events } = collectingEmit();

  await instrumentIpcPerf(
    DesktopIpcOperation.List,
    emit,
    (_database, _request: unknown) => {
      recordSessionListQueryObservation({
        resultCount: 999,
        refusal: ListQueryRefusal.Malformed,
      });
      return { items: [{ id: "measured" }] };
    },
    { random: () => 0.99 }
  )(db, {});

  assert.equal(events[0]?.resultCount, 1);
  assert.equal(events[0]?.refusal, undefined);
});

test("does not let failure observations override measured results or leak refusals", async () => {
  stubPerfNow([0, 7]);
  const { db } = fakeDatabase(5);
  const { emit, events } = collectingEmit();

  await assert.rejects(
    instrumentIpcPerf(
      DesktopIpcOperation.List,
      emit,
      (_database, _request: unknown) => {
        recordSessionListQueryObservation({
          resultCount: 999,
          refusal: ListQueryRefusal.Malformed,
        });
        throw new Error("boom");
      }
    )(db, {})
  );

  assert.equal(events[0]?.resultCount, 0);
  assert.equal(events[0]?.refusal, undefined);
  assert.equal(events[0]?.errorType, "Error");
});

test("baseline-samples fast calls by the injected RNG", async () => {
  const { db, calls } = fakeDatabase(10);
  const { emit, events } = collectingEmit();

  // Sampled in: random*100 = 5 < baseline 10.
  stubPerfNow([0, 5]);
  await instrumentIpcPerf(DesktopIpcOperation.Usage, emit, () => [1, 2, 3], {
    random: () => 0.05,
  })(db);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.operation, DesktopIpcOperation.Usage);
  assert.equal(events[0]?.resultCount, 3);

  // Sampled out: random*100 = 50 >= baseline 10 → no emit, no COUNT work.
  stubPerfNow([0, 5]);
  await instrumentIpcPerf(DesktopIpcOperation.Usage, emit, () => [1, 2, 3], {
    random: () => 0.5,
  })(db);
  assert.equal(events.length, 1);
  assert.equal(calls(), 1); // only the sampled-in call issued the COUNT
});

test("always emits and re-throws on handler error with error.type", async () => {
  stubPerfNow([0, 7]);
  const { db } = fakeDatabase(5);
  const { emit, events } = collectingEmit();
  class DesktopMigrationError extends Error {
    constructor() {
      super("boom");
      this.name = "DesktopMigrationError";
    }
  }
  const wrapped = instrumentIpcPerf(
    DesktopIpcOperation.Detail,
    emit,
    () => {
      throw new DesktopMigrationError();
    },
    { random: () => 0.99 } // errors emit regardless of the sampler
  );

  await assert.rejects(wrapped(db), BOOM_PATTERN);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.operation, DesktopIpcOperation.Detail);
  assert.equal(events[0]?.errorType, "DesktopMigrationError");
  assert.equal(events[0]?.payloadBytes, 0);
  assert.equal(events[0]?.resultCount, 0);
  assert.equal(events[0]?.sessionCount, 5);
});

test("drops the event when the COUNT failed, and still reports the failure", async () => {
  // ISS-8773 changed this expectation deliberately. The COUNT used to fall back
  // to 0, so `db-host exited (code: 1)` emitted `session_count: 0` from a query
  // that never reached SQLite — indistinguishable, at the reader, from a store
  // that genuinely holds no sessions. Unknown is now unknown, and a wide event
  // carrying a dimension nobody measured is not emitted at all.
  stubPerfNow([0, 9000]); // slow → always emits
  const { db } = fakeDatabase(() => Promise.reject(new Error("db locked")));
  const { emit, events } = collectingEmit();
  const countErrors: unknown[] = [];

  await instrumentIpcPerf(DesktopIpcOperation.List, emit, () => [], {
    random: () => 0.99,
    onSessionCountError: (error) => countErrors.push(error),
  })(db);

  assert.deepEqual(events, []);
  // Still observable (FEA-2211): dropping the metric must not drop the signal.
  assert.equal(countErrors.length, 1);
  assert.match((countErrors[0] as Error).message, DB_LOCKED_PATTERN);
});

test("keeps the errored event when the COUNT failed too, minus the count", async () => {
  // ISS-8773. The two failures are CORRELATED — a distressed db-host fails the
  // handler and the follow-up COUNT together — so gating the errored event on
  // the count succeeding drops `errorType` exactly when it is the only thing
  // worth recording. The count is omitted, never faked, never null.
  stubPerfNow([0, 9000]);
  const { db } = fakeDatabase(() => Promise.reject(new Error("db locked")));
  const { emit, events } = collectingEmit();

  await assert.rejects(
    instrumentIpcPerf(
      DesktopIpcOperation.Usage,
      emit,
      () => {
        throw new Error("handler boom");
      },
      { random: () => 0.99 }
    )(db),
    HANDLER_BOOM_PATTERN
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.errorType, "Error");
  assert.equal(events[0]?.operation, DesktopIpcOperation.Usage);
  assert.equal(
    events[0]?.sessionCount,
    undefined,
    "unknown is absent, not zero and not null"
  );
});

test("emits NOTHING for an attempt the db-host-exit re-drive will run again", async () => {
  // The `usage` channel is the first to be both instrumented and re-driven, so
  // one logical call would otherwise bill a spurious failure event plus the
  // success event from the retry. A recoverable exit is an abandoned attempt,
  // the same category ISS-5262 already carved out for shutdown.
  stubPerfNow([0, 9000]);
  const { db } = fakeDatabase(5);
  const { emit, events } = collectingEmit();

  await assert.rejects(
    instrumentIpcPerf(
      DesktopIpcOperation.Usage,
      emit,
      () => {
        throw new DbHostExitError(0, true, "db-host exited (code: 0)");
      },
      { random: () => 0.99 }
    )(db)
  );

  assert.deepEqual(events, []);
});

test("still emits for an exit NOTHING is bringing back", async () => {
  // The positive sibling: an unrecoverable exit is not re-driven, so it is a
  // completed, failed call and must keep its errorType.
  stubPerfNow([0, 9000]);
  const { db } = fakeDatabase(5);
  const { emit, events } = collectingEmit();

  await assert.rejects(
    instrumentIpcPerf(
      DesktopIpcOperation.Usage,
      emit,
      () => {
        throw new DbHostExitError(1, false, "db-host exited (code: 1)");
      },
      { random: () => 0.99 }
    )(db)
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.errorType, "DbHostExitError");
});

test("still emits a real session_count when the COUNT succeeds", async () => {
  // The sibling that makes the case above mean something: the drop is caused by
  // the FAILURE, not by instrumentation that stopped emitting.
  stubPerfNow([0, 9000]);
  const { db } = fakeDatabase(2048);
  const { emit, events } = collectingEmit();
  const countErrors: unknown[] = [];

  await instrumentIpcPerf(DesktopIpcOperation.List, emit, () => [], {
    random: () => 0.99,
    onSessionCountError: (error) => countErrors.push(error),
  })(db);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.sessionCount, 2048);
  assert.deepEqual(countErrors, []);
});

test("ipcSessionCount swallows a throwing onError (best-effort, never escapes)", async () => {
  const { db } = fakeDatabase(() => Promise.reject(new Error("db locked")));
  // A throwing observability sink must not turn the best-effort COUNT into a
  // throw that breaks the IPC handler (mirrors safeEmit).
  const result = await ipcSessionCount(db, () => {
    throw new Error("logger boom");
  });
  // ISS-8773: unknown, never a fabricated 0 — see the drop case above.
  assert.equal(result, null);
});

test("a throwing emit sink never alters handler semantics", async () => {
  const { db } = fakeDatabase(1);
  const throwingEmit = () => {
    throw new Error("emit boom");
  };

  // Happy path: the result is still returned despite the throwing sink.
  stubPerfNow([0, 9000]); // slow → always attempts to emit
  const okResult = await instrumentIpcPerf(
    DesktopIpcOperation.List,
    throwingEmit,
    () => ({ items: [1, 2] }),
    { random: () => 0.99 }
  )(db);
  assert.deepEqual(okResult, { items: [1, 2] });

  // Error path: the handler's own error is re-thrown, not the emit error.
  stubPerfNow([0, 9000]);
  await assert.rejects(
    instrumentIpcPerf(
      DesktopIpcOperation.Detail,
      throwingEmit,
      () => {
        throw new Error("handler boom");
      },
      { random: () => 0.99 }
    )(db),
    HANDLER_BOOM_PATTERN
  );
});

test("measureIpcResult derives utf-8 bytes and counts across handler shapes", () => {
  // Bare array → its own length.
  assert.deepEqual(measureIpcResult([1, 2, 3]), {
    payloadBytes: Buffer.byteLength("[1,2,3]", "utf8"),
    resultCount: 3,
  });
  // `list` envelope `{ items: [...] }` → page length.
  const listResult = { items: [{}, {}], total: 9 };
  assert.deepEqual(measureIpcResult(listResult), {
    payloadBytes: Buffer.byteLength(JSON.stringify(listResult), "utf8"),
    resultCount: 2,
  });
  // `pageData` `{ list: { items }, usage }` → its nested list page (ISS-12039).
  const pageDataResult = { list: { items: [{}, {}, {}], total: 9 }, usage: {} };
  assert.equal(measureIpcResult(pageDataResult).resultCount, 3);
  // `detail`/`usage` single record/summary → 1.
  const detailResult = { session: { id: "s1" } };
  assert.deepEqual(measureIpcResult(detailResult), {
    payloadBytes: Buffer.byteLength(JSON.stringify(detailResult), "utf8"),
    resultCount: 1,
  });
  // null / undefined → 0 rows.
  assert.deepEqual(measureIpcResult(undefined), {
    payloadBytes: 0,
    resultCount: 0,
  });
  assert.deepEqual(measureIpcResult(null), {
    payloadBytes: Buffer.byteLength("null", "utf8"),
    resultCount: 0,
  });
  // Multi-byte content is counted in UTF-8 bytes, not UTF-16 code units.
  const unicode = { items: [{ cwd: "/Ünïcödé/项目" }] };
  assert.equal(
    measureIpcResult(unicode).payloadBytes,
    Buffer.byteLength(JSON.stringify(unicode), "utf8")
  );

  // A non-serializable (circular) result yields a zeroed measure, not a throw.
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.deepEqual(measureIpcResult(circular), {
    payloadBytes: 0,
    resultCount: 0,
  });
});

test("ipcErrorTypeName falls back to Error for unnamed throwables", () => {
  assert.equal(ipcErrorTypeName(new TypeError("x")), "TypeError");
  assert.equal(ipcErrorTypeName("just a string"), "Error");
});
