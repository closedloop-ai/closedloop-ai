/**
 * @file db-host-bounce-containment.test.ts
 * @description ISS-4474 — a db-host bounce during Claude backfill must stay
 * contained and MUST NOT cascade to a fatal `just desktop-dev` termination.
 *
 * Two legs are pinned here:
 *
 *  1. The dev launcher's exit containment (`resolveLauncherExitCode`): when a
 *     spawned child (Electron main or a build step) dies BY SIGNAL, the launcher
 *     must exit with a conventional numeric status (`128 + n`) rather than
 *     re-raising the fatal signal on itself. Re-raising was the cascade — it
 *     propagated a fatal signal up to the `just` recipe (the observed
 *     `terminated by signal 1` + TTY I/O error).
 *
 *  2. The DbHostClient supervisor: a child `exit` mid-op schedules a re-fork
 *     WITHOUT propagating the exit as a throw to the parent, and a `close()`
 *     issued while a restart is still in its backoff window cancels the pending
 *     restart timer so no re-fork fires against a closed client.
 *
 * Timers are driven with node:test mock timers / a captured-handle timer spy —
 * no wall-clock waits — per the test:node determinism rules.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleBuildStepExit,
  handleElectronExit,
  resolveLauncherExitCode,
} from "../scripts/dev-launch-exit.mjs";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import type {
  DbHostChildExitListener,
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

/** The rejection message handleExit gives a pending invoke when the child dies. */
const DB_HOST_EXITED_RE = /db-host exited/;

/**
 * A fake forked db-host child that captures the client's exit + message
 * listeners and records that it was spawned (so a test can assert a re-fork).
 */
function makeFakeChild() {
  const posted: { kind: string; id?: number }[] = [];
  let exitListener: DbHostChildExitListener | undefined;
  let messageListener: DbHostChildMessageListener | undefined;
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
    postMessage(message: { kind: string; id?: number }) {
      posted.push(message);
    },
    kill() {
      // no-op for the fake
    },
  };
  return {
    child,
    posted,
    /** Deliver a child exit through the client's registered listener. */
    exit(code: number | null) {
      exitListener?.(code);
    },
    /** Complete the child's pending init reply so start()/restart resolves. */
    ready() {
      const initId = posted.find((m) => m.kind === DbHostRequestKind.Init)?.id;
      messageListener?.({ kind: DbHostResponseKind.Ready, id: initId });
    },
    /** Reject the child's pending init reply (drives spawn() rejection). */
    failInit(message: string) {
      const initId = posted.find((m) => m.kind === DbHostRequestKind.Init)?.id;
      messageListener?.({
        kind: DbHostResponseKind.Ready,
        id: initId,
        error: { message },
      });
    },
    /** Resolve the last invoke posted to this child with a serialized value. */
    resolveLastInvoke(value: unknown) {
      const invokeId = posted
        .filter((m) => m.kind === DbHostRequestKind.Invoke)
        .at(-1)?.id;
      messageListener?.({
        kind: DbHostResponseKind.Result,
        id: invokeId,
        ok: true,
        value,
      });
    },
  };
}

/**
 * Drain microtasks (bounded) until an Invoke request lands in `posted`. invoke()
 * only posts to the child once the `ready` promise settles — a few microtask
 * hops through the spawn chain — so this waits on the observable posted request
 * rather than counting hops. THROWS if the bound is exhausted (no silent
 * fall-through, per the test:node determinism rules), which also fails fast if a
 * regression leaves the replacement child never usable.
 */
async function waitForPostedInvoke(
  posted: { kind: string }[],
  maxTurns = 50
): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn++) {
    if (posted.some((m) => m.kind === DbHostRequestKind.Invoke)) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(
    "invoke was never posted to the child within the microtask bound — the replacement never became usable"
  );
}

