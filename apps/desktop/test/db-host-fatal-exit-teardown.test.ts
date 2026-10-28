/**
 * @file db-host-fatal-exit-teardown.test.ts
 * @description ISS-8776 — a FATAL exit must announce itself, so the db-host
 * supervisor does not fight the app's own shutdown.
 *
 * The graceful quit opens the intentional-teardown window first thing
 * (`runDesktopApplicationShutdown` → `beginClosing()`, ISS-4713). The fatal path
 * did not: `handleUncaughtException` / `handleUnhandledRejection` call
 * `app.exit()`, which skips `before-quit` and therefore skips all of that
 * ordering. The supervisor then saw the teardown's OWN child exit as a crash.
 *
 * That is what produced the observed pair, four seconds apart:
 *
 *     [error-handler] unhandled rejection: db-host exited (code: 1)
 *     [agent-sqlite] db-host exited unexpectedly (code: 0); a restart is already in flight
 *     [agent-sqlite] db-host restart failed, retrying: db-host exited (code: 0)
 *
 * ## On exit code 0 specifically
 *
 * The ticket asked whether code 0 belongs in the "unexpected" branch. It does,
 * and this suite pins that it still does. Two independent reasons already
 * written down in this repo: Electron reports 0 on a utility-process `exit`
 * whenever the mojo pipe disconnects before the platform termination status is
 * available (`db-host-exit-telemetry.ts`, electron/electron#42283), so the code
 * cannot distinguish a crash from a clean stop; and `isGracefulDbHostExitCode`
 * states that treating an exited-message as benign outside the closing window
 * would silence a real crash that happened to land during quit. The sound
 * discriminator is not the code — it is whether WE asked for the teardown. So
 * the fix supplies the missing signal rather than reclassifying the code.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import { handleUnhandledRejection } from "../src/main/lifecycle/error-handlers.js";
import {
  notifyFatalExit,
  onFatalExit,
} from "../src/main/lifecycle/fatal-exit-notice.js";
import type {
  DbHostChildExitListener,
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

/** Microtask hops drained between synchronous steps. */
const MICROTASK_DRAIN_TURNS = 50;
/** Past every delay the ladder can compute, so "never" is not "not yet". */
const LADDER_SETTLE_MS = 900_000;
/** The relabel the fix must prevent during a fatal teardown. */
const UNEXPECTED_EXIT_RE = /exited unexpectedly/;

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
    exit(code: number | null) {
      exitListener?.(code);
    },
    ready() {
      const initId = posted.find((m) => m.kind === DbHostRequestKind.Init)?.id;
      messageListener?.({ kind: DbHostResponseKind.Ready, id: initId });
    },
  };
}

async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < MICROTASK_DRAIN_TURNS; turn++) {
    await Promise.resolve();
  }
}

test("the fatal-exit notice reaches its registered hooks, and a release removes them", () => {
  const fired: string[] = [];
  const releaseFirst = onFatalExit(() => fired.push("first"));
  const releaseSecond = onFatalExit(() => fired.push("second"));
  try {
    notifyFatalExit();
    assert.deepEqual(fired, ["first", "second"]);

    releaseFirst();
    notifyFatalExit();
    assert.deepEqual(
      fired,
      ["first", "second", "second"],
      "a released hook must not fire again — a graceful close must be able to detach"
    );
  } finally {
    // The registry is module state shared by every case in this file; a hook
    // left behind here fires inside the later cases' `notifyFatalExit()`.
    releaseFirst();
    releaseSecond();
  }
});

test("a throwing hook cannot displace the crash the handler is reporting", () => {
  const fired: string[] = [];
  const releaseThrower = onFatalExit(() => {
    throw new Error("hook exploded");
  });
  const releaseGood = onFatalExit(() => fired.push("good"));
  try {
    assert.doesNotThrow(() => notifyFatalExit());
    assert.deepEqual(fired, ["good"], "later hooks still ran");
  } finally {
    releaseThrower();
    releaseGood();
  }
});

test("the unhandled-rejection handler announces the teardown BEFORE the dialog and the exit", async () => {
  const order: string[] = [];
  await handleUnhandledRejection(new Error("db-host exited (code: 1)"), {
    beginShutdown: () => order.push("beginShutdown"),
    emitException: () => order.push("emitException"),
    log: () => order.push("log"),
    showDialog: () => order.push("showDialog"),
    flushTelemetry: () => {
      order.push("flushTelemetry");
      return Promise.resolve();
    },
    exit: () => order.push("exit"),
  });

  assert.equal(
    order[0],
    "beginShutdown",
    `the teardown must be announced first; saw ${order.join(" → ")}`
  );
  assert.ok(
    order.indexOf("beginShutdown") < order.indexOf("showDialog"),
    "the modal crash dialog blocks for as long as the user leaves it up — the supervisor must already be quiesced"
  );
  assert.ok(order.includes("exit"), "the process still exits");
});

test("a db-host exit during a fatal teardown is not relabeled unexpected and is not restarted", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  const logs: string[] = [];
  let forkCount = 0;
  const first = makeFakeChild();
  const client = new DbHostClient({
    onEmit: () => {
      // no-op
    },
    onLog: (message) => logs.push(message),
    fork: () => {
      forkCount += 1;
      return forkCount === 1 ? first.child : makeFakeChild().child;
    },
  });
  const release = onFatalExit(() => client.beginClosing());
  try {
    const started = client.start({ dataDir: "/tmp/db" });
    first.ready();
    await started;
    assert.equal(forkCount, 1);

    // The fatal handler runs. Only `beginShutdown` is wired to anything real;
    // the rest are inert so the test observes the supervisor, not the dialog.
    await handleUnhandledRejection(new Error("db-host exited (code: 1)"), {
      beginShutdown: notifyFatalExit,
      log: () => {
        // no-op
      },
      exit: () => {
        // no-op
      },
    });

    // `app.exit()` now tears the utilityProcess down. Electron reports 0.
    first.exit(0);
    nodeTestTimers.tick(LADDER_SETTLE_MS);
    await drainMicrotasks();

    assert.ok(
      !logs.some((line) => UNEXPECTED_EXIT_RE.test(line)),
      `a teardown exit must not be reported as a crash; saw: ${logs.join(" | ")}`
    );
    assert.equal(
      forkCount,
      1,
      "the supervisor must not re-fork into a process that is already exiting"
    );
  } finally {
    release();
    nodeTestTimers.reset();
  }
});

test("an exit code 0 with NO teardown announced is still treated as a crash", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  const logs: string[] = [];
  let forkCount = 0;
  const first = makeFakeChild();
  const client = new DbHostClient({
    onEmit: () => {
      // no-op
    },
    onLog: (message) => logs.push(message),
    fork: () => {
      forkCount += 1;
      return forkCount === 1 ? first.child : makeFakeChild().child;
    },
  });
  try {
    const started = client.start({ dataDir: "/tmp/db" });
    first.ready();
    await started;

    // The SAME code, with nobody having asked for the teardown. Electron
    // reports 0 for an abnormal utility-process disconnect too, so this must
    // stay a crash — a fix that made code 0 benign by itself would silence it.
    first.exit(0);
    nodeTestTimers.tick(LADDER_SETTLE_MS);
    await drainMicrotasks();

    assert.ok(
      logs.some((line) => UNEXPECTED_EXIT_RE.test(line)),
      `an unannounced code-0 exit is still unexpected; saw: ${logs.join(" | ")}`
    );
    assert.equal(forkCount, 2, "and it still gets a replacement");
  } finally {
    nodeTestTimers.reset();
  }
});
