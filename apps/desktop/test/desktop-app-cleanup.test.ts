import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { ElectronApplication, Page } from "@playwright/test";
import { test } from "vitest";
import {
  closeElectronApp,
  launchGuardedElectronApp,
} from "./e2e/helpers/desktop-app";
import { captureProcessGroupId } from "./e2e/helpers/process-group-kill";

// `ChildProcess` declares `exitCode`/`signalCode` readonly — the real ones are
// owned by Node and only move when the process actually exits. This fake drives
// them by hand, so it needs its own mutable view of those two fields rather than
// pretending to be a `ChildProcess` and then writing through the readonly names.
type FakeChildProcess = EventEmitter &
  Pick<ChildProcess, "kill"> & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };

test("kills a live Electron child after Playwright close resolves", async () => {
  const child = new EventEmitter() as FakeChildProcess;
  child.exitCode = null;
  child.signalCode = null;
  let killSignal: NodeJS.Signals | number | undefined;
  child.kill = (signal) => {
    killSignal = signal;
    child.signalCode = "SIGKILL";
    child.emit("exit", null, "SIGKILL");
    return true;
  };
  // No `process`: teardown is handed the handle now, so production never
  // reaches `app.process()` on this path.
  const app = { close: async () => {} } as ElectronApplication;

  // No group id: this fake has no pid, so there is no group to signal and the
  // leader-handle kill is the whole contract under test here.
  await closeElectronApp(app, child as ChildProcess, undefined);

  assert.equal(killSignal, "SIGKILL");
});

/** The surviving-process wording `closeElectronApp` rejects with. */
const STILL_RUNNING = /still running/;

/**
 * ISS-6929: `kill()` is a request, not a guarantee — an unreachable or
 * already-reaped handle takes it and nothing dies — and `waitForProcessExit`
 * resolves on its own timeout either way. So this fake takes the signal and
 * never transitions, which is the case a bounded wait alone cannot tell from a
 * clean exit. Resolving here would report a successful teardown over a live
 * orphan and leave `discardPartialLaunch`'s catch unreachable.
 */
test("rejects when the Electron child outlives the kill wait", async () => {
  const child = new EventEmitter() as FakeChildProcess;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => false;
  // No `process`: teardown is handed the handle now, so production never
  // reaches `app.process()` on this path.
  const app = { close: async () => {} } as ElectronApplication;

  await assert.rejects(
    () => closeElectronApp(app, child as ChildProcess, undefined),
    STILL_RUNNING,
    "teardown resolved over a live process — a partial launch would report success while orphaning it"
  );
});

/**
 * Playwright's verbatim failure when `ElectronApplication.process()` is called
 * after the app's dispatcher has been disposed.
 *
 * Hand-written, not derived from the harness: this is the wire behavior of a
 * third-party library, and a constant imported from the code under test would
 * make the fixture agree with the fix by construction. Captured from a real
 * `_electron.launch` → `close()` → `process()` run of the built desktop app
 * (2026-08-22), which is also where the `_dispatcherByGuid.get(guid)._object`
 * diagnosis in `closeElectronApp` comes from.
 */
const DISPOSED_DISPATCHER_MESSAGE =
  "Cannot read properties of undefined (reading '_object')";
const DISPOSED_DISPATCHER = /reading '_object'/;

/**
 * ISS-7654 — an app that exited before teardown ran must tear down clean.
 *
 * The failure this replaces was a false RED on a green body: ~127 specs reach
 * `closeElectronApp`, it re-read the handle with `app.process()`, and once the
 * app was already gone that accessor threw a `TypeError` out of Playwright's
 * disposed dispatcher registry — after every assertion in the test had passed.
 *
 * Driven through `launchGuardedElectronApp` so the disposed-dispatcher path is
 * reached the way production reaches it. Measured against both mutants: it fails
 * if teardown re-reads `app.process()` (the TypeError above), and it fails if the
 * guard never captures a handle at launch, because teardown then has nothing to
 * grade and says so rather than resolving over an exit nobody observed.
 *
 * The sibling case above is the live-app control: its app never disposes its
 * dispatcher, so it passed before this fix and cannot observe the path.
 */
test("tears down clean when the app exited before teardown ran", async () => {
  const child = new EventEmitter() as FakeChildProcess;
  child.exitCode = null;
  child.signalCode = null;
  let killed = false;
  child.kill = () => {
    killed = true;
    return false;
  };

  let dispatcherDisposed = false;
  let disposedReads = 0;
  const app = {
    close: async () => {},
    process: () => {
      if (dispatcherDisposed) {
        disposedReads += 1;
        throw new TypeError(DISPOSED_DISPATCHER_MESSAGE);
      }
      return child;
    },
    firstWindow: async () => stubFirstWindow(),
  } as unknown as ElectronApplication;

  const launched = await launchGuardedElectronApp({
    args: [],
    launchElectron: async () => app,
  });

  // The app goes away on its own between the body and teardown — the exit is
  // what disposes the dispatcher, so both move together.
  child.exitCode = 0;
  dispatcherDisposed = true;

  // Precondition, not decoration: if the double did not actually start throwing,
  // the clean teardown below would prove nothing about a disposed dispatcher.
  assert.throws(() => app.process(), DISPOSED_DISPATCHER);
  const readsBeforeTeardown = disposedReads;

  await launched.cleanup();

  assert.equal(
    disposedReads,
    readsBeforeTeardown,
    "teardown re-read the app handle through app.process() after the dispatcher was disposed"
  );
  assert.equal(
    killed,
    false,
    "teardown SIGKILLed a process it could already see had exited"
  );
});

