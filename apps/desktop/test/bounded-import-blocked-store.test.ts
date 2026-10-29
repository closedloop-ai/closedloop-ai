/**
 * @file bounded-import-blocked-store.test.ts
 * @description ISS-7256 (whitlockk review) — the re-arm, proven over the real proxy,
 * with the store thread genuinely blocked.
 *
 * The review finding this answers: "The DB-host path cannot answer this while the
 * store thread is inside the long synchronous write that put this session in the
 * queue. `hasUndispatchedWrite` waits 5s, resolves false, and takes the old
 * expiry path, so the production topology still drops the waiter."
 *
 * That was correct, and the unit coverage in `bounded-import-session.test.ts`
 * could not have caught it: it hands `importSessionBounded` a synthetic importer
 * that answers instantly, which is exactly the topology the defect is NOT in. So
 * this suite assembles the real path instead —
 *
 *   `importSessionBounded`
 *     → `createDbHostAgentDatabase` (the real property-path proxy)
 *     → `DbHostClient.invoke` (the real correlation + IPC post)
 *     → `dispatchDbHostInvoke` (the real dispatch, real `createDbHostOpLanes`)
 *     → `createWriteDispatchMirror` (the real mirror)
 *
 * — and models the store thread the only way that makes the test mean anything:
 * `runOnStore` NEVER settles. Nothing that has to reach the store can be answered
 * for the whole test, which is precisely the window the bound asks its question
 * in. A fake store that answered would prove nothing, because the bug was that
 * the real one does not.
 *
 * The counterfactual that makes this a real guard: route the probe through
 * `runOnStore` (delete the dispatcher-local branch) and the re-arm assertion goes
 * red — no answer arrives, the caller's `IMPORT_EVICTION_CLASSIFY_TIMEOUT_MS`
 * backstop fires, and the bound expires. Which is the shipped behavior whitlockk was
 * describing.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { importSessionBounded } from "../src/main/collectors/engine/bounded-import-session.js";
import type { Importer } from "../src/main/dashboard/agent-dashboard-db-types.js";
import { createDbHostAgentDatabase } from "../src/main/database/db-host/db-host-agent-database.js";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  type DbHostInvokeDeps,
  dispatchDbHostInvoke,
} from "../src/main/database/db-host/db-host-invoke-dispatch.js";
import { createDbHostOpLanes } from "../src/main/database/db-host/db-host-op-lanes.js";
import {
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import { createWriteDispatchMirror } from "../src/main/database/db-host/write-dispatch-mirror.js";
import {
  type WriteDispatchProbe,
  WriteDispatchState,
  WriteQueueCancelOutcome,
  WriteQueueTaskPhase,
} from "../src/main/database/write-queue.js";
import type { DbHostChildListenerArgs } from "./db-host-fake-child-support.js";
import { deferred } from "./deferred.js";
import { makeSession } from "./normalized-session-test-utils.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

const TIMEOUT_MS = 1000;
const HARNESS = "claude";
const SOURCE = "/tmp/source.jsonl";
const SESSION_ID = "queued-behind-a-blocked-store";
const REARM_LOG_PATTERN = /without its write dispatching/;
const UNMARKED_LOG_PATTERN = /left unmarked/;

/**
 * The fallback if the proxy ever answered `undefined` for the hook.
 *
 * `Absent` and not `Queued`, so a broken proxy path makes the re-arm assertion
 * FAIL rather than pass on a fabricated answer.
 */
const UNANSWERED_PROBE: WriteDispatchProbe = {
  state: WriteDispatchState.Absent,
  taskSeq: null,
};

type BlockedStoreHarness = {
  client: DbHostClient;
  /**
   * An importer whose optional hooks go through the REAL db-host proxy, with
   * `importSession` supplied by the test.
   *
   * Written as an explicit get-then-apply delegation rather than a spread of the
   * proxy: the proxy's `get` trap answers every path, but it traps nothing else,
   * so spreading it yields an EMPTY object and the hook under test would silently
   * not exist. `import-health-telemetry.ts` forwards the same way, for the same
   * reason.
   */
  importerWith: (importSession: Importer["importSession"]) => Importer;
  /** Ops the dispatcher forwarded to the (blocked, never-answering) store. */
  forwardedToStore: string[];
  /** Tell the mirror what the store's write queue did before it blocked. */
  observe: (phase: WriteQueueTaskPhase, taskSeq: number) => void;
  dispose: () => void;
};

/**
 * The real main → dispatcher path, with a store thread that answers nothing.
 *
 * The dispatcher half runs inside the fake child's `postMessage`, which is where
 * the production worker's `parentPort` listener would call the same function.
 */