test("launcher exits cleanly (128 + signal) on a child signal death, never re-raising", () => {
  // SIGHUP is the TTY-disconnect signal that drove the observed cascade.
  assert.equal(resolveLauncherExitCode(null, "SIGHUP"), 129);
  assert.equal(resolveLauncherExitCode(null, "SIGTERM"), 143);
  assert.equal(resolveLauncherExitCode(null, "SIGINT"), 130);
  // A signal name absent from os.constants.signals still exits non-zero rather
  // than 0 (never re-raised) — falls back to the generic code, not exit 0.
  assert.equal(resolveLauncherExitCode(null, "SIGNOTAREALSIGNAL"), 1);
});

test("launcher passes a clean child exit code through unchanged", () => {
  assert.equal(resolveLauncherExitCode(0, null), 0);
  assert.equal(resolveLauncherExitCode(3, null), 3);
  // A null code with no signal defaults to a clean exit.
  assert.equal(resolveLauncherExitCode(null, null), 0);
});

test("db-host exit mid-backfill schedules a re-fork without crashing the parent", () => {
  nodeTestTimers.enable(["setTimeout"]);
  try {
    const children = [makeFakeChild(), makeFakeChild()];
    let spawnCount = 0;
    const client = new DbHostClient({
      onEmit: () => {},
      onLog: () => {},
      // Hand out a fresh fake child per fork so the re-fork is observable.
      fork: () => children[Math.min(spawnCount++, children.length - 1)].child,
    });
    // Kick the first spawn (init never resolves without a Ready reply; the
    // listeners are wired synchronously). Swallow the never-resolving promise.
    client.start({ dataDir: "/tmp/db" }).catch(() => undefined);
    assert.equal(spawnCount, 1, "one child forked on start");

    // The child dies mid-backfill (code 0 — killed by the OS/watchdog). This
    // MUST NOT throw out of the exit handler into the parent process.
    assert.doesNotThrow(() => children[0].exit(0));

    // A restart is scheduled on the backoff timer, not fired synchronously.
    assert.equal(
      spawnCount,
      1,
      "no synchronous re-fork inside the exit handler"
    );
    nodeTestTimers.tick(1000);
    assert.equal(spawnCount, 2, "the supervisor re-forked after the backoff");
  } finally {
    nodeTestTimers.reset();
  }
});

test("a mid-backfill bounce fails the in-flight invoke, then service recovers", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  try {
    const children = [makeFakeChild(), makeFakeChild()];
    let spawnCount = 0;
    const client = new DbHostClient({
      onEmit: () => {},
      onLog: () => {},
      fork: () => children[Math.min(spawnCount++, children.length - 1)].child,
    });

    // Complete init on the first child so the client is genuinely ready.
    const started = client.start({ dataDir: "/tmp/db" });
    children[0].ready();
    await started;

    // A representative invoke is in flight (posted to the child, not yet
    // answered) when it bounces. Drain microtasks so the invoke is registered in
    // `pending` — then handleExit must REJECT that pending call, not leave it
    // hanging. This is the "recovered, not just re-forked" contract.
    const inFlight = client.invoke("sessions.count", []);
    await Promise.resolve();
    assert.ok(
      children[0].posted.some((m) => m.kind === DbHostRequestKind.Invoke),
      "the invoke was posted to the child before the bounce"
    );
    children[0].exit(0);
    await assert.rejects(
      inFlight,
      DB_HOST_EXITED_RE,
      "the in-flight invoke rejects on the bounce"
    );

    // The supervisor re-forks after the backoff; make the replacement ready so
    // the restart's ready-promise settles, then wait until that has propagated.
    nodeTestTimers.tick(1000);
    assert.equal(spawnCount, 2, "the supervisor re-forked after the backoff");
    children[1].ready();

    // A post-bounce invoke must now RESOLVE against the healed replacement —
    // proving recovered service, not merely a second fork that never works. The
    // invoke is posted to the child only once `ready` settles (a few microtask
    // hops through the spawn chain), so wait for the posted Invoke before
    // answering it, rather than counting hops.
    const recovered = client.invoke("sessions.count", []);
    await waitForPostedInvoke(children[1].posted);
    children[1].resolveLastInvoke(7);
    assert.equal(await recovered, 7, "a post-bounce invoke resolves");
  } finally {
    nodeTestTimers.reset();
  }
});

