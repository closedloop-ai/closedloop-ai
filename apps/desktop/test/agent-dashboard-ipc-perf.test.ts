import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  instrumentIpcPerf,
  ipcErrorTypeName,
  ipcSessionCount,
  measureIpcResult,
} from "../src/main/agent-dashboard-ipc-perf.js";
import {
  DesktopIpcOperation,
  type DesktopIpcPerfEventInput,
} from "../src/main/app-otel-runtime.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";

// `instrumentIpcPerf` reads two `performance.now()` samples (start, end) to
// compute the handler duration; stub them so the head-sampler's slow/fast
// branches are deterministic without real waiting.
const realPerformanceNow = performance.now.bind(performance);
const BOOM_PATTERN = /boom/;
const HANDLER_BOOM_PATTERN = /handler boom/;
const DB_LOCKED_PATTERN = /db locked/;

afterEach(() => {
  performance.now = realPerformanceNow;
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

test("defaults session_count to 0 and reports a failed COUNT", async () => {
  stubPerfNow([0, 9000]); // slow → always emits
  const { db } = fakeDatabase(() => Promise.reject(new Error("db locked")));
  const { emit, events } = collectingEmit();
  const countErrors: unknown[] = [];

  await instrumentIpcPerf(DesktopIpcOperation.List, emit, () => [], {
    random: () => 0.99,
    onSessionCountError: (error) => countErrors.push(error),
  })(db);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.sessionCount, 0);
  // The silent zero is now observable (FEA-2211): the failure is surfaced.
  assert.equal(countErrors.length, 1);
  assert.match((countErrors[0] as Error).message, DB_LOCKED_PATTERN);
});

test("ipcSessionCount swallows a throwing onError (best-effort, never escapes)", async () => {
  const { db } = fakeDatabase(() => Promise.reject(new Error("db locked")));
  // A throwing observability sink must not turn the best-effort COUNT into a
  // throw that breaks the IPC handler (mirrors safeEmit).
  const result = await ipcSessionCount(db, () => {
    throw new Error("logger boom");
  });
  assert.equal(result, 0);
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
