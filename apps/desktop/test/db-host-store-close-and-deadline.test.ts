/**
 * @file db-host-store-close-and-deadline.test.ts
 * @description ISS-8246 M1 — the two BOUNDED waits the dispatcher places on the
 * store thread: the inner close ack (§1.7) and the per-op deadline (§1.8).
 *
 * Both exist so a wedged store cannot hold the dispatcher, and both are
 * therefore only meaningful if they actually fire. They are driven here on a
 * hand-rolled clock through the client's own timer seam — no wall-clock sleep,
 * and no `vi.useFakeTimers`, so nothing can leak a frozen clock into a sibling
 * file if an assertion throws.
 *
 * ISS-8773 added the THIRD wait and split what the second one means: a per-op
 * deadline now fails only its own op, and process death moved to a separate
 * silence window. The blast-radius cases live here rather than in a new file
 * because they are the same contract driven through the same harness — the
 * question "what does a bounded wait do when it expires" is one responsibility,
 * and the ISS-8246 expectations below changed answer rather than being joined.
 *
 * ISS-9197 adds the OPEN deadline for the same reason, and it is the one whose
 * expiry is no longer final: the boot path retries it and terminates on every
 * other open failure, so what this file now also owns is that the two are
 * distinguishable at all.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
// Main's budget for the WHOLE close. Imported, not re-declared: this test's
// entire point is the arithmetic against the real value, and a local literal
// keeps passing when that value moves.
import { CLOSE_ACK_TIMEOUT_MS } from "../src/main/database/db-host/db-host-client.js";
import {
  createDbStoreClient,
  type DbStoreWorkerHandle,
} from "../src/main/database/db-host/db-store-client.js";
import {
  STORE_CLOSE_DEADLINE_MS,
  STORE_HEAVY_DEADLINE_MS,
  STORE_INVOKE_DEADLINE_MS,
  STORE_OPEN_DEADLINE_MS,
  STORE_UNRESPONSIVE_DEADLINE_MS,
} from "../src/main/database/db-host/db-store-deadlines.js";
import {
  type DbStoreRequest,
  DbStoreRequestKind,
  type DbStoreResponse,
  DbStoreResponseKind,
} from "../src/main/database/db-host/db-store-protocol.js";
import { isDbStoreOpDeadlineError } from "../src/shared/db-store-op-deadline-error.js";
import {
  isStoreOpenTimeoutError,
  isTransientDbHostError,
} from "../src/shared/transient-db-host-error.js";

const CLOSE_GIVE_UP_LOG = /did not acknowledge close/;
const DEADLINE_REJECTION = /did not answer within its \d+ms deadline/;
const DEADLINE_NAMES_THE_OP = /sessions\.getAll/;
const DEADLINE_REPORTS_ELAPSED = /\((\d+)ms since it was posted\)/;
const UNRESPONSIVE_DEATH = /store thread is unresponsive/;
const LATE_ANSWER_LOG =
  /(succeeded|failed) \d+ms after it was posted, past its deadline/;
const GAVE_UP_LOG = /never answered; giving up on it \d+ms after it was posted/;
const TRIP_LOG =
  /missed its \d+ms deadline after \d+ms; failing that op only, the store thread is still up/;
/** The one op both the heavy-queue and the ISS-8773 cases drive. */
const IMPORT_OP = "importer.importSession";

type Listeners = {
  message?: (value: unknown) => void;
  error?: (error: Error) => void;
  exit?: (code: number) => void;
};

type Clock = {
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  /** The client's `nowFn` seam, so an elapsed it reports is this same clock. */
  now: () => number;
  advance: (ms: number) => void;
};

function makeClock(): Clock {
  const timers = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  let nextTimer = 1;
  const set = (fn: () => void, ms?: number) => {
    const handle = nextTimer;
    nextTimer += 1;
    timers.set(handle, { at: now + (ms ?? 0), fn });
    return handle;
  };
  const clear = (handle?: unknown) => {
    timers.delete(handle as number);
  };
  return {
    // Test-only shim for the injected timer seam; the production type is
    // Node's, whose branded handle a fake cannot produce.
    setTimeoutFn: set as unknown as typeof setTimeout,
    clearTimeoutFn: clear as unknown as typeof clearTimeout,
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const [handle, entry] of [...timers]) {
        if (entry.at <= now) {
          timers.delete(handle);
          entry.fn();
        }
      }
    },
  };
}