test("close() during the restart backoff cancels the pending re-fork", async () => {
  // Track the setTimeout handles armed by the supervisor and the ones close()
  // cancels, so we can pin that close CLEARS the armed restart timer (not merely
  // that the `closed` flag later masks the re-fork). Both real timer primitives
  // are captured so the assertion is on the actual cleanup call.
  const armedTimers: ReturnType<typeof setTimeout>[] = [];
  const clearedTimers: Parameters<typeof clearTimeout>[0][] = [];
  const realSetTimeout: typeof setTimeout = globalThis.setTimeout;
  const realClearTimeout: typeof clearTimeout = globalThis.clearTimeout;
  // Forward the WHOLE argument tuple so the wrapped call resolves against the
  // same `setTimeout` overload the surrounding `ReturnType`/`Parameters` types
  // read — passing a hand-written `(fn, ms, ...rest)` list picks the DOM
  // (`number`-returning) overload and the captured handle stops matching.
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args);
    armedTimers.push(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((...args: Parameters<typeof clearTimeout>) => {
    const [handle] = args;
    if (handle !== undefined) {
      clearedTimers.push(handle);
    }
    realClearTimeout(...args);
  }) as typeof clearTimeout;
  try {
    const children = [makeFakeChild(), makeFakeChild()];
    let spawnCount = 0;
    const client = new DbHostClient({
      onEmit: () => {},
      onLog: () => {},
      fork: () => children[Math.min(spawnCount++, children.length - 1)].child,
    });
    client.start({ dataDir: "/tmp/db" }).catch(() => undefined);
    assert.equal(spawnCount, 1);

    // Child dies → a restart is armed on the backoff timer.
    children[0].exit(0);
    assert.equal(spawnCount, 1);
    assert.equal(armedTimers.length, 1, "the restart backoff timer is armed");
    const restartTimer = armedTimers[0];

    // Close before the backoff elapses. This must CLEAR the armed restart timer
    // so no re-fork fires against the now-closed client.
    await client.close();
    assert.ok(
      clearedTimers.includes(restartTimer),
      "close() cancels the pending restart timer"
    );
    // Post-close invokes reject rather than resurrecting the child.
    await assert.rejects(client.invoke("sessions.count", []));
    assert.equal(spawnCount, 1, "no re-fork after close cancelled the restart");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("native crash signals map to 128 + their real number, not a generic 1", () => {
  // The db-host's documented native crash modes (db-host-client.ts) must stay
  // legible in the launcher's exit code rather than collapsing to `1`.
  assert.equal(resolveLauncherExitCode(null, "SIGTRAP"), 133); // 128 + 5
  assert.equal(resolveLauncherExitCode(null, "SIGSEGV"), 139); // 128 + 11
  assert.equal(resolveLauncherExitCode(null, "SIGABRT"), 134); // 128 + 6
});

test("handleElectronExit runs cleanup then exits with the conventional status", async () => {
  const calls: string[] = [];
  let exitStatus: number | undefined;
  await handleElectronExit(null, "SIGHUP", {
    cleanup: () => {
      calls.push("cleanup");
    },
    exit: (status) => {
      calls.push("exit");
      exitStatus = status;
    },
  });
  // Cleanup must run before the exit, and the exit must be 128 + n — never a
  // re-raised signal. A wiring regression back to process.kill fails this.
  assert.deepEqual(calls, ["cleanup", "exit"]);
  assert.equal(exitStatus, 129);
});

test("handleElectronExit passes a clean child code through after cleanup", async () => {
  let exitStatus: number | undefined;
  await handleElectronExit(0, null, {
    cleanup: () => Promise.resolve(),
    exit: (status) => {
      exitStatus = status;
    },
  });
  assert.equal(exitStatus, 0);
});

test("handleBuildStepExit resolves on a clean exit and exits on signal/non-zero", () => {
  // Clean exit → resolve(), never exit.
  let resolved = false;
  let exited: number | undefined;
  handleBuildStepExit(0, null, {
    exit: (status) => {
      exited = status;
    },
    resolve: () => {
      resolved = true;
    },
  });
  assert.equal(resolved, true);
  assert.equal(exited, undefined);

  // Signal death → 128 + n exit, never resolve, never re-raise.
  resolved = false;
  handleBuildStepExit(null, "SIGSEGV", {
    exit: (status) => {
      exited = status;
    },
    resolve: () => {
      resolved = true;
    },
  });
  assert.equal(resolved, false);
  assert.equal(exited, 139);

  // Non-zero clean exit → that code, never resolve.
  resolved = false;
  exited = undefined;
  handleBuildStepExit(2, null, {
    exit: (status) => {
      exited = status;
    },
    resolve: () => {
      resolved = true;
    },
  });
  assert.equal(resolved, false);
  assert.equal(exited, 2);
});

test("close() while a restart spawn is in flight does not re-arm a timer", () => {
  nodeTestTimers.enable(["setTimeout"]);
  try {
    const children = [makeFakeChild(), makeFakeChild()];
    let spawnCount = 0;
    const client = new DbHostClient({
      onEmit: () => {},
      onLog: () => {},
      fork: () => children[Math.min(spawnCount++, children.length - 1)].child,
    });
    client.start({ dataDir: "/tmp/db" }).catch(() => undefined);
    assert.equal(spawnCount, 1);

    // Child dies → a restart is armed on the backoff timer.
    children[0].exit(0);
    // Fire the backoff: the supervisor re-forks (spawn #2) and its init reply is
    // still pending, so we're now inside the in-flight-spawn window.
    nodeTestTimers.tick(1000);
    assert.equal(spawnCount, 2, "the supervisor re-forked after the backoff");

    // Close lands WHILE the re-fork's init is still pending, then that init
    // rejects. The retry branch must observe `closed` and NOT arm a fresh timer.
    client.close().catch(() => undefined);
    children[1].failInit("init rejected during shutdown");

    // No third fork is scheduled: ticking well past the backoff must not re-fork.
    nodeTestTimers.tick(60_000);
    assert.equal(
      spawnCount,
      2,
      "no re-fork armed after close() during an in-flight restart spawn"
    );
  } finally {
    nodeTestTimers.reset();
  }
});

test("close() settles a ready promise an invoke is queued behind (no hang)", async () => {
  const armedTimers: ReturnType<typeof setTimeout>[] = [];
  const realSetTimeout: typeof setTimeout = globalThis.setTimeout;
  // See the argument-tuple note in the restart-backoff test above.
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args);
    armedTimers.push(handle);
    return handle;
  }) as typeof setTimeout;
  try {
    const children = [makeFakeChild(), makeFakeChild()];
    let spawnCount = 0;
    const client = new DbHostClient({
      onEmit: () => {},
      onLog: () => {},
      fork: () => children[Math.min(spawnCount++, children.length - 1)].child,
    });
    client.start({ dataDir: "/tmp/db" }).catch(() => undefined);

    // Child dies → `ready` becomes a fresh pending promise gated on the restart
    // timer. An invoke() arriving now queues behind that `ready`.
    children[0].exit(0);
    assert.equal(armedTimers.length, 1, "restart backoff timer armed");
    const invokePromise = client.invoke("sessions.count", []);

    // close() cancels the restart timer — the ONLY callback that would resolve
    // `ready`. It must settle `ready` itself so the queued invoke() doesn't hang
    // forever; it resolves against a closed/childless client, so invoke rejects.
    await client.close();
    await assert.rejects(
      invokePromise,
      "the queued invoke settles (rejects) instead of hanging"
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
