/**
 * @file bounded-import-session.test.ts
 * @description ISS-4410 unit coverage for the extracted `importSessionBounded`
 * helper (`src/main/collectors/engine/bounded-import-session.ts`). The engine
 * integration test (`ingest-import-session-timeout.test.ts`) proves the loop
 * advances end-to-end; these tests pin the helper's own contract in isolation:
 * a settled write passes its result straight through, a wedged write resolves to
 * a synthetic `failed` after the bound, a genuine rejection (async OR a
 * synchronous throw) is PROPAGATED unchanged (whitlockk review — only the timeout is
 * special-cased so real DB-host failures keep the pre-ISS-4410 abort behavior),
 * and a late resolve/reject after either terminal path is ignored (no
 * double-settle, timer cleared). Time is pinned with fake timers — no wall-clock
 * waits.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import {
  IMPORT_TIMEOUT_DURABLE_SETTLE_GRACE_MS,
  importSessionBounded,
  UNDISPATCHED_REARM_REVALIDATE_MS,
} from "../src/main/collectors/engine/bounded-import-session.js";
import type {
  Importer,
  ImportResult,
} from "../src/main/dashboard/agent-dashboard-db-types.js";
import {
  type WriteDispatchProbe,
  WriteDispatchState,
  WriteQueueCancelOutcome,
} from "../src/main/database/write-queue.js";
import { deferred } from "./deferred.js";
import { makeSession } from "./normalized-session-test-utils.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

const TIMEOUT_MS = 1000;
const HARNESS = "claude";
const SOURCE = "/tmp/source.jsonl";
const EXCEEDED_LOG_PATTERN = /exceeded 1000ms/;
const UNMARKED_LOG_PATTERN = /left unmarked/;
const DB_LOCKED_PATTERN = /db locked/;
const REARM_LOG_PATTERN = /without its write dispatching/;
/**
 * A bound LONGER than one re-validation slice, so the slicing is observable.
 * At `TIMEOUT_MS` (1000ms) a slice is capped by the bound itself and the two are
 * indistinguishable; production's bound is 120s against a 5s slice.
 */
const LONG_TIMEOUT_MS = 20_000;

/** One granted re-validation slice for a given bound. */
function rearmSliceMs(timeoutMs: number): number {
  return Math.min(UNDISPATCHED_REARM_REVALIDATE_MS, timeoutMs);
}
const SYNC_DB_FAILURE_PATTERN = /sync db failure/;

function importerFrom(importSession: Importer["importSession"]): Importer {
  return { importSession };
}

/**
 * ISS-7257: expire the bound's post-deadline grace, in which a write the eviction
 * proved it did not touch may still report that it committed. `tick` deliberately
 * does not drain microtasks, so the eviction chain needs a real turn to arm that
 * timer before the clock can be advanced past it.
 */