type Harness = {
  client: ReturnType<typeof createDbStoreClient>;
  clock: Clock;
  sent: DbStoreRequest[];
  deaths: string[];
  logs: string[];
  emit: (message: DbStoreResponse) => void;
  emitError: (error: Error) => void;
  emitExit: (code: number) => void;
};

async function makeOpenedHarness(): Promise<Harness> {
  const harness = makeHarness();
  const open = harness.client.open({ dataDir: "/tmp/db-store-close-test" });
  harness.emit({ kind: DbStoreResponseKind.Opened });
  await open;
  harness.sent.length = 0;
  return harness;
}

/** The same harness with the store thread NOT yet open — see {@link makeOpenedHarness}. */
function makeHarness(): Harness {
  const listeners: Listeners = {};
  const sent: DbStoreRequest[] = [];
  const deaths: string[] = [];
  const logs: string[] = [];
  const clock = makeClock();
  const worker: DbStoreWorkerHandle = {
    on(
      event: "message" | "error" | "exit",
      listener: (payload: never) => void
    ) {
      Reflect.set(listeners, event, listener);
      return worker;
    },
    postMessage(message: DbStoreRequest) {
      sent.push(message);
    },
    terminate() {
      return Promise.resolve(0);
    },
  };
  const emit = (message: DbStoreResponse) => listeners.message?.(message);
  const client = createDbStoreClient({
    onEmit: () => undefined,
    onSessionTerminal: () => undefined,
    onCommittedWrite: () => undefined,
    onWriteTask: () => undefined,
    onLog: (message) => logs.push(message),
    onDurableLog: () => undefined,
    onTelemetry: () => undefined,
    onDeath: (reason) => deaths.push(reason),
    createWorker: () => worker,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    nowFn: clock.now,
  });
  return {
    client,
    clock,
    sent,
    deaths,
    logs,
    emit,
    emitError: (error: Error) => listeners.error?.(error),
    emitExit: (code: number) => listeners.exit?.(code),
  };
}

describe("ISS-8246 M1: the inner close is bounded", () => {
  it("resolves as soon as the store acknowledges", async () => {
    const harness = await makeOpenedHarness();
    const closing = harness.client.close();
    assert.deepEqual(harness.sent, [{ kind: DbStoreRequestKind.Close }]);
    harness.emit({ kind: DbStoreResponseKind.Closed });
    await closing;
    assert.deepEqual(harness.logs, []);
  });

  it("gives up in time for the dispatcher to still ack main", async () => {
    // PLN-1837 §1.7, and the arithmetic is the point. `CLOSE_ACK_TIMEOUT_MS` is
    // MAIN's budget for the WHOLE close, after which it kills the child
    // regardless. Closing the store drains the write queue, so a store busy with
    // a multi-second import will not answer inside it — and if the dispatcher
    // waited for that store, it would still be waiting when main gave up, and
    // main would kill it mid-ack. The inner budget must therefore fire first,
    // leaving the dispatcher room to terminate the thread and answer.
    assert.ok(
      STORE_CLOSE_DEADLINE_MS < CLOSE_ACK_TIMEOUT_MS,
      "the inner close budget must fit inside main's whole-close budget"
    );

    const harness = await makeOpenedHarness();
    let settled = false;
    const closing = harness.client.close().then(() => {
      settled = true;
    });

    harness.clock.advance(STORE_CLOSE_DEADLINE_MS - 1);
    await Promise.resolve();
    assert.equal(
      settled,
      false,
      "the dispatcher must not abandon the store before its budget elapses"
    );

    harness.clock.advance(1);
    await closing;
    assert.equal(settled, true);
    // Never silent: a store that failed to drain is a fact an operator needs,
    // and the close still succeeds, so nothing else would say so.
    assert.equal(harness.logs.length, 1);
    assert.match(harness.logs[0], CLOSE_GIVE_UP_LOG);
    // And it must not be reported as a crash — a close that timed out is still a
    // close, not a death the supervisor should restart from.
    assert.deepEqual(harness.deaths, []);
  });
});

