/**
 * @file db-host-restart-wedge.test.ts
 * @description ISS-5715 — an unexpected db-host exit must never leave the
 * supervisor permanently wedged, and it must never be reported as a recovery
 * that was not scheduled.
 *
 * The failure this pins: a REPLACEMENT child (forked by the restart ladder)
 * that reports `Ready` and then exits in the SAME task. Electron can deliver a
 * utility process's queued `message` and its `exit` in one task run, and `exit`
 * is a macrotask while the two promise hops out of `spawn()` are microtasks
 * queued behind it — so `handleExit()` runs FIRST, while `restarting` is still
 * true. Its `scheduleRestart()` call is then swallowed by that sentinel, and
 * the spawn continuation that finally clears the sentinel used to resolve
 * `ready` against a null child. Net effect: no timer armed, no further fork
 * ever, and every subsequent `invoke()` rejecting `db-host is not running`
 * forever — the collectors, transcript sync and the Sessions read path all dead
 * for the life of the process while the app still looks healthy, and the log
 * line claiming "restarting in Nms" for a restart that never existed.
 *
 * Timers are driven with node:test mock timers — no wall-clock waits, per the
 * desktop test:node determinism rules.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import type { DbHostExitDiagnostics } from "../src/main/telemetry/telemetry-protocol.js";
import type {
  DbHostChildExitListener,
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

/** Microtask hops drained between synchronous steps. */
const MICROTASK_DRAIN_TURNS = 50;
/** Well past any backoff the ladder can compute, so "never" is not "not yet". */
const LADDER_SETTLE_MS = 600_000;
/** The first unexpected exit arms its own timer and must name the delay. */
const RESTARTING_IN_RE = /restarting in \d+ms$/;
/** The rejection an in-flight invoke gets when the child dies under it. */
const EXITED_RE = /db-host exited/;
/** The storm log must carry the same truthful clause as its sibling branch. */
const STORM_ALREADY_IN_FLIGHT_RE = /a restart is already in flight$/;

/**
 * A fake forked db-host child that captures the client's exit + message
 * listeners, so a test can deliver `Ready` and `exit` in one synchronous turn.
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
      } else {
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

async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < MICROTASK_DRAIN_TURNS; turn++) {
    await Promise.resolve();
  }
}

/**
 * Drive a client to the wedge window: first child healthy, first child exits,
 * replacement forked, replacement reports Ready and exits in ONE turn.
 */
async function driveToReadyThenExitWindow(options: {
  onUnexpectedExit?: (event: DbHostExitDiagnostics) => void;
  onLog?: (message: string) => void;
}) {
  const children = [makeFakeChild(), makeFakeChild(), makeFakeChild()];
  let spawnCount = 0;
  const client = new DbHostClient({
    onEmit: () => {
      // no-op
    },
    onLog:
      options.onLog ??
      (() => {
        // no-op
      }),
    onUnexpectedExit: options.onUnexpectedExit,
    fork: () => children[Math.min(spawnCount++, children.length - 1)].child,
  });

  const started = client.start({ dataDir: "/tmp/db" });
  children[0].ready();
  await started;

  // The live child dies unexpectedly (code 0 — see the file header: Electron
  // reports 0 for an abnormal utility-process disconnect too).
  children[0].exit(0);
  nodeTestTimers.tick(1000);
  const replacementForkCount = spawnCount;

  // The replacement reports Ready and dies in the SAME synchronous turn.
  children[1].ready();
  children[1].exit(0);
  await drainMicrotasks();

  return {
    client,
    children,
    replacementForkCount,
    spawnCount: () => spawnCount,
  };
}

test("a replacement that dies in its own Ready turn still gets re-forked", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  try {
    const driven = await driveToReadyThenExitWindow({});
    assert.equal(
      driven.replacementForkCount,
      2,
      "the ladder forked a replacement"
    );

    // BEFORE the fix this stayed at 2 forever: handleExit's scheduleRestart()
    // was swallowed by the `restarting` sentinel, and the spawn continuation
    // that cleared the sentinel armed nothing in its place.
    nodeTestTimers.tick(LADDER_SETTLE_MS);
    assert.equal(
      driven.spawnCount(),
      3,
      "the ladder re-armed and forked a third child"
    );
  } finally {
    nodeTestTimers.reset();
  }
});