async function expireDurableSettleGrace(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  nodeTestTimers.tick(IMPORT_TIMEOUT_DURABLE_SETTLE_GRACE_MS);
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
  // is the timeout — and (ISS-7257) it never reports a commit within the grace.
  nodeTestTimers.tick(TIMEOUT_MS);
  await expireDurableSettleGrace();
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
    // No grace is armed here: a rejected eviction is NO evidence that the write
    // was left intact (the invoke may have been executed and only its reply lost),
    // so ISS-7257 refuses to wait on a write it cannot prove it spared.
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

test("ISS-7257: a write that COMMITS as the bound trips reports its real durable result and charges no attempt", async () => {
  const session = makeSession({ sessionId: "committed-late" });
  const write = deferred<ImportResult>();
  const durable: ImportResult = { skipped: false, reactivated: false };
  const logs: string[] = [];
  let charges = 0;
  const pending = importSessionBounded(
    importerWithCancel(
      () => write.promise,
      () => {
        // Nothing of this session's is on the writer: its last record group
        // committed as the deadline tripped, so the eviction takes no victim and
        // the import settles durably a moment later.
        write.resolve(durable);
        return WriteQueueCancelOutcome.None;
      }
    ),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS,
    () => {
      charges += 1;
    }
  );
  nodeTestTimers.tick(TIMEOUT_MS);
  assert.deepEqual(
    await pending,
    durable,
    "the importer's own durable result is reported, not a synthetic failure"
  );
  assert.equal(charges, 0, "a durably committed import is not charged");
  assert.equal(
    logs.filter((m) => UNMARKED_LOG_PATTERN.test(m)).length,
    0,
    `no line claims the source was left unmarked: ${JSON.stringify(logs)}`
  );
});

test("ISS-7257: an INCOMPLETE late settle is still charged — a half-committed session must stay unmarked", async () => {
  const session = makeSession({ sessionId: "half-committed" });
  const write = deferred<ImportResult>();
  const logs: string[] = [];
  let charges = 0;
  const pending = importSessionBounded(
    importerWithCancel(
      () => write.promise,
      () => {
        // A tolerated record group failed: rows landed, but not all of them.
        write.resolve({ skipped: false, reactivated: false, incomplete: true });
        return WriteQueueCancelOutcome.None;
      }
    ),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS,
    () => {
      charges += 1;
    }
  );
  nodeTestTimers.tick(TIMEOUT_MS);
  assert.deepEqual(await pending, {
    skipped: false,
    reactivated: false,
    failed: true,
  });
  assert.equal(charges, 1, "a partial commit still spends the retry budget");
  assert.equal(logs.length, 1);
  assert.match(logs[0], UNMARKED_LOG_PATTERN);
});

test("ISS-7257: a LOST eviction answer is not proof the write survived — a clean late settle is still charged", async () => {
  const session = makeSession({ sessionId: "eviction-answer-lost" });
  const write = deferred<ImportResult>();
  const logs: string[] = [];
  let charges = 0;
  const pending = importSessionBounded(
    importerWithCancel(
      () => write.promise,
      () => {
        // The DB-host invoke was issued and its reply never came back. It may have
        // been DELIVERED and executed, so this write may have been cancelled
        // mid-flight — and a cancelled import can still return a result carrying
        // neither `failed` nor `incomplete`. Trusting it would seal a source whose
        // write we ourselves killed.
        write.resolve({ skipped: false, reactivated: false });
        return Promise.reject(new Error("db host invoke failed (exit code 5)"));
      }
    ),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS,
    () => {
      charges += 1;
    }
  );
  nodeTestTimers.tick(TIMEOUT_MS);
  assert.deepEqual(await pending, {
    skipped: false,
    reactivated: false,
    failed: true,
  });
  assert.equal(
    charges,
    1,
    "no eviction evidence means no durable-commit claim"
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], UNMARKED_LOG_PATTERN);
});

test("ISS-7257: a late settle that reports FAILED is still charged — only a durable write is promoted", async () => {
  const session = makeSession({ sessionId: "failed-late" });
  const write = deferred<ImportResult>();
  const logs: string[] = [];
  let charges = 0;
  const pending = importSessionBounded(
    importerWithCancel(
      () => write.promise,
      () => {
        // Nothing was evicted, so the grace runs — but the importer's own answer
        // is that the session was never durably handled (write-core returns this
        // shape for an unsafe token count and for the FK-parent gate).
        write.resolve({ skipped: true, reactivated: false, failed: true });
        return WriteQueueCancelOutcome.None;
      }
    ),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS,
    () => {
      charges += 1;
    }
  );
  nodeTestTimers.tick(TIMEOUT_MS);
  assert.deepEqual(await pending, {
    skipped: false,
    reactivated: false,
    failed: true,
  });
  assert.equal(charges, 1, "a late failure is not a durable commit");
  assert.equal(logs.length, 1);
  assert.match(logs[0], UNMARKED_LOG_PATTERN);
});

test("ISS-7257: a write the bound EVICTED is never treated as committed, whatever it resolves afterwards", async () => {
  const session = makeSession({ sessionId: "evicted-then-resolves" });
  const write = deferred<ImportResult>();
  const logs: string[] = [];
  let charges = 0;
  const pending = importSessionBounded(
    importerWithCancel(
      () => write.promise,
      () => {
        // The eviction took THIS session's running write as its victim. A result
        // arriving afterwards cannot describe a complete commit, so honouring it
        // would mark a source whose write was cancelled mid-flight.
        write.resolve({ skipped: false, reactivated: false });
        return WriteQueueCancelOutcome.Running;
      }
    ),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS,
    () => {
      charges += 1;
    }
  );
  nodeTestTimers.tick(TIMEOUT_MS);
  assert.deepEqual(await pending, {
    skipped: false,
    reactivated: false,
    failed: true,
  });
  assert.equal(charges, 1, "an evicted write still spends the retry budget");
  assert.equal(logs.length, 1);
  assert.match(logs[0], UNMARKED_LOG_PATTERN);
});