describe("ISS-8246 M1: a store-thread death classifies as TRANSIENT", () => {
  // The regression: `die()` rejects the in-flight invokes, and those rejections
  // settle on the microtask queue while `handleStoreDeath` defers the process
  // exit by a tick. So the dispatcher answers main with `Result ok:false`
  // BEFORE the exit runs, main settles the request normally, and
  // `DbHostClient.handleExit` never mints its typed `DbHostExitError`. If the
  // message carries no lifecycle signature the Branches/Sessions boundaries
  // show the hard error card + Retry for a host that is re-forking one tick
  // later — where before M1 the same crash arrived as `db-host exited (code: N)`.
  it("marks an exit and a worker error transient, but NOT a deadline trip", async () => {
    const exited = await makeOpenedHarness();
    const onExit = rejectionOf(exited.client.execute("sessions.getAll", []));
    exited.emitExit(5);

    const errored = await makeOpenedHarness();
    const onError = rejectionOf(errored.client.execute("sessions.getAll", []));
    errored.emitError(new Error("worker blew up"));

    // An invoke arriving in the tick BETWEEN the death and the exit takes the
    // same path, rather than a bare "thread is gone".
    const afterDeath = rejectionOf(
      exited.client.execute("sessions.getAll", [])
    );

    for (const [label, pending] of [
      ["exit", onExit],
      ["worker error", onError],
      ["invoke after death", afterDeath],
    ] as const) {
      const error = await pending;
      assert.ok(
        isTransientDbHostError(error),
        `a store-thread ${label} must classify transient, got: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // ISS-8773 reverses the answer for the fourth case, and the reversal is the
    // contract: a late op is NOT a lifecycle blip. Calling it transient would
    // park Branches/Sessions in the quiet reconnecting state waiting for a
    // re-fork that is never coming, because the store never left.
    const timedOut = await makeOpenedHarness();
    const onDeadline = rejectionOf(
      timedOut.client.execute("sessions.getAll", [])
    );
    timedOut.clock.advance(STORE_INVOKE_DEADLINE_MS);
    const deadlineError = await onDeadline;
    assert.equal(
      isTransientDbHostError(deadlineError),
      false,
      `a deadline trip must NOT classify transient, got: ${
        deadlineError instanceof Error
          ? deadlineError.message
          : String(deadlineError)
      }`
    );
    assert.ok(
      isDbStoreOpDeadlineError(deadlineError),
      "and it must be recognizable to the fire-and-forget guard, or a write with no caller crashes the app"
    );
    assert.deepEqual(timedOut.deaths, []);
  });
});

/** The rejection value, or a marker if the promise resolved instead. */
function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => new Error("expected a rejection, got a resolved value"),
    (error: unknown) => error
  );
}

describe("ISS-8246 M1: an op queued behind a heavy op is not measured yet", () => {
  // The regression M1 opens if these deadlines are read literally. Before the
  // split, an import blocked the dispatcher's own loop, so a read could not even
  // be POSTED while it ran. After it, the dispatcher stays responsive and hands
  // the store thread a read it has no loop turn to see — and then kills it for
  // not answering. `die()` exits the process, so the import that was running
  // well inside its hour dies with it, along with every other in-flight op.
  it("holds a queued read to the heavy backstop, then re-arms it on settle", async () => {
    const harness = await makeOpenedHarness();
    const importing = outcomeOf(harness.client.execute(IMPORT_OP, []));
    const read = outcomeOf(harness.client.execute("sessions.getAll", []));

    // Past the read's OWN budget, with the import still legally running.
    harness.clock.advance(STORE_INVOKE_DEADLINE_MS);
    await Promise.resolve();
    assert.equal(
      read.settled,
      null,
      "a read the store has not seen yet is not late"
    );
    assert.equal(importing.settled, null, "and the import must survive it");
    assert.deepEqual(harness.deaths, []);

    // The import answers: the store thread is free, so the read's own budget
    // starts meaning something again — from here, not from its post.
    harness.emit({
      kind: DbStoreResponseKind.Result,
      id: 1,
      ok: true,
      value: null,
    });
    await importing.done;
    assert.equal(importing.settled, "resolved");

    harness.clock.advance(STORE_INVOKE_DEADLINE_MS - 1);
    await Promise.resolve();
    assert.equal(
      read.settled,
      null,
      "the re-armed budget runs from the heavy op settling, not from the post"
    );

    harness.clock.advance(1);
    await read.done;
    assert.match(String(read.settled), DEADLINE_REJECTION);
    // ISS-8773: the read's own budget expiring fails the read, not the store —
    // the import that shared this thread is still live and still un-rejected.
    assert.deepEqual(harness.deaths, []);
  });

  it("keeps its own budget for a read posted BEFORE the heavy op", async () => {
    // The ordering half. A read already in the buffer is ahead of the import, so
    // the store thread reaches it first and its own budget is honest — widening
    // every light op whenever a heavy one exists would blunt the backstop that
    // FEA-4014 put here.
    const harness = await makeOpenedHarness();
    const read = outcomeOf(harness.client.execute("sessions.getAll", []));
    const importing = outcomeOf(harness.client.execute(IMPORT_OP, []));

    harness.clock.advance(STORE_INVOKE_DEADLINE_MS);
    await read.done;
    assert.match(String(read.settled), DEADLINE_REJECTION);
    assert.deepEqual(harness.deaths, []);
    assert.equal(
      importing.settled,
      null,
      "the import must outlive a read that expired beside it"
    );
  });

  it("waits for the LAST heavy op before re-arming", async () => {
    const harness = await makeOpenedHarness();
    const first = outcomeOf(harness.client.execute(IMPORT_OP, []));
    const second = outcomeOf(harness.client.execute(IMPORT_OP, []));
    const read = outcomeOf(harness.client.execute("sessions.getAll", []));

    harness.emit({
      kind: DbStoreResponseKind.Result,
      id: 1,
      ok: true,
      value: null,
    });
    await first.done;

    harness.clock.advance(STORE_INVOKE_DEADLINE_MS);
    await Promise.resolve();
    assert.equal(
      read.settled,
      null,
      "one of two heavy ops settling has not freed the store thread"
    );
    assert.deepEqual(harness.deaths, []);
    assert.equal(second.settled, null);
  });
});

/** A promise's outcome, readable synchronously between clock advances. */
function outcomeOf(pending: Promise<unknown>): {
  done: Promise<void>;
  settled: string | null;
} {
  const state: { done: Promise<void>; settled: string | null } = {
    settled: null,
    done: pending.then(
      () => {
        state.settled = "resolved";
      },
      (error: Error) => {
        state.settled = error.message;
      }
    ),
  };
  return state;
}

describe("ISS-8773: a missed deadline fails its own op, not the store", () => {
  // The incident: `syncSource.loadSyncedSessions` ran long, `die()` rejected
  // every in-flight entry and exited the process, and the dashboard's
  // `session_count` query plus three `shared-agent-sessions:usage` handlers —
  // none of them related to the slow read — died with it.
  it("rejects only the late op, once its budget elapses", async () => {
    const harness = await makeOpenedHarness();
    const op = outcomeOf(harness.client.execute("sessions.getAll", []));

    harness.clock.advance(STORE_INVOKE_DEADLINE_MS - 1);
    await Promise.resolve();
    assert.equal(
      op.settled,
      null,
      "an op inside its budget must not be cut off — these deadlines are hang backstops, not budgets"
    );

    harness.clock.advance(1);
    await op.done;
    assert.match(String(op.settled), DEADLINE_REJECTION);
    assert.match(String(op.settled), DEADLINE_NAMES_THE_OP);
    assert.deepEqual(harness.deaths, []);
  });

  it("leaves every unrelated in-flight op running, and lets it complete", async () => {
    // The blast-radius assertion, and the distinction it has to make: an
    // unrelated op must be observed COMPLETING WITH ITS VALUE, not merely
    // "not rejected" — a store that never ran anything would also satisfy
    // "nothing rejected".
    const harness = await makeOpenedHarness();
    const slow = outcomeOf(harness.client.execute("sessions.getAll", []));
    // Posted late enough that they are well inside their OWN budgets when the
    // slow op's expires — the incident's shape, where the dashboard's count and
    // the usage handlers were mid-flight and nowhere near late.
    harness.clock.advance(STORE_INVOKE_DEADLINE_MS - 1);
    const unrelatedA = harness.client.execute("dashboard.getPacks", []);
    const unrelatedB = harness.client.execute("dashboard.getTools", []);

    harness.clock.advance(1);
    await slow.done;
    assert.match(String(slow.settled), DEADLINE_REJECTION);
    assert.deepEqual(harness.deaths, []);

    // ids 2 and 3: the store thread is alive and still answering.
    harness.emit({
      kind: DbStoreResponseKind.Result,
      id: 2,
      ok: true,
      value: "packs",
    });
    harness.emit({
      kind: DbStoreResponseKind.Result,
      id: 3,
      ok: true,
      value: "tools",
    });
    assert.equal(await unrelatedA, "packs");
    assert.equal(await unrelatedB, "tools");
  });

  it("reports the elapsed since the POST, not the budget it was last armed against", async () => {
    // ISS-8773 AC4. A read posted behind a heavy op is armed against the heavy
    // backstop and re-armed to its own budget when that op settles, so the
    // budget named in the failure is not the wall clock the caller waited. A
    // message naming 300000ms after nine minutes is misleading during triage.
    const harness = await makeOpenedHarness();
    const importing = harness.client.execute(IMPORT_OP, []);
    const read = outcomeOf(harness.client.execute("sessions.getAll", []));

    const waitedBehindHeavyMs = 259_665;
    harness.clock.advance(waitedBehindHeavyMs);
    harness.emit({
      kind: DbStoreResponseKind.Result,
      id: 1,
      ok: true,
      value: null,
    });
    await importing;

    harness.clock.advance(STORE_INVOKE_DEADLINE_MS);
    await read.done;
    const elapsed = DEADLINE_REPORTS_ELAPSED.exec(String(read.settled));
    assert.ok(elapsed, `no elapsed in the failure: ${read.settled}`);
    assert.equal(
      Number(elapsed[1]),
      waitedBehindHeavyMs + STORE_INVOKE_DEADLINE_MS
    );
  });

  it("releases the heavy accounting when an overdue heavy op answers late", async () => {
    // The bookkeeping an overdue op must not lose. While a heavy op is
    // outstanding, ops posted behind it ride the heavy backstop; if a heavy op
    // that blew its budget were simply forgotten, that release would never fire
    // and every later queued op would sit on the hour-long backstop forever.
    const harness = await makeOpenedHarness();
    const importing = outcomeOf(harness.client.execute(IMPORT_OP, []));
    harness.clock.advance(STORE_HEAVY_DEADLINE_MS);
    await importing.done;
    assert.match(String(importing.settled), DEADLINE_REJECTION);
    assert.deepEqual(harness.deaths, []);

    const read = outcomeOf(harness.client.execute("sessions.getAll", []));
    harness.emit({
      kind: DbStoreResponseKind.Result,
      id: 1,
      ok: true,
      value: null,
    });
    await Promise.resolve();
    assert.match(harness.logs.at(-1) ?? "", LATE_ANSWER_LOG);

    // Heavy accounting released, so the read is back on its OWN budget.
    harness.clock.advance(STORE_INVOKE_DEADLINE_MS);
    await read.done;
    assert.match(String(read.settled), DEADLINE_REJECTION);
  });

  it("stops holding the heavy slot when an overdue op never answers at all", async () => {
    // Both bug hunters found this independently, and the scenario is the point:
    // the store thread does NOT serialize Executes, so an op whose reply never
    // comes leaves the thread answering everything else. Every one of those
    // replies restarts the silence watchdog, so death never arrives to clean up
    // — and without a bound the stuck op's heavy slot is pinned for the life of
    // the process, arming EVERY later light op against the hour-long backstop.
    // That is the ISS-8773 defect inverted: one stuck op degrading all the rest.
    const harness = await makeOpenedHarness();
    const stuck = outcomeOf(harness.client.execute(IMPORT_OP, []));
    harness.clock.advance(STORE_HEAVY_DEADLINE_MS);
    await stuck.done;
    assert.match(String(stuck.settled), DEADLINE_REJECTION);

    // The store proves it is alive twice on the way, resetting the silence clock
    // each time, so nothing else can be what evicts the stuck op.
    const answerSomethingElse = async (id: number): Promise<void> => {
      const other = harness.client.execute("sessions.getAll", []);
      harness.emit({
        kind: DbStoreResponseKind.Result,
        id,
        ok: true,
        value: null,
      });
      await other;
    };
    await answerSomethingElse(2);
    harness.clock.advance(STORE_HEAVY_DEADLINE_MS - 1);
    await answerSomethingElse(3);
    assert.deepEqual(harness.deaths, [], "a store that answers is not wedged");

    harness.clock.advance(1);
    await Promise.resolve();
    assert.match(harness.logs.at(-1) ?? "", GAVE_UP_LOG);
    assert.deepEqual(harness.deaths, []);

    // The slot is released, so a read posted now runs on its OWN 5 minutes. If
    // the stuck op still held it, this would be armed against the hour and would
    // not have settled here at all.
    const read = outcomeOf(harness.client.execute("sessions.getAll", []));
    harness.clock.advance(STORE_INVOKE_DEADLINE_MS);
    await read.done;
    assert.match(String(read.settled), DEADLINE_REJECTION);
  });

  it("names the op and the elapsed the moment the deadline trips", async () => {
    // The trip used to always surface as a process death on the monitored exit
    // path. Failing the op alone removes that, so silence here would be a
    // regression in observability, not just in wording.
    const harness = await makeOpenedHarness();
    const op = outcomeOf(harness.client.execute("sessions.getAll", []));
    assert.deepEqual(
      harness.logs,
      [],
      "nothing is said before the budget runs"
    );

    harness.clock.advance(STORE_INVOKE_DEADLINE_MS);
    await op.done;
    assert.match(harness.logs.at(-1) ?? "", TRIP_LOG);
    assert.match(harness.logs.at(-1) ?? "", DEADLINE_NAMES_THE_OP);
  });
});

describe("ISS-8773: death is reserved for a store that answers nothing", () => {
  it("kills a store that has gone silent under an outstanding op", async () => {
    // The guarantee the old design bought, kept. A wedged store must still
    // become a restart rather than a permanent hang, so `die()` is still
    // reachable — it just needs evidence the thread is gone, not merely slow.
    const harness = await makeOpenedHarness();
    const op = outcomeOf(harness.client.execute("sessions.getAll", []));

    harness.clock.advance(STORE_UNRESPONSIVE_DEADLINE_MS - 1);
    await Promise.resolve();
    assert.deepEqual(
      harness.deaths,
      [],
      "a store inside the silence window is not yet wedged"
    );

    harness.clock.advance(1);
    await op.done;
    assert.equal(harness.deaths.length, 1);
    assert.match(harness.deaths[0], UNRESPONSIVE_DEATH);
  });

  it("does not let an abandoned op's silence window convict a later one", async () => {
    // The window is armed for as long as anything is outstanding and is
    // deliberately not reset by an op merely going late. Abandoning the LAST
    // overdue op drains the set without a reply, so the window keeps running
    // with nothing left to convict — and the next op posted cannot install its
    // own. It would then be killed on whatever remained of a budget that was
    // never about it, a fraction of the silence window it is owed.
    const harness = await makeOpenedHarness();
    const abandoned = outcomeOf(harness.client.execute("sessions.getAll", []));
    harness.clock.advance(STORE_INVOKE_DEADLINE_MS);
    await abandoned.done;
    // A second budget of the same size, then the client gives up on it.
    harness.clock.advance(STORE_INVOKE_DEADLINE_MS);
    await Promise.resolve();
    assert.match(harness.logs.at(-1) ?? "", GAVE_UP_LOG);

    // Posted with 1ms left on the window the abandoned op armed.
    const postedAt = 2 * STORE_INVOKE_DEADLINE_MS;
    harness.clock.advance(STORE_UNRESPONSIVE_DEADLINE_MS - postedAt - 1);
    const later = outcomeOf(harness.client.execute(IMPORT_OP, []));
    harness.clock.advance(1);
    await Promise.resolve();
    assert.deepEqual(
      harness.deaths,
      [],
      "an op posted 1ms ago has not gone silent"
    );

    // Re-armed, not disabled: the store is still convicted for going silent,
    // measured from the later op's OWN post.
    harness.clock.advance(STORE_UNRESPONSIVE_DEADLINE_MS - 1);
    await later.done;
    assert.equal(harness.deaths.length, 1);
    assert.match(harness.deaths[0], UNRESPONSIVE_DEATH);
  });

  it("spares a store that answered something, however late", async () => {
    // The other half: a store still producing correlated replies is slow, not
    // wedged, and must not be killed for it. Without this the silence clock
    // would just be `die()` on a longer fuse.
    const harness = await makeOpenedHarness();
    const first = outcomeOf(harness.client.execute("sessions.getAll", []));
    harness.clock.advance(STORE_INVOKE_DEADLINE_MS - 1);
    const second = harness.client.execute("dashboard.getTools", []);

    harness.clock.advance(1);
    await first.done;
    assert.match(String(first.settled), DEADLINE_REJECTION);

    // A reply for the OTHER op proves the thread is alive; the clock restarts.
    harness.emit({
      kind: DbStoreResponseKind.Result,
      id: 2,
      ok: true,
      value: "tools",
    });
    assert.equal(await second, "tools");

    harness.clock.advance(STORE_UNRESPONSIVE_DEADLINE_MS - 1);
    await Promise.resolve();
    assert.deepEqual(harness.deaths, []);
  });
});

describe("ISS-8773: the deadline values themselves", () => {
  it("pins each budget against an independently written literal", () => {
    // Written out rather than derived from the module under test: ISS-8773 was
    // FILED asserting `loadSyncedSessions` runs on STORE_HEAVY_DEADLINE_MS and
    // that that constant is 300000ms. It is not — 300000 is the GENERIC invoke
    // budget, and the op is generic. A test that recomputed these from the
    // module would have agreed with whatever the module said.
    assert.equal(STORE_INVOKE_DEADLINE_MS, 300_000);
    assert.equal(STORE_HEAVY_DEADLINE_MS, 3_600_000);
    // The silence window is the wall clock the client already tolerates for an
    // op posted behind a heavy one, so it can never convict a store that is
    // merely finishing its longest legal work.
    assert.equal(STORE_UNRESPONSIVE_DEADLINE_MS, 3_900_000);
  });
});

/**
 * ISS-9197 — the OPEN deadline, which is the one bounded wait here whose trip is
 * no longer final.
 *
 * It belongs in this file because it is the same question the file already
 * answers ("what does a bounded wait do when it expires") driven through the
 * same harness. What is new is that the ANSWER now has to survive a hop: the
 * message minted here crosses the utilityProcess boundary rebuilt as a plain
 * `Error`, and the boot path retries or terminates on whether it can still
 * recognise it. Asserting the predicate against the REAL producer is what keeps
 * the two from drifting — a suite that hand-built the string would stay green
 * through a rename of the token on either side.
 */
describe("ISS-9197: the store-open deadline is a distinct classification", () => {
  it("rejects with a message the boot path reads as a timeout", async () => {
    const harness = makeHarness();
    // The synthetic slow open, and the whole of AC4: a store thread that simply
    // never answers `Opened`. No database is involved — growing a real store past
    // the ceiling is the reproduction this replaces.
    const open = harness.client.open({
      dataDir: "/tmp/db-store-open-deadline",
    });
    let settled = false;
    const outcome = open.then(
      (): unknown => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );

    harness.clock.advance(STORE_OPEN_DEADLINE_MS - 1);
    await Promise.resolve();
    assert.equal(
      settled,
      false,
      "the open must survive right up to its deadline; a shorter wait would fail a legal open"
    );

    harness.clock.advance(1);
    const error = await outcome;

    assert.ok(
      isStoreOpenTimeoutError(error),
      "the boot path cannot retry a timeout it cannot recognise"
    );
    // Unchanged by ISS-9197, and asserted so it stays that way: the renderer's
    // read boundary classifies this by the lifecycle signature `storeDeathError`
    // prefixes, and the new predicate is a second axis over the same message
    // rather than a replacement for that one.
    assert.ok(isTransientDbHostError(error));
  });

  it("does NOT read a deterministic store death as a timeout", async () => {
    // The counterfactual this pair exists for. Collapse the two paths — widen
    // the predicate to any store death, or drop the token from the producer and
    // match the lifecycle prefix instead — and this case goes red while the one
    // above stays green. A corrupt store must still terminate on its first
    // failure; retrying it is the crash loop the terminal-no-retry policy was
    // written to avoid.
    const harness = makeHarness();
    const open = harness.client.open({ dataDir: "/tmp/db-store-open-corrupt" });
    const outcome = open.then(
      () => null,
      (error: unknown) => error
    );
    harness.emitError(
      new Error("SQLITE_CORRUPT: database disk image is malformed")
    );
    const error = await outcome;

    assert.equal(
      isStoreOpenTimeoutError(error),
      false,
      "a store that died on its own contents must not be retried as a timeout"
    );
  });
});