/**
 * ISS-7654 — a disposed dispatcher must not turn "failed to exit" into success.
 *
 * The other half of the verdict. The case above proves an app that DID exit
 * tears down clean; this one holds the dispatcher disposed exactly the same way
 * but leaves the process ALIVE, so the only way teardown can still reach its
 * reject is by grading the handle taken at launch.
 *
 * `hasProcessExited` grades an absent child as exited, so this is also where a
 * lost capture would do real damage rather than merely go unnoticed: without the
 * launch-time handle teardown would resolve clean over a process that is still
 * running. Both mutants — the deleted capture and the pre-fix `app.process()`
 * re-read — fail it.
 */
test("still reports a surviving process when the dispatcher is disposed", async () => {
  const child = new EventEmitter() as FakeChildProcess;
  child.exitCode = null;
  child.signalCode = null;
  let killed = false;
  // Takes the signal and never transitions — the orphan a bounded wait alone
  // cannot tell from a clean exit.
  child.kill = () => {
    killed = true;
    return false;
  };

  let dispatcherDisposed = false;
  const app = {
    close: async () => {},
    process: () => {
      if (dispatcherDisposed) {
        throw new TypeError(DISPOSED_DISPATCHER_MESSAGE);
      }
      return child;
    },
    firstWindow: async () => stubFirstWindow(),
  } as unknown as ElectronApplication;

  const launched = await launchGuardedElectronApp({
    args: [],
    launchElectron: async () => app,
  });

  // Playwright gives up on the app while its process keeps running.
  dispatcherDisposed = true;

  await assert.rejects(
    () => launched.cleanup(),
    STILL_RUNNING,
    "teardown resolved over a live process once the dispatcher was disposed"
  );
  assert.equal(killed, true, "teardown never tried to kill the live process");
});

/** Enough of a first window for the launch guard to finish wiring one up. */
function stubFirstWindow(): Page {
  return {
    on: () => {},
    waitForLoadState: async () => {},
  } as unknown as Page;
}

/**
 * A detached group leader that forks ONE grandchild inheriting its stdio and
 * then idles — the shape Playwright's Electron launch produces, where the
 * helper (utility/renderer/GPU) processes hold the leader's stdout/stderr pipes.
 * The grandchild's pid is printed so the test can grade it directly.
 */
const LEADER_SCRIPT = `
const { spawn } = require("node:child_process");
const grandchild = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1000)"],
  { stdio: "inherit" }
);
process.stdout.write(String(grandchild.pid) + "\\n");
setInterval(() => {}, 1000);
`;

/** Bound on how long the reaped tree may take to disappear from the OS. */
const REAP_TIMEOUT_MS = 5000;
const REAP_POLL_MS = 25;

/**
 * ISS-7683 — teardown must reap the child's whole process GROUP.
 *
 * The failure this replaces was a green suite that exited non-zero:
 * `session-transcript-caption-reconciliation.spec.ts` printed `2 passed` and
 * then `Worker teardown timeout of 60000ms exceeded`, attributed to no test.
 * `child.kill("SIGKILL")` reaps only the leader, so an Electron helper survived
 * — reparented to pid 1, still holding the stdout/stderr pipes Playwright's
 * launcher created — and the leader's `"close"` event, which needs stdio EOF as
 * well as exit, never fired. Playwright's own teardown awaits that event, so the
 * worker sat for 60s and the process exit code contradicted the test summary.
 *
 * Driven against a REAL spawned tree rather than a fake: the defect is POSIX
 * process-group semantics, which a stubbed `kill` cannot express. Measured
 * against the mutant — restore `child?.kill("SIGKILL")` in `closeElectronApp`
 * and the grandchild is still alive when this asserts.
 */