test("ISS-4410 (whitlockk review): a genuine async rejection is propagated, not mapped to failed", async () => {
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

test("ISS-4410 (whitlockk review): a synchronous importer throw is propagated and clears the timer", async () => {
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

/**
 * ISS-7256 — a deadline spent WAITING is not a deadline spent working. Measured
 * against the ticket's own case, a 267 KB / 17-event rollout imports in 24–27 ms
 * on a store seeded to 2,000 sessions, while production reported 12–20 s per
 * import and 62 sessions past the 120 s bound; a write that never dispatched is
 * the waiter, not the wedge, so ending its attempt only buys a full re-parse and
 * re-import next pass.
 *
 * The probe is a PROBE and not a boolean because of the two review findings the
 * contract now carries: it has to be answerable by the db-host DISPATCHER while
 * the store thread is blocked (whitlockk — see `write-dispatch-mirror.ts` and
 * `bounded-import-blocked-store.test.ts`), and its answer is consumed a round
 * trip after it was computed, so a grant must be able to detect that the task it
 * described has since moved (davetho — `taskSeq`).
 */
function queuedProbe(taskSeq: number): WriteDispatchProbe {
  return { state: WriteDispatchState.Queued, taskSeq };
}

const DISPATCHED_PROBE: WriteDispatchProbe = {
  state: WriteDispatchState.Dispatched,
  taskSeq: 1,
};
const ABSENT_PROBE: WriteDispatchProbe = {
  state: WriteDispatchState.Absent,
  taskSeq: null,
};

function importerWaiting(
  importSession: Importer["importSession"],
  hasUndispatchedWrite: NonNullable<Importer["hasUndispatchedWrite"]>,
  onCancel?: () => void
): Importer {
  return {
    importSession,
    hasUndispatchedWrite,
    cancelInFlightWrite: () => {
      onCancel?.();
      return WriteQueueCancelOutcome.Queued;
    },
  };
}

/** Let the deadline's async probe chain run before advancing the clock again. */
async function drainDeadlineProbe(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Advance through one granted re-arm slice and let its probe chain settle.
 *
 * The grant is SLICED at `UNDISPATCHED_REARM_REVALIDATE_MS` rather than handed
 * out a whole bound at a time (davetho review), so a test that ticks
 * `TIMEOUT_MS` would skip past several re-validations at once and could not
 * observe the one that refuses.
 */
async function advanceRearmSlice(timeoutMs: number): Promise<void> {
  nodeTestTimers.tick(rearmSliceMs(timeoutMs));
  await drainDeadlineProbe();
}

test("ISS-7256: a write that never dispatched is NOT evicted at the bound — it is waited on", async () => {
  const session = makeSession({ sessionId: "queued-waiter" });
  const wedged = deferred<ImportResult>();
  const logs: string[] = [];
  let cancels = 0;
  const pending = importSessionBounded(
    importerWaiting(
      () => wedged.promise,
      () => queuedProbe(9),
      () => {
        cancels += 1;
      }
    ),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );
  nodeTestTimers.tick(TIMEOUT_MS);
  await drainDeadlineProbe();
  assert.equal(cancels, 0, "a never-dispatched write is not evicted");
  assert.equal(
    logs.filter((m) => EXCEEDED_LOG_PATTERN.test(m)).length,
    0,
    "the source is not reported as skipped while its write is still queued"
  );
  assert.equal(
    logs.filter((m) => REARM_LOG_PATTERN.test(m)).length,
    1,
    "the re-arm is reported once"
  );
  // The write finally dispatches and commits inside the extra window: the bound
  // returns its REAL result, so the source is marked and never re-imported.
  wedged.resolve({ skipped: false, reactivated: true });
  const result = await pending;
  assert.deepEqual(result, { skipped: false, reactivated: true });
  assert.equal(cancels, 0, "a completed waiter is never evicted");
});

test("ISS-7256: a DISPATCHED write still trips at the first bound (the ISS-4410 wedge is untouched)", async () => {
  const session = makeSession({ sessionId: "dispatched-wedge" });
  const wedged = deferred<ImportResult>();
  const logs: string[] = [];
  let cancels = 0;
  const pending = importSessionBounded(
    importerWaiting(
      () => wedged.promise,
      () => DISPATCHED_PROBE,
      () => {
        cancels += 1;
      }
    ),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );
  nodeTestTimers.tick(TIMEOUT_MS);
  await expireDurableSettleGrace();
  const result = await pending;
  assert.deepEqual(result, {
    skipped: false,
    reactivated: false,
    failed: true,
  });
  assert.equal(cancels, 1, "the dispatched wedge is evicted exactly once");
  assert.equal(
    logs.filter((m) => REARM_LOG_PATTERN.test(m)).length,
    0,
    "a dispatched write is never granted an extra window"
  );
  assert.equal(
    logs.filter((m) => UNMARKED_LOG_PATTERN.test(m)).length,
    1,
    "the source is left unmarked exactly as before ISS-7256"
  );
});

/**
 * ISS-7256 — `Absent` is ISS-6115's `None`, not a waiter. No write of this
 * session's is at the writer, so the deadline went on its own pre-queue work
 * (parse, attribution) and the ISS-4410 premise holds.
 */
test("ISS-7256: an ABSENT probe takes the unchanged timeout path", async () => {
  const session = makeSession({ sessionId: "absent" });
  const wedged = deferred<ImportResult>();
  const logs: string[] = [];
  const pending = importSessionBounded(
    importerWaiting(
      () => wedged.promise,
      () => ABSENT_PROBE
    ),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );
  nodeTestTimers.tick(TIMEOUT_MS);
  await expireDurableSettleGrace();
  assert.deepEqual(await pending, {
    skipped: false,
    reactivated: false,
    failed: true,
  });
  assert.equal(
    logs.filter((m) => REARM_LOG_PATTERN.test(m)).length,
    0,
    "no write of this session's was waiting, so nothing is extended"
  );
});

/**
 * ISS-7256 (davetho review) — THE STALE-OBSERVATION CASE.
 *
 * The probe answers a point-in-time question that main consumes later. The queue
 * can report `queued`, then dispatch that task, run it, settle it, and admit the
 * SAME owner's next record group — at which point the owner reads `queued`
 * again, having written a whole group in between. A bound that trusted the state
 * word alone would read "still waiting" and keep extending a session that is
 * actively holding the writer, which is the ISS-4410 wedge getting free windows.
 *
 * `taskSeq` is what tells the two apart, and a moved one ends the extension.
 */
test("ISS-7256: queued → dispatched → a delayed 'queued' about a DIFFERENT task does not extend the bound", async () => {
  const session = makeSession({ sessionId: "moved-on" });
  const wedged = deferred<ImportResult>();
  const logs: string[] = [];
  const answers: WriteDispatchProbe[] = [];
  // First probe: task #9 is queued. Second: the owner still reads `queued`, but
  // it is task #14 — #9 dispatched, ran and settled in between.
  let call = 0;
  const pending = importSessionBounded(
    importerWaiting(
      () => wedged.promise,
      () => {
        call += 1;
        const probe = call === 1 ? queuedProbe(9) : queuedProbe(14);
        answers.push(probe);
        return probe;
      }
    ),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );
  nodeTestTimers.tick(TIMEOUT_MS);
  await drainDeadlineProbe();
  assert.equal(
    logs.filter((m) => REARM_LOG_PATTERN.test(m)).length,
    1,
    "the first observation earns one slice"
  );
  await advanceRearmSlice(TIMEOUT_MS);
  await expireDurableSettleGrace();

  assert.deepEqual(await pending, {
    skipped: false,
    reactivated: false,
    failed: true,
  });
  assert.deepEqual(
    answers.map((probe) => probe.state),
    [WriteDispatchState.Queued, WriteDispatchState.Queued],
    "both answers said `queued` — the STATE word alone could not have refused"
  );
  assert.equal(
    logs.filter((m) => REARM_LOG_PATTERN.test(m)).length,
    1,
    "the second slice is refused because the probed task moved"
  );
});

/**
 * ISS-7256 (davetho review) — the grant is SLICED, so a stale `queued` costs
 * one re-validation interval rather than a whole further deadline. That bounds
 * the handoff race the review named: the dispatcher can observe a task queued and
 * the head can dispatch it before main consumes the answer, and what main then
 * holds is a short slice it must re-earn.
 */
test("ISS-7256: a granted window is re-validated rather than handed out whole", async () => {
  const session = makeSession({ sessionId: "revalidated" });
  const wedged = deferred<ImportResult>();
  const logs: string[] = [];
  let probes = 0;
  const pending = importSessionBounded(
    importerWaiting(
      () => wedged.promise,
      () => {
        probes += 1;
        return queuedProbe(9);
      }
    ),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    LONG_TIMEOUT_MS
  );
  nodeTestTimers.tick(LONG_TIMEOUT_MS);
  await drainDeadlineProbe();
  assert.equal(probes, 1);
  assert.ok(
    rearmSliceMs(LONG_TIMEOUT_MS) < LONG_TIMEOUT_MS,
    "a slice must be shorter than the bound, or re-validation buys nothing"
  );
  // One SLICE, not one bound. A bound that handed out a whole further deadline
  // would still be on its first grant here, and a write that dispatched just
  // after the observation would hold the writer unchallenged for all of it.
  await advanceRearmSlice(LONG_TIMEOUT_MS);
  assert.equal(
    probes,
    2,
    "the bound re-asks after a slice, so a write that dispatched mid-grant is caught within it"
  );
  wedged.resolve({ skipped: false, reactivated: true });
  assert.deepEqual(await pending, { skipped: false, reactivated: true });
});

test("ISS-7256: the granted time is CAPPED — a permanently starved write still reaches a terminal outcome", async () => {
  const session = makeSession({ sessionId: "starved" });
  const wedged = deferred<ImportResult>();
  const logs: string[] = [];
  let cancels = 0;
  const pending = importSessionBounded(
    importerWaiting(
      () => wedged.promise,
      () => queuedProbe(9),
      () => {
        cancels += 1;
      }
    ),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );
  nodeTestTimers.tick(TIMEOUT_MS);
  await drainDeadlineProbe();
  // The cap is expressed as a literal count rather than read off the constant:
  // a fixture that imports the value it polices cannot detect a change to it.
  // At this bound a slice is a whole TIMEOUT_MS, so the budget is two of them —
  // and the loop over-ticks deliberately, to prove nothing further is granted.
  for (let slice = 0; slice < 4; slice++) {
    nodeTestTimers.tick(TIMEOUT_MS);
    await drainDeadlineProbe();
  }
  await expireDurableSettleGrace();
  const result = await pending;
  assert.deepEqual(result, {
    skipped: false,
    reactivated: false,
    failed: true,
  });
  assert.equal(
    logs.filter((m) => REARM_LOG_PATTERN.test(m)).length,
    2,
    "exactly 2000ms of extra waiting was granted, in slices, and then no more"
  );
  assert.equal(cancels, 1, "the starved write is evicted once at the cap");
});

test("ISS-7256: a probe that REJECTS takes the unchanged timeout path", async () => {
  // In DB-host mode the probe is an IPC invoke to a child that may be dying. A
  // lost answer must never extend a deadline: the conservative answer is no
  // evidence, which is exactly the pre-ISS-7256 behavior.
  const session = makeSession({ sessionId: "probe-reject" });
  const wedged = deferred<ImportResult>();
  const logs: string[] = [];
  const pending = importSessionBounded(
    importerWaiting(
      () => wedged.promise,
      () => Promise.reject(new Error("db host gone"))
    ),
    (m) => logs.push(m),
    session,
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );
  nodeTestTimers.tick(TIMEOUT_MS);
  await expireDurableSettleGrace();
  const result = await pending;
  assert.deepEqual(result, {
    skipped: false,
    reactivated: false,
    failed: true,
  });
  assert.equal(
    logs.filter((m) => REARM_LOG_PATTERN.test(m)).length,
    0,
    "a lost probe answer never extends the bound"
  );
});
