/**
 * @file bounded-import-session.test.ts
 * @description ISS-4410 unit coverage for the extracted `importSessionBounded`
 * helper (`src/main/collectors/engine/bounded-import-session.ts`). The engine
 * integration test (`ingest-import-session-timeout.test.ts`) proves the loop
 * advances end-to-end; these tests pin the helper's own contract in isolation:
 * a settled write passes its result straight through, a wedged write resolves to
 * a synthetic `failed` after the bound, a genuine rejection (async OR a
 * synchronous throw) is PROPAGATED unchanged (wongk review — only the timeout is
 * special-cased so real DB-host failures keep the pre-ISS-4410 abort behavior),
 * and a late resolve/reject after either terminal path is ignored (no
 * double-settle, timer cleared). Time is pinned with fake timers — no wall-clock
 * waits.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { importSessionBounded } from "../src/main/collectors/engine/bounded-import-session.js";
import type {
  Importer,
  ImportResult,
} from "../src/main/dashboard/agent-dashboard-db-types.js";
import { WriteQueueCancelOutcome } from "../src/main/database/write-queue.js";
import { deferred } from "./deferred.js";
import { makeSession } from "./normalized-session-test-utils.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

const TIMEOUT_MS = 1000;
const HARNESS = "claude";
const SOURCE = "/tmp/source.jsonl";
const EXCEEDED_LOG_PATTERN = /exceeded 1000ms/;
const DB_LOCKED_PATTERN = /db locked/;
const SYNC_DB_FAILURE_PATTERN = /sync db failure/;

function importerFrom(importSession: Importer["importSession"]): Importer {
  return { importSession };
}

function importerWithCancel(
  importSession: Importer["importSession"],
  cancelInFlightWrite: NonNullable<Importer["cancelInFlightWrite"]>
): Importer {
  return { importSession, cancelInFlightWrite };
}

beforeEach(() => {
  nodeTestTimers.enable(["setTimeout"]);
});

afterEach(() => {
  nodeTestTimers.reset();
});

test("ISS-4410: passes a settled importSession result straight through", async () => {
  const session = makeSession({ sessionId: "s1" });
  const expected: ImportResult = { skipped: true, reactivated: false };
  const logs: string[] = [];
  const result = await importSessionBounded(
    importerFrom(() => expected),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );
  assert.deepEqual(result, expected);
  assert.equal(logs.length, 0, "a clean import logs nothing");
});

test("ISS-4410: a wedged write resolves to a synthetic failed result after the bound", async () => {
  const session = makeSession({ sessionId: "wedged" });
  const wedged = deferred<ImportResult>();
  const logs: string[] = [];
  const pending = importSessionBounded(
    importerFrom(() => wedged.promise),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );
  // Advance past the bound; the write never resolves, so the ONLY settle path
  // is the timeout.
  nodeTestTimers.tick(TIMEOUT_MS);
  const result = await pending;
  assert.deepEqual(result, {
    skipped: false,
    reactivated: false,
    failed: true,
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], EXCEEDED_LOG_PATTERN);
  // A late resolve after the bound must be ignored (no throw, no second settle).
  wedged.resolve({ skipped: false, reactivated: false });
  assert.deepEqual(await pending, {
    skipped: false,
    reactivated: false,
    failed: true,
  });
});

test("ISS-4572: a wedged write is EVICTED on timeout (cancelInFlightWrite fires once)", async () => {
  const session = makeSession({ sessionId: "wedged-evict" });
  const wedged = deferred<ImportResult>();
  const logs: string[] = [];
  const evictions: Array<{ sessionId: string; reason: Error | undefined }> = [];
  const pending = importSessionBounded(
    importerWithCancel(
      () => wedged.promise,
      (sessionId, reason) => {
        evictions.push({ sessionId, reason });
        return WriteQueueCancelOutcome.Running;
      }
    ),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );
  // The write never settles; the ONLY settle path is the timeout, which must
  // actively evict the wedged write so later sources proceed.
  nodeTestTimers.tick(TIMEOUT_MS);
  const result = await pending;
  assert.deepEqual(result, {
    skipped: false,
    reactivated: false,
    failed: true,
  });
  assert.equal(
    evictions.length,
    1,
    "the wedged write was evicted exactly once"
  );
  // ISS-4572: eviction is TASK-SCOPED — the timed-out session's OWN id is passed
  // so the queue evicts that session's task, never an unrelated head.
  assert.equal(
    evictions[0]?.sessionId,
    "wedged-evict",
    "eviction targets the timed-out session by id"
  );
  assert.ok(
    evictions[0]?.reason instanceof Error,
    "eviction carries an explanatory reason"
  );
  // A late resolve of the (abandoned) wedged write must not re-settle or re-evict.
  wedged.resolve({ skipped: false, reactivated: false });
  await pending;
  assert.equal(evictions.length, 1, "no second eviction on the late settle");
});

test("ISS-4572: a write that settles within the bound is NOT evicted", async () => {
  const session = makeSession({ sessionId: "fast-no-evict" });
  const settled = deferred<ImportResult>();
  let evictions = 0;
  const pending = importSessionBounded(
    importerWithCancel(
      () => settled.promise,
      () => {
        evictions += 1;
        return WriteQueueCancelOutcome.Running;
      }
    ),
    () => {},
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );
  settled.resolve({ skipped: false, reactivated: true });
  await pending;
  // Advancing past the bound after a clean settle must NOT evict.
  nodeTestTimers.tick(TIMEOUT_MS * 2);
  assert.equal(evictions, 0, "a clean write is never evicted");
});

test("ISS-4572 (stage review): a PROXY eviction that rejects async is swallowed, not surfaced as an unhandled rejection", async () => {
  // In DB-host mode (FEA-2038) the importer is the createDbHostAgentDatabase
  // PROXY, so `cancelInFlightWrite` returns a Promise (an IPC invoke to the
  // child) rather than a boolean — and the write usually wedged BECAUSE the DB
  // host is unhealthy, so that invoke can be issued to a dying child and REJECT.
  // The bound must swallow that rejection (attach a `.catch`) so it never becomes
  // an unhandled rejection in the Electron main process, while the timeout
  // outcome still resolves to the synthetic `failed`.
  const session = makeSession({ sessionId: "proxy-evict-reject" });
  const wedged = deferred<ImportResult>();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const pending = importSessionBounded(
      importerWithCancel(
        () => wedged.promise,
        // Model the proxy: return a REJECTED promise (dying DB host).
        () => Promise.reject(new Error("db host invoke failed (exit code 5)"))
      ),
      () => {},
      session,
      HARNESS,
      SOURCE,
      TIMEOUT_MS
    );
    nodeTestTimers.tick(TIMEOUT_MS);
    const result = await pending;
    assert.deepEqual(result, {
      skipped: false,
      reactivated: false,
      failed: true,
    });
    // Give any un-swallowed rejection a full macrotask turn to surface.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      unhandled.length,
      0,
      "the async proxy-eviction rejection was swallowed, not surfaced"
    );
    wedged.resolve({ skipped: false, reactivated: false });
    await pending;
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("ISS-4410 (wongk review): a genuine async rejection is propagated, not mapped to failed", async () => {
  const session = makeSession({ sessionId: "boom" });
  const logs: string[] = [];
  // A real DB-host transport/lifecycle rejection must propagate so the caller
  // aborts the pass (pre-ISS-4410 behavior), NOT resolve to a per-source-retry
  // `failed`. The bound's timer is cleared so it cannot later log a timeout.
  await assert.rejects(
    () =>
      importSessionBounded(
        importerFrom(() => Promise.reject(new Error("db locked"))),
        (m) => logs.push(m),
        session,
        HARNESS,
        SOURCE,
        TIMEOUT_MS
      ),
    DB_LOCKED_PATTERN
  );
  nodeTestTimers.tick(TIMEOUT_MS * 2);
  assert.equal(logs.length, 0, "a propagated rejection logs no timeout");
});

test("ISS-4410 (wongk review): a synchronous importer throw is propagated and clears the timer", async () => {
  const session = makeSession({ sessionId: "sync-boom" });
  const logs: string[] = [];
  // A synchronous throw happens before the returned promise exists; it must
  // route through the same reject/cleanup path as an async rejection so the
  // timer is cleared and can never later log a bogus timeout.
  await assert.rejects(
    () =>
      importSessionBounded(
        importerFrom(() => {
          throw new Error("sync db failure");
        }),
        (m) => logs.push(m),
        session,
        HARNESS,
        SOURCE,
        TIMEOUT_MS
      ),
    SYNC_DB_FAILURE_PATTERN
  );
  nodeTestTimers.tick(TIMEOUT_MS * 2);
  assert.equal(logs.length, 0, "a propagated sync throw logs no timeout");
});

test("ISS-4410: a resolve within the bound wins over the timer (timer does not also fire)", async () => {
  const session = makeSession({ sessionId: "fast" });
  const settled = deferred<ImportResult>();
  const logs: string[] = [];
  const pending = importSessionBounded(
    importerFrom(() => settled.promise),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );
  settled.resolve({ skipped: false, reactivated: true });
  const result = await pending;
  assert.deepEqual(result, { skipped: false, reactivated: true });
  // Advancing past the bound after a clean settle must NOT emit the timeout log
  // (the timer was cleared).
  nodeTestTimers.tick(TIMEOUT_MS * 2);
  assert.equal(logs.length, 0, "cleared timer never logs a timeout");
});