test("teardown reaps the child's whole process group, not just the leader", async () => {
  const leader = spawn(process.execPath, ["-e", LEADER_SCRIPT], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let grandchildPid: number | undefined;
  try {
    grandchildPid = await readGrandchildPid(leader);
    // Precondition, not decoration: if the grandchild never came up, the
    // assertion below would pass against a process that never existed.
    assert.equal(
      isAlive(grandchildPid),
      true,
      "the fixture's grandchild never started, so reaping it proves nothing"
    );

    await closeElectronApp(
      { close: async () => {} } as ElectronApplication,
      leader,
      captureProcessGroupId(leader)
    );

    assert.equal(
      await waitForReaped(grandchildPid),
      false,
      "teardown killed only the group leader — a helper process survived, holding the pipes Playwright waits on"
    );
  } finally {
    if (grandchildPid) {
      killQuietly(grandchildPid);
    }
    killQuietly(leader.pid);
  }
});

/**
 * ISS-7697 — the group must still be reachable once the LEADER is already gone.
 *
 * The case the sibling test above cannot reach: it tears down while the leader
 * is alive, so a teardown-time `ps -o pgid= -p <leader>` answers correctly and
 * the reap passes whether the group id was captured at launch or resolved on
 * the spot. Here the leader is dead and only the helper survives — which is not
 * a corner, it is the shape of the hang itself, since a helper still holding the
 * leader's inherited pipes is exactly why `"close"` never fires.
 *
 * Against a reaped leader, `ps -p` exits non-zero. A teardown-time lookup
 * therefore concludes "not a group leader" and falls through to
 * `child.kill("SIGKILL")` on a handle whose process no longer exists — a no-op —
 * while the helper keeps the pipes and Playwright's worker sits until its 60s
 * teardown timeout, with every test still reported green. The first assertion
 * below pins that lookup returning `undefined` at teardown time, so this test
 * states the mechanism rather than asserting the fix in the abstract: the launch
 * -time capture is the only thing standing between here and that hang.
 *
 * Driven through `launchGuardedElectronApp`, not `killProcessGroup` alone, so
 * deleting the capture at the launch site fails this too. `close` never settles,
 * because that is what a held pipe does to Playwright's `gracefullyClose`.
 */
test("teardown reaps a surviving helper after the group leader has exited", async () => {
  const leader = spawn(process.execPath, ["-e", LEADER_SCRIPT], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let grandchildPid: number | undefined;
  try {
    grandchildPid = await readGrandchildPid(leader);

    const launched = await launchGuardedElectronApp({
      args: [],
      launchElectron: async () =>
        ({
          close: () => new Promise<void>(() => {}),
          process: () => leader,
          firstWindow: async () => stubFirstWindow(),
        }) as unknown as ElectronApplication,
    });

    // Kill ONLY the leader and wait for Node to observe it, so teardown below
    // runs against a reaped pid rather than racing one.
    leader.kill("SIGKILL");
    await once(leader, "exit");

    assert.equal(
      captureProcessGroupId(leader),
      undefined,
      "the leader is still resolvable at teardown, so this fixture does not reproduce the leader-exited case"
    );
    assert.equal(
      isAlive(grandchildPid),
      true,
      "the helper died with its leader, so there is no surviving pipe-holder to reap"
    );

    await launched.cleanup();

    assert.equal(
      await waitForReaped(grandchildPid),
      false,
      "teardown resolved the group from an already-reaped leader and missed it — the helper survived, holding the pipes Playwright waits on"
    );
  } finally {
    if (grandchildPid) {
      killQuietly(grandchildPid);
    }
    killQuietly(leader.pid);
  }
});

/**
 * The first line the leader prints is its grandchild's pid.
 *
 * Every way the fixture can fail to produce that line settles this promise.
 * Spawn failure (`"error"`), a leader that exits before writing (`"exit"`), and
 * a stdout that reaches EOF unwritten (`"end"`) each REJECT, because the
 * alternative is a promise that never settles: the node lane would then hang on
 * a broken fixture instead of failing on it, which is the one outcome a test
 * helper wrapping `child_process` must never produce. `"exit"` fires for a
 * leader killed by signal too, so a fixture the OS took down is a failure here
 * rather than a stall.
 */
function readGrandchildPid(leader: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let buffered = "";
    const failUnwritten = (why: string) => {
      reject(
        new Error(
          `fixture leader ${why} before printing its grandchild pid; read ${JSON.stringify(buffered)}`
        )
      );
    };
    leader.once("error", reject);
    leader.once("exit", (code, signal) => {
      failUnwritten(`exited (code=${code}, signal=${signal})`);
    });
    leader.stdout?.once("end", () => {
      failUnwritten("closed stdout");
    });
    leader.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        resolve(Number.parseInt(buffered.slice(0, newline), 10));
      }
    });
  });
}

/** Whether `pid` still exists, via the POSIX signal-0 existence probe. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll until `pid` is gone or the bound elapses, and report liveness.
 *
 * A bounded poll rather than a fixed sleep: SIGKILL is delivered synchronously
 * but the OS reaps asynchronously, so a sleep would either be flaky or slow.
 */
async function waitForReaped(pid: number): Promise<boolean> {
  const deadline = Date.now() + REAP_TIMEOUT_MS;
  while (isAlive(pid) && Date.now() < deadline) {
    await delay(REAP_POLL_MS);
  }
  return isAlive(pid);
}

/** Best-effort teardown of a fixture process that may already be gone. */
function killQuietly(pid: number | undefined): void {
  if (!pid) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already reaped */
  }
}