function blockedStoreHarness(): BlockedStoreHarness {
  const forwardedToStore: string[] = [];
  const mirror = createWriteDispatchMirror();
  const lanes = createDbHostOpLanes();
  let messageListener: ((message: unknown) => void) | undefined;

  const deps = (id: number): DbHostInvokeDeps => ({
    lanes,
    isOpen: () => true,
    // THE BLOCKED STORE. `@libsql/client` executes synchronously, so while the
    // store thread is inside a statement its loop does not turn and an `Execute`
    // waiting on the inner port is picked up by nobody. A promise that never
    // settles is that, exactly.
    runOnStore: (op: string) => {
      forwardedToStore.push(op);
      return new Promise<unknown>(() => undefined);
    },
    probeUndispatchedWrite: (token: string) => mirror.probe(token),
    getInsights: () =>
      Promise.reject(new Error("no insights op in this suite")),
    deliver: (value: unknown) =>
      messageListener?.({
        kind: DbHostResponseKind.Result,
        id,
        ok: true,
        value,
      }),
  });

  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "message") {
        messageListener = args[1];
      }
      return child;
    },
    postMessage(message: {
      kind: string;
      id?: number;
      op?: string;
      args?: unknown[];
    }) {
      if (message.kind === DbHostRequestKind.Init) {
        messageListener?.({ kind: DbHostResponseKind.Ready, id: message.id });
        return;
      }
      if (message.kind !== DbHostRequestKind.Invoke) {
        return;
      }
      const id = message.id ?? 0;
      dispatchDbHostInvoke(
        message.op ?? "",
        message.args ?? [],
        deps(id)
      ).catch((error: unknown) =>
        messageListener?.({
          kind: DbHostResponseKind.Result,
          id,
          ok: false,
          error: { message: String(error) },
        })
      );
    },
    kill() {
      // no-op for the fake
    },
  };

  const client = new DbHostClient({
    onEmit: () => undefined,
    onLog: () => undefined,
    fork: () => child,
  });

  // The production importer in DB-host mode is exactly this proxy — no
  // hand-written stand-in, so the `importer.hasUndispatchedWrite` op path is the
  // one the proxy really builds.
  const proxied = createDbHostAgentDatabase(client).importer;

  return {
    client,
    importerWith: (importSession) => ({
      importSession,
      hasUndispatchedWrite: (sessionId) =>
        proxied.hasUndispatchedWrite?.(sessionId) ?? UNANSWERED_PROBE,
      cancelInFlightWrite: (sessionId, reason) =>
        proxied.cancelInFlightWrite?.(sessionId, reason) ??
        WriteQueueCancelOutcome.None,
    }),
    forwardedToStore,
    observe: (phase, taskSeq) => mirror.observe(SESSION_ID, phase, taskSeq),
    dispose: () => {
      client.close().catch(() => undefined);
    },
  };
}

beforeEach(() => {
  nodeTestTimers.enable(["setTimeout"]);
});

afterEach(() => {
  nodeTestTimers.reset();
});

test("ISS-7256 (whitlockk): the re-arm arrives over the proxy while the store thread is blocked", async () => {
  const harness = blockedStoreHarness();
  await harness.client.start({ dataDir: "/tmp/agent-dashboard" });

  // What the store's write queue reported BEFORE it blocked: this session's
  // write is enqueued and has never dispatched. That notice is what the
  // dispatcher still holds while the thread that sent it is parked.
  harness.observe(WriteQueueTaskPhase.Queued, 9);

  const wedged = deferred<never>();
  const logs: string[] = [];
  const pending = importSessionBounded(
    // The import itself is the thing waiting on the blocked store, so it never
    // returns for the whole test — as it would not in production.
    harness.importerWith(() => wedged.promise),
    (message) => logs.push(message),
    makeSession({ sessionId: SESSION_ID }),
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );

  nodeTestTimers.tick(TIMEOUT_MS);
  // Let the probe cross main → dispatcher → main. Deliberately NOT advanced past
  // `IMPORT_EVICTION_CLASSIFY_TIMEOUT_MS`: the point is that the answer arrives
  // on its own, not that a backstop rescued it.
  for (let turn = 0; turn < 10; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(
    logs.filter((message) => REARM_LOG_PATTERN.test(message)).length,
    1,
    "the bound was granted more waiting — the answer reached it with the store blocked"
  );
  assert.equal(
    logs.filter((message) => UNMARKED_LOG_PATTERN.test(message)).length,
    0,
    "and the source was NOT skipped, which is the ISS-7256 defect"
  );
  assert.deepEqual(
    harness.forwardedToStore,
    [],
    "nothing was forwarded: an op that reached the blocked store could not have answered"
  );

  pending.catch(() => undefined);
  harness.dispose();
});

/**
 * The same path, with the mirror reporting a DISPATCHED write. The ISS-4410 wedge
 * must still trip at the first bound — a dispatcher-local answer must not become
 * a way for every timed-out session to buy extra windows.
 */
test("ISS-7256: over the same proxy, a DISPATCHED write is not granted a re-arm", async () => {
  const harness = blockedStoreHarness();
  await harness.client.start({ dataDir: "/tmp/agent-dashboard" });

  harness.observe(WriteQueueTaskPhase.Queued, 9);
  harness.observe(WriteQueueTaskPhase.Dispatched, 9);

  const wedged = deferred<never>();
  const logs: string[] = [];
  const pending = importSessionBounded(
    harness.importerWith(() => wedged.promise),
    (message) => logs.push(message),
    makeSession({ sessionId: SESSION_ID }),
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );

  nodeTestTimers.tick(TIMEOUT_MS);
  for (let turn = 0; turn < 10; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(
    logs.filter((message) => REARM_LOG_PATTERN.test(message)).length,
    0,
    "this session's own write held the writer, so it earns nothing"
  );

  pending.catch(() => undefined);
  harness.dispose();
});
