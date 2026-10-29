/**
 * @file db-host-shutdown-drain.test.ts
 * @description ISS-4713 — the db-host shutdown must be a bounded-but-clean drain.
 *
 * On quit the app used to force-kill the db-host utilityProcess while
 * outbox-clear / sync writes were still in flight, which left the SQLite store
 * with `*.wedged-*` / `*.pgdata.corrupt-*` artifacts and could wedge the next
 * boot (logs: `failed to clear N acked outbox row(s): db-host exited`,
 * `sync failed: db-host exited`). db-host exits DURING an intentional shutdown
 * were also mislabeled "exited unexpectedly" and could schedule a restart
 * mid-shutdown.
 *
 * These legs are pinned here, all with an injected timer (no wall-clock waits),
 * per the test:node determinism rules:
 *
 *  1. close() awaits the in-flight Invoke tail (their SQLite writes commit)
 *     BEFORE it sends Close / kills the child.
 *  2. The drain is BOUNDED — a wedged in-flight op does not hold shutdown open
 *     past CLOSE_DRAIN_TIMEOUT_MS; close() proceeds to Close + kill anyway.
 *  3. A db-host `exit` during the intentional shutdown window (beginClosing() /
 *     close()) is NOT relabeled "unexpected" and does NOT schedule a restart.
 *  4. The drain timer is cleared on the clean-settle path (no dangling timer).
 *  5. ISS-9839 / ISS-9914 — the ONE exception to the `closing` refusal: the
 *     terminal flushes `db-host-shutdown-admission.ts` names are admitted
 *     while `closing` and drained like any in-flight write; they are refused
 *     once the client is `closed` or its child is gone. Every other op is
 *     still refused.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveIngestStoreProvider } from "../src/main/dashboard/ingest-store-provider.js";
import { createDbHostAgentDatabase } from "../src/main/database/db-host/db-host-agent-database.js";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import { DB_HOST_STORE_OP_PREFIX } from "../src/main/database/db-host/db-host-store-op-registry.js";
import { INGEST_BATCH_RESUME_CURSOR_WRITE_OP } from "../src/main/database/ingest-batch-resume-cursor-store.js";
import type {
  DbHostChildExitListener,
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";

/** Match the "db-host is closing (op: …)" rejection a queued invoke throws. */
const CLOSING_REJECTION = /closing/;
/** Match the "db-host is closed (op: …)" rejection a post-close invoke throws. */
const CLOSED_REJECTION = /db-host is closed/;
/** Match the plain rejection an invoke gets once the child is gone. */
const NOT_RUNNING_REJECTION = /db-host is not running/;
/** The cursor's terminal flush, exactly as the lifecycle's `rawStoreOp` sends it. */
const CURSOR_FLUSH_OP = `${DB_HOST_STORE_OP_PREFIX}${INGEST_BATCH_RESUME_CURSOR_WRITE_OP}`;

type PostedRequest = { kind: string; id?: number; op?: string };

/**
 * A fake forked db-host child capturing the client's exit + message listeners
 * and recording postMessage / kill so a test can assert the shutdown ordering.
 */
function makeFakeChild() {
  const posted: PostedRequest[] = [];
  let exitListener: DbHostChildExitListener | undefined;
  let messageListener: DbHostChildMessageListener | undefined;
  let killed = false;
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "exit") {
        exitListener = args[1];
      }
      if (args[0] === "message") {
        messageListener = args[1];
      }
      return child;
    },
    postMessage(message: PostedRequest) {
      posted.push(message);
    },
    kill() {
      killed = true;
    },
  };
  return {
    child,
    posted,
    isKilled: () => killed,
    exit(code: number | null) {
      exitListener?.(code);
    },
    ready() {
      const initId = posted.find((m) => m.kind === DbHostRequestKind.Init)?.id;
      messageListener?.({ kind: DbHostResponseKind.Ready, id: initId });
    },
    /** Resolve a specific in-flight invoke by its posted id. */
    resolveInvoke(id: number, value: unknown) {
      messageListener?.({
        kind: DbHostResponseKind.Result,
        id,
        ok: true,
        value,
      });
    },
    /** Answer the Close request the client posted (child replies then exits). */
    completeClose() {
      const closeId = posted.find(
        (m) => m.kind === DbHostRequestKind.Close
      )?.id;
      if (closeId !== undefined) {
        messageListener?.({
          kind: DbHostResponseKind.Result,
          id: closeId,
          ok: true,
        });
      }
    },
  };
}