test("service recovers after a replacement dies in its own Ready turn", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  try {
    const driven = await driveToReadyThenExitWindow({});
    assert.equal(
      driven.replacementForkCount,
      2,
      "the ladder forked a replacement"
    );
    nodeTestTimers.tick(LADDER_SETTLE_MS);

    // An invoke issued while the host is down must QUEUE on `ready` and then
    // resolve against the healed child — not reject `db-host is not running`.
    // Before the fix `ready` was already resolved against a null child, so this
    // rejected immediately and every later call did too, for the life of the
    // process.
    const recovered = driven.client.invoke("sessions.count", []);
    driven.children[2].ready();
    await drainMicrotasks();
    assert.ok(
      driven.children[2].posted.some(
        (m) => m.kind === DbHostRequestKind.Invoke
      ),
      "the queued invoke reached the healed replacement"
    );
    driven.children[2].resolveLastInvoke(7);
    assert.equal(
      await recovered,
      7,
      "the queued invoke resolves after healing"
    );
  } finally {
    nodeTestTimers.reset();
  }
});

test("the self-re-armed retry waits the ESCALATED crash backoff", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  try {
    const driven = await driveToReadyThenExitWindow({});
    assert.equal(
      driven.replacementForkCount,
      2,
      "the ladder forked a replacement"
    );

    // Two unexpected exits inside the crash window, so FEA-3072 doubled the
    // backoff to 2000ms. The attempt re-arming itself captured 1000ms, so
    // reading that stale value would retry at half the escalated delay and
    // hot-loop through a Ready-then-die storm — the exact tight loop FEA-3072
    // exists to prevent. Nothing may fork before the escalated delay elapses.
    nodeTestTimers.tick(1999);
    assert.equal(
      driven.spawnCount(),
      2,
      "no re-fork before the escalated backoff elapses"
    );
    nodeTestTimers.tick(1);
    assert.equal(
      driven.spawnCount(),
      3,
      "the re-fork lands exactly on the escalated backoff"
    );
  } finally {
    nodeTestTimers.reset();
  }
});

test("the exit log never claims a restart that was not armed", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  const logs: string[] = [];
  try {
    await driveToReadyThenExitWindow({
      onLog: (message) => logs.push(message),
    });

    // The SECOND unexpected exit lands while an attempt is already in flight,
    // so it arms no timer of its own. The log must say so rather than name a
    // delay — the misreport that hid this bug.
    const unexpected = logs.filter((line) =>
      line.startsWith("db-host exited unexpectedly")
    );
    assert.equal(unexpected.length, 2, "both unexpected exits were logged");
    assert.match(unexpected[0], RESTARTING_IN_RE);
    assert.equal(
      unexpected[1],
      "db-host exited unexpectedly (code: 0); a restart is already in flight"
    );
  } finally {
    nodeTestTimers.reset();
  }
});

test("an unexpected exit reports its blast radius on the monitored path", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  const events: DbHostExitDiagnostics[] = [];
  try {
    const children = [makeFakeChild(), makeFakeChild()];
    let spawnCount = 0;
    const client = new DbHostClient({
      onEmit: () => {
        // no-op
      },
      onLog: () => {
        // no-op
      },
      onUnexpectedExit: (event) => events.push(event),
      fork: () => children[Math.min(spawnCount++, children.length - 1)].child,
    });
    const started = client.start({ dataDir: "/tmp/db" });
    children[0].ready();
    await started;

    // Two ops in flight when the child dies — both are abandoned, and the
    // monitored event must say two, not "an error happened".
    const first = client.invoke("sessions.count", []);
    const second = client.invoke("sessions.list", []);
    await drainMicrotasks();
    children[0].exit(0);
    await assert.rejects(first, EXITED_RE);
    await assert.rejects(second, EXITED_RE);

    assert.equal(events.length, 1, "one monitored event per unexpected exit");
    assert.deepEqual(events[0], {
      exitCode: 0,
      crashesInWindow: 1,
      backoffMs: 1000,
      rejectedOps: 2,
      restartAlreadyInFlight: false,
    });
  } finally {
    nodeTestTimers.reset();
  }
});