/**
 * Drain microtasks (bounded) until a request of `kind` lands in `posted`. THROWS
 * when the bound is exhausted (no silent fall-through, per the test:node
 * determinism rules) so a regression that never posts the request fails fast.
 */
async function waitForPosted(
  posted: PostedRequest[],
  kind: string,
  maxTurns = 50
): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn++) {
    if (posted.some((m) => m.kind === kind)) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(
    `request "${kind}" was never posted within the microtask bound`
  );
}

/** id of the last posted Invoke, or throws (no silent fall-through). */
function lastInvokeId(posted: PostedRequest[]): number {
  const id = posted
    .filter((m) => m.kind === DbHostRequestKind.Invoke)
    .at(-1)?.id;
  if (id === undefined) {
    throw new Error("no Invoke was posted to the child");
  }
  return id;
}

type FakeTimerHandle = { fn: () => void; ms: number };

/**
 * A controllable fake timer supporting multiple concurrent handles — close()
 * arms both a drain budget AND (ISS-4713) a Close-acknowledgement budget, so a
 * single-slot fake would lose one. `fire()` fires every armed handle; `isArmed`
 * and `wasCleared` report the aggregate so a test can assert no dangling timer.
 */
function makeFakeTimer() {
  const pending = new Set<FakeTimerHandle>();
  let cleared = false;
  const setTimeoutFn = ((fn: () => void, ms?: number) => {
    const handle: FakeTimerHandle = { fn, ms: ms ?? 0 };
    pending.add(handle);
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((handle?: unknown) => {
    cleared = true;
    if (handle) {
      pending.delete(handle as FakeTimerHandle);
    }
  }) as unknown as typeof clearTimeout;
  return {
    setTimeoutFn,
    clearTimeoutFn,
    isArmed: () => pending.size > 0,
    armedCount: () => pending.size,
    wasCleared: () => cleared,
    /** Fire every armed handle (a deadline elapsing). */
    fire() {
      const handles = [...pending];
      pending.clear();
      for (const handle of handles) {
        handle.fn();
      }
    },
  };
}

async function startReadyClient(
  timer: ReturnType<typeof makeFakeTimer>,
  onLog: (message: string) => void = () => {}
) {
  const fake = makeFakeChild();
  const client = new DbHostClient({
    onEmit: () => {},
    onLog,
    fork: () => fake.child,
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  const started = client.start({ dataDir: "/tmp/db" });
  fake.ready();
  await started;
  return { client, fake };
}

test("close() drains the in-flight write, then Close + kill — not killed mid-write", async () => {
  const timer = makeFakeTimer();
  const { client, fake } = await startReadyClient(timer);

  // A representative write (outbox-clear / sync) is in flight when quit begins.
  const write = client.invoke("prisma.write", []);
  await Promise.resolve();
  const writeId = lastInvokeId(fake.posted);

  // Begin the shutdown close. It must NOT kill the child while the write is
  // still pending — the whole point of the clean drain.
  const closing = client.close();
  await Promise.resolve();
  assert.equal(
    fake.isKilled(),
    false,
    "child not killed while a write is still in flight"
  );
  assert.ok(
    !fake.posted.some((m) => m.kind === DbHostRequestKind.Close),
    "Close is not sent until the in-flight write settles"
  );

  // The write commits and replies. NOW close() may proceed to Close + kill.
  fake.resolveInvoke(writeId, undefined);
  assert.equal(await write, undefined, "the in-flight write resolved cleanly");
  // close() posts Close only after the drain settles (a few microtask hops);
  // wait for it before answering so the answer can't race ahead of the request.
  await waitForPosted(fake.posted, DbHostRequestKind.Close);
  fake.completeClose();
  await closing;

  assert.ok(
    fake.posted.some((m) => m.kind === DbHostRequestKind.Close),
    "Close was sent after the drain"
  );
  assert.equal(
    fake.isKilled(),
    true,
    "child killed only after the clean drain"
  );
  // Clean-settle path clears the drain budget — no dangling timer.
  assert.equal(timer.wasCleared(), true, "the drain timer was cleared");
});

test("close() is bounded: a wedged write cannot hold shutdown past the budget", async () => {
  const logs: string[] = [];
  const timer = makeFakeTimer();
  const { client, fake } = await startReadyClient(timer, (m) => logs.push(m));

  // A write that never replies (a wedged lane) is in flight at quit.
  const wedged = client.invoke("prisma.write", []);
  wedged.catch(() => undefined); // it rejects when the child is killed; handled.
  await Promise.resolve();

  const closing = client.close();
  await Promise.resolve();
  assert.equal(timer.isArmed(), true, "the bounded drain budget is armed");
  assert.equal(
    fake.isKilled(),
    false,
    "not yet killed — the drain budget is still counting down"
  );

  // The budget elapses. close() must PROCEED to Close + kill despite the wedged
  // op rather than awaiting it forever.
  timer.fire();
  await waitForPosted(fake.posted, DbHostRequestKind.Close);
  fake.completeClose();
  await closing;

  assert.equal(fake.isKilled(), true, "child killed after the drain budget");
  assert.ok(
    logs.some((m) => m.includes("drain hit its") && m.includes("budget")),
    "the drain-budget log names the bounded proceed-to-close path"
  );
});

test("a db-host exit during close()'s drain is not relabeled unexpected / restarted", async () => {
  const logs: string[] = [];
  let spawnCount = 0;
  const first = makeFakeChild();
  const timer = makeFakeTimer();
  const client = new DbHostClient({
    onEmit: () => {},
    onLog: (m) => logs.push(m),
    fork: () => {
      spawnCount++;
      return first.child;
    },
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  const started = client.start({ dataDir: "/tmp/db" });
  first.ready();
  await started;
  assert.equal(spawnCount, 1);

  // A write is in flight; close() begins its drain.
  const write = client.invoke("prisma.write", []);
  write.catch(() => undefined);
  await Promise.resolve();
  const closing = client.close();
  await Promise.resolve();

  // The child exits mid-drain (its own crash, or an OS kill during teardown).
  // Because we are intentionally closing, this must NOT be logged as
  // "exited unexpectedly" and must NOT schedule a restart / re-fork.
  first.exit(1);
  await closing;

  assert.equal(
    spawnCount,
    1,
    "no restart re-fork was scheduled during shutdown"
  );
  assert.ok(
    !logs.some((m) => m.includes("exited unexpectedly")),
    "an intentional-shutdown exit is not relabeled unexpected"
  );
  assert.ok(
    !logs.some((m) => m.includes("restarting in")),
    "no mid-shutdown restart was announced"
  );
});

test("an invoke queued on `ready` when close() runs is drained and never posts into the closing child", async () => {
  // T2: invoke() passed the closed check and is queued on `ready` (a restart is
  // in flight), so it has not yet registered in `pending`. close() must still
  // account for it (it is tracked from call entry), and its readiness
  // continuation must observe `closing` and settle WITHOUT posting a fresh Invoke
  // into the child close() is about to Close/kill.
  const children = [makeFakeChild(), makeFakeChild()];
  let spawnCount = 0;
  const timer = makeFakeTimer();
  const client = new DbHostClient({
    onEmit: () => {},
    onLog: () => {},
    fork: () => children[spawnCount++]?.child ?? children[0].child,
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  const started = client.start({ dataDir: "/tmp/db" });
  children[0].ready();
  await started;

  // Crash the child so `ready` becomes pending again (a restart backoff is armed
  // but we never fire it — `ready` stays unresolved, modelling the queued window).
  children[0].exit(11);
  await Promise.resolve();

  // A late invoke arrives while `ready` is pending: it is accepted and TRACKED,
  // but queued on `ready` — no Invoke is posted to any child yet.
  const invokeCountBefore = children[1].posted.length;
  const queued = client.invoke("prisma.write", []);
  queued.catch(() => undefined);
  await Promise.resolve();

  // Shutdown begins. close() drains the tracked queued invoke; because it is
  // still on `ready`, the continuation observes `closing` and rejects it without
  // posting an Invoke. clearRestartTimer() (inside close) settles `ready`. The
  // child already exited (crash above), so there is nothing left to Close/kill —
  // close() resolves cleanly once the tracked invoke settles.
  const closing = client.close();
  // The queued invoke must reject as closing — not resolve, not post an Invoke.
  await assert.rejects(queued, CLOSING_REJECTION);
  await closing;
  assert.equal(
    children[1].posted.filter((m) => m.kind === DbHostRequestKind.Invoke)
      .length,
    invokeCountBefore,
    "no Invoke was posted into a child during shutdown"
  );
  assert.equal(
    client.pendingRequestCount,
    0,
    "no correlated request was left parked"
  );
});

test("close() is bounded on the Close ack too: a wedged child is killed on the ack budget", async () => {
  const logs: string[] = [];
  const timer = makeFakeTimer();
  const { client, fake } = await startReadyClient(timer, (m) => logs.push(m));

  // No in-flight writes — the drain is a no-op, so close() goes straight to
  // posting Close. The child's Close handler is wedged (draining its own write
  // queue) and never replies. The Close-ack budget must still kill the child.
  const closing = client.close();
  await waitForPosted(fake.posted, DbHostRequestKind.Close);
  assert.equal(
    fake.isKilled(),
    false,
    "not killed while the Close-ack budget is still counting down"
  );
  assert.equal(timer.isArmed(), true, "the Close-ack budget is armed");

  // The ack budget elapses without any Close reply from the child. close() must
  // fall through to kill the child rather than hang forever.
  timer.fire();
  await closing;

  assert.equal(
    fake.isKilled(),
    true,
    "child killed after the Close-ack budget even though it never replied"
  );
  assert.ok(
    logs.some(
      (m) =>
        m.includes("Close acknowledgement not received") &&
        m.includes("killing")
    ),
    "the Close-ack-timeout log names the kill-anyway path"
  );
  assert.equal(
    client.pendingRequestCount,
    0,
    "the parked Close entry was dropped"
  );
});

test("beginClosing() while a restart backoff is pending aborts the re-fork (timer not yet fired)", async () => {
  // T1 leg A: crash → restart timer ARMED but not yet fired → beginClosing()
  // cancels it before it can re-fork.
  const children = [makeFakeChild(), makeFakeChild()];
  let spawnCount = 0;
  const timer = makeFakeTimer();
  const client = new DbHostClient({
    onEmit: () => {},
    onLog: () => {},
    fork: () => children[spawnCount++]?.child ?? children[0].child,
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  const started = client.start({ dataDir: "/tmp/db" });
  children[0].ready();
  await started;
  assert.equal(spawnCount, 1);

  // Unexpected crash arms the restart-backoff timer through the injected timer.
  children[0].exit(11);
  await Promise.resolve();
  assert.equal(timer.isArmed(), true, "the restart-backoff timer is armed");

  // Shutdown begins before the backoff fires; the armed timer must be cancelled.
  client.beginClosing();
  assert.equal(
    timer.isArmed(),
    false,
    "beginClosing() cancels the armed restart timer"
  );

  // Firing any leftover handle must not re-fork.
  timer.fire();
  await Promise.resolve();
  assert.equal(
    spawnCount,
    1,
    "no re-fork after beginClosing() cancelled the restart"
  );
});

test("a restart spawn that RESOLVES after beginClosing() kills the just-forked child", async () => {
  // T1 leg B: the reviewer's exact case — the backoff already FIRED, attempt()
  // called spawn(), and the replacement child's Init is awaiting Ready. Shutdown
  // begins in that window. beginClosing() only clears an ARMED timer (there is
  // none now — it already fired), so the resolve path itself must honor `closing`
  // and tear the freshly-forked child down instead of letting it survive.
  const children = [makeFakeChild(), makeFakeChild()];
  let spawnCount = 0;
  const timer = makeFakeTimer();
  const client = new DbHostClient({
    onEmit: () => {},
    onLog: () => {},
    fork: () => children[spawnCount++]?.child ?? children[0].child,
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  const started = client.start({ dataDir: "/tmp/db" });
  children[0].ready();
  await started;

  // Crash → backoff timer arms → FIRE it so attempt() runs spawn() on child[1].
  children[0].exit(11);
  await Promise.resolve();
  timer.fire();
  await Promise.resolve();
  assert.equal(spawnCount, 2, "attempt() forked the replacement child");
  assert.equal(
    children[1].isKilled(),
    false,
    "replacement child alive while its Init is pending"
  );

  // Shutdown begins WHILE the replacement's Init is still pending (its timer
  // already fired, so there is nothing for beginClosing() to cancel).
  client.beginClosing();
  // The replacement now reports Ready — spawn() resolves DURING the closing
  // window. The resolve branch must kill it rather than let it run into teardown.
  children[1].ready();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    children[1].isKilled(),
    true,
    "a spawn resolving during shutdown tears the just-forked child down"
  );
});

test("beginClosing() before an exit suppresses the unexpected-relabel and restart", async () => {
  const logs: string[] = [];
  let spawnCount = 0;
  const first = makeFakeChild();
  const timer = makeFakeTimer();
  const client = new DbHostClient({
    onEmit: () => {},
    onLog: (m) => logs.push(m),
    fork: () => {
      spawnCount++;
      return first.child;
    },
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  const started = client.start({ dataDir: "/tmp/db" });
  first.ready();
  await started;

  // The app opens the intentional-shutdown window BEFORE tearing down the sync
  // services — a db-host exit from here is expected.
  client.beginClosing();
  first.exit(11); // e.g. a SIGSEGV-mapped exit during teardown

  assert.equal(spawnCount, 1, "beginClosing() suppresses the restart re-fork");
  assert.ok(
    !logs.some((m) => m.includes("exited unexpectedly")),
    "beginClosing() suppresses the unexpected relabel"
  );
});

test("ISS-9839: `closing` admits a terminal flush and still refuses an ordinary op — `closed` refuses both", async () => {
  const timer = makeFakeTimer();
  const { client, fake } = await startReadyClient(timer);

  // The app opens the intentional-shutdown window FIRST and only then tears down
  // the capture services (desktop-application-shutdown.ts). Everything the
  // teardown then issues arrives here.
  client.beginClosing();

  // The ordinary op is issued FIRST: a gate that admitted it would have posted
  // it ahead of the terminal flush, so "never posted" is read off the post
  // order rather than off a wait for something that did not happen.
  const ordinary = client.invoke("prisma.write", []);
  // Handle the refusal at creation: it rejects a microtask later, and any
  // macrotask hop before the assertion would surface it as unhandled.
  const ordinaryRefused = assert.rejects(ordinary, CLOSING_REJECTION);
  const terminal = client.invoke(CURSOR_FLUSH_OP, []);
  fake.resolveInvoke(await waitForInvokeOp(fake.posted, CURSOR_FLUSH_OP), null);
  assert.equal(
    await terminal,
    null,
    "the terminal flush committed in the child"
  );
  assert.deepEqual(
    invokeOps(fake.posted),
    [CURSOR_FLUSH_OP],
    "the ordinary op never reached the child"
  );
  await ordinaryRefused;

  // close() drains, acknowledges and kills. Past that point the drain has been
  // accounted for and the child is gone, so a terminal flush refuses too.
  const closing = client.close();
  await waitForPosted(fake.posted, DbHostRequestKind.Close);
  fake.completeClose();
  await closing;
  await assert.rejects(
    client.invoke(CURSOR_FLUSH_OP, []),
    CLOSED_REJECTION,
    "a terminal flush is not a licence to write into a CLOSED client"
  );
});

test("ISS-9914: a terminal flush issued inside the window is drained before Close — never killed mid-write", async () => {
  const timer = makeFakeTimer();
  const { client, fake } = await startReadyClient(timer);
  client.beginClosing();
  const terminal = client.invoke(CURSOR_FLUSH_OP, []);
  const terminalId = await waitForInvokeOp(fake.posted, CURSOR_FLUSH_OP);

  const closing = client.close();
  await Promise.resolve();
  assert.equal(
    fake.isKilled(),
    false,
    "child not killed while the terminal flush is in flight"
  );
  assert.ok(
    !fake.posted.some((m) => m.kind === DbHostRequestKind.Close),
    "Close is not sent until the terminal flush settles"
  );

  fake.resolveInvoke(terminalId, null);
  assert.equal(await terminal, null, "the terminal flush landed");
  await waitForPosted(fake.posted, DbHostRequestKind.Close);
  fake.completeClose();
  await closing;
  assert.equal(
    fake.isKilled(),
    true,
    "child killed only after the flush landed"
  );
});

test("ISS-9914: a terminal flush cannot outlive the host — a child already gone refuses it and nothing re-forks", async () => {
  let spawnCount = 0;
  const fake = makeFakeChild();
  const timer = makeFakeTimer();
  const client = new DbHostClient({
    onEmit: () => {},
    onLog: () => {},
    fork: () => {
      spawnCount++;
      return fake.child;
    },
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  const started = client.start({ dataDir: "/tmp/db" });
  fake.ready();
  await started;

  client.beginClosing();
  // The child goes away inside the window — its own exit, or the OS.
  fake.exit(0);

  await assert.rejects(
    client.invoke(CURSOR_FLUSH_OP, []),
    NOT_RUNNING_REJECTION
  );
  assert.deepEqual(
    invokeOps(fake.posted),
    [],
    "nothing was posted into the dead child"
  );
  assert.equal(spawnCount, 1, "admitting the flush did not re-fork the host");
});

test("ISS-9914: the teardown's ingest-store flush crosses a closing client through the real proxy — an ordinary proxied op does not", async () => {
  const timer = makeFakeTimer();
  const { client, fake } = await startReadyClient(timer);
  const agentDatabase = createDbHostAgentDatabase(client);
  const logs: string[] = [];
  const hydrating = resolveIngestStoreProvider({
    database: agentDatabase,
    log: (message) => {
      logs.push(message);
    },
  });
  fake.resolveInvoke(
    await waitForInvokeOp(fake.posted, "collectorIngestStores.loadAll"),
    []
  );
  const quarantine = (await hydrating).parseQuarantine("claude");

  client.beginClosing();

  // Issued first for the same post-order reason as the ISS-9839 case above.
  const ordinary = agentDatabase.sessions.count();
  const ordinaryRefused = assert.rejects(ordinary, CLOSING_REJECTION);
  const saved = quarantine.save({
    version: 1,
    entries: { "/poison.jsonl": { attempts: 3 } },
  });
  fake.resolveInvoke(
    await waitForInvokeOp(fake.posted, "collectorIngestStores.save"),
    null
  );
  assert.equal(await saved, true, "the quarantine flush was accepted");
  assert.deepEqual(
    logs,
    [],
    "no `write failed` line on the monitored collector channel"
  );
  assert.equal(
    invokeOps(fake.posted).includes("sessions.count"),
    false,
    "the ordinary op never reached the child"
  );
  await ordinaryRefused;
});

/** Ops of every Invoke posted to the child, in post order. */
function invokeOps(posted: PostedRequest[]): (string | undefined)[] {
  return posted
    .filter((m) => m.kind === DbHostRequestKind.Invoke)
    .map((m) => m.op);
}

/**
 * Drain microtasks (bounded) until an Invoke for `op` is posted, and return its
 * id. THROWS when the bound is exhausted, like {@link waitForPosted}.
 */
async function waitForInvokeOp(
  posted: PostedRequest[],
  op: string,
  maxTurns = 50
): Promise<number> {
  for (let turn = 0; turn < maxTurns; turn++) {
    const id = posted.find(
      (m) => m.kind === DbHostRequestKind.Invoke && m.op === op
    )?.id;
    if (id !== undefined) {
      return id;
    }
    await Promise.resolve();
  }
  throw new Error(
    `no Invoke for "${op}" was posted within the microtask bound`
  );
}