test("the crash-storm log also never claims a restart that was not armed", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  const logs: string[] = [];
  try {
    // Three unexpected exits inside the window trip CRASH_STORM_THRESHOLD, so
    // the THIRD one takes the storm branch — and it lands while an attempt is
    // still in flight, so it arms nothing. The storm branch is reached exactly
    // when crashes are stacking up, which is when a restart is MOST likely
    // already in flight, so it must take the same correction as its sibling.
    const driven = await driveToReadyThenExitWindow({
      onLog: (message) => logs.push(message),
    });
    assert.equal(
      driven.replacementForkCount,
      2,
      "the ladder forked a replacement"
    );
    nodeTestTimers.tick(LADDER_SETTLE_MS);
    driven.children[2].ready();
    driven.children[2].exit(0);
    await drainMicrotasks();

    const storm = logs.filter((line) => line.startsWith("db-host crash storm"));
    assert.equal(storm.length, 1, "the third exit took the crash-storm branch");
    assert.match(
      storm[0],
      STORM_ALREADY_IN_FLIGHT_RE,
      "the storm log must not name a backoff this exit never armed"
    );
  } finally {
    nodeTestTimers.reset();
  }
});

test("rejectedOps excludes the restart's own Init handshake", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  const events: DbHostExitDiagnostics[] = [];
  try {
    const children = [makeFakeChild(), makeFakeChild(), makeFakeChild()];
    let spawnCount = 0;
    const client = new DbHostClient({
      onEmit: () => {
        // no-op
      },
      onLog: () => {
        // no-op
      },
      onUnexpectedExit: (event) => events.push(event),
      fork: () => children[Math.min(spawnCount++, children.length - 1)].child,
    });
    const started = client.start({ dataDir: "/tmp/db" });
    children[0].ready();
    await started;

    // Bounce once so a replacement is forked, then kill the replacement while
    // its Init is still the ONLY parked correlation entry. No caller work was
    // in flight, so the blast radius is genuinely zero — counting the restart's
    // own handshake would report 1 and overstate lost ingestion on every
    // crash-on-start.
    children[0].exit(0);
    nodeTestTimers.tick(LADDER_SETTLE_MS);
    assert.equal(spawnCount, 2, "a replacement was forked");
    children[1].exit(0);
    await drainMicrotasks();

    assert.equal(events.length, 2, "both unexpected exits reported");
    assert.equal(
      events[1].rejectedOps,
      0,
      "a child that died during Init dropped no caller work"
    );
  } finally {
    nodeTestTimers.reset();
  }
});

test("an expected shutdown exit raises no monitored event", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  const events: DbHostExitDiagnostics[] = [];
  try {
    const children = [makeFakeChild(), makeFakeChild()];
    let spawnCount = 0;
    const client = new DbHostClient({
      onEmit: () => {
        // no-op
      },
      onLog: () => {
        // no-op
      },
      onUnexpectedExit: (event) => events.push(event),
      fork: () => children[Math.min(spawnCount++, children.length - 1)].child,
    });
    const started = client.start({ dataDir: "/tmp/db" });
    children[0].ready();
    await started;

    // The intentional-teardown window is open (ISS-4713): this exit is expected
    // and must stay off the monitored path, or every quit would page someone.
    client.beginClosing();
    children[0].exit(0);
    await drainMicrotasks();
    assert.deepEqual(events, [], "no monitored event during intentional close");
  } finally {
    nodeTestTimers.reset();
  }
});
