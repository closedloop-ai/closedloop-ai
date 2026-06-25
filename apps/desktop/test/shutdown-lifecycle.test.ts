import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ShutdownResult } from "../src/main/shutdown.js";
import {
  type BeforeQuitEvent,
  createBeforeQuitHandler,
  type ShutdownLifecycleApplication,
} from "../src/main/shutdown-lifecycle.js";
import type { DesktopShutdownDiagnostics } from "../src/main/telemetry-protocol.js";

type TestTimer = ReturnType<typeof setTimeout>;

function makePreventableEvent() {
  let prevented = false;
  const event: BeforeQuitEvent = {
    preventDefault: () => {
      prevented = true;
    },
  };
  return { event, wasPrevented: () => prevented };
}

function deferredShutdown() {
  let resolve!: (result: ShutdownResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<ShutdownResult>(
    (promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    }
  );
  return { promise, resolve, reject };
}

type HarnessOptions = {
  isApplyingUpdate?: boolean;
  finishUpdateInstallImpl?: () => void;
};

function makeHarness(
  shutdownPromise: Promise<ShutdownResult>,
  options: HarnessOptions = {}
) {
  const logs: Array<{ level: "info" | "error"; message: string }> = [];
  const exits: number[] = [];
  const failures: Omit<DesktopShutdownDiagnostics, "duringUpdate">[] = [];
  const clearedTimers: TestTimer[] = [];
  let shutdownCalls = 0;
  let setQuittingCalls = 0;
  let finishUpdateInstallCalls = 0;
  let hardExitCallback: (() => void) | null = null;
  let unrefCalls = 0;
  const timer = {
    unref: () => {
      unrefCalls += 1;
    },
  } as TestTimer;
  const application: ShutdownLifecycleApplication = {
    setQuitting: () => {
      setQuittingCalls += 1;
    },
    shutdown: () => {
      shutdownCalls += 1;
      return shutdownPromise;
    },
    reportShutdownFailure: (failure) => {
      failures.push(failure);
    },
    isApplyingUpdate: () => options.isApplyingUpdate ?? false,
    finishUpdateInstall: () => {
      finishUpdateInstallCalls += 1;
      options.finishUpdateInstallImpl?.();
    },
  };
  const handler = createBeforeQuitHandler({
    application,
    exit: (code) => exits.push(code),
    logInfo: (message) => logs.push({ level: "info", message }),
    logError: (message) => logs.push({ level: "error", message }),
    now: () => 10_000,
    setTimeoutFn: ((callback: () => void) => {
      hardExitCallback = callback;
      return timer;
    }) as typeof setTimeout,
    clearTimeoutFn: ((id: TestTimer) => {
      clearedTimers.push(id);
    }) as typeof clearTimeout,
  });

  return {
    handler,
    logs,
    exits,
    failures,
    clearedTimers,
    getShutdownCalls: () => shutdownCalls,
    getSetQuittingCalls: () => setQuittingCalls,
    getFinishUpdateInstallCalls: () => finishUpdateInstallCalls,
    getHardExitCallback: () => hardExitCallback,
    getUnrefCalls: () => unrefCalls,
    timer,
  };
}

describe("before-quit shutdown lifecycle", () => {
  test("normal quit force-exits cleanly and keeps a single shutdown owner on re-entry", async () => {
    const shutdown = deferredShutdown();
    const harness = makeHarness(shutdown.promise);
    const firstEvent = makePreventableEvent();
    const secondEvent = makePreventableEvent();

    harness.handler(firstEvent.event);
    harness.handler(secondEvent.event);

    assert.equal(firstEvent.wasPrevented(), true);
    assert.equal(secondEvent.wasPrevented(), true);
    assert.equal(harness.getSetQuittingCalls(), 1);
    assert.equal(harness.getShutdownCalls(), 1);
    assert.equal(harness.getUnrefCalls(), 1);
    assert.equal(harness.exits.length, 0);
    assert.ok(
      harness.logs.some((entry) =>
        entry.message.includes("shutdown already in progress")
      )
    );

    shutdown.resolve("clean");
    await shutdown.promise;
    await Promise.resolve();

    // Normal quit force-exits and never hands off to the updater.
    assert.deepEqual(harness.exits, [0]);
    assert.equal(harness.getFinishUpdateInstallCalls(), 0);
    assert.deepEqual(harness.clearedTimers, [harness.timer]);
  });

  test("update quit hands off to the updater instead of force-exiting", async () => {
    const shutdown = deferredShutdown();
    const harness = makeHarness(shutdown.promise, { isApplyingUpdate: true });
    const firstEvent = makePreventableEvent();

    harness.handler(firstEvent.event);
    assert.equal(firstEvent.wasPrevented(), true);

    shutdown.resolve("clean");
    await shutdown.promise;
    await Promise.resolve();

    // Cleanup ran, then the updater took over the relaunch.
    assert.equal(harness.getFinishUpdateInstallCalls(), 1);
    // No force-exit: app.exit() before the updater relaunch is the FEA-2026 bug.
    assert.deepEqual(harness.exits, []);
    // Watchdog stays armed as a fallback (not cleared on the hand-off path).
    assert.deepEqual(harness.clearedTimers, []);

    // The updater's own quitAndInstall re-fires before-quit; that quit must be
    // allowed through so the install + relaunch can complete.
    const updaterQuit = makePreventableEvent();
    harness.handler(updaterQuit.event);
    assert.equal(updaterQuit.wasPrevented(), false);
    assert.equal(harness.getShutdownCalls(), 1);
    assert.ok(
      harness.logs.some((entry) =>
        entry.message.includes("updater install in progress")
      )
    );
  });

  test("synchronous quitAndInstall re-entry during hand-off is allowed through", async () => {
    // Guards the ordering: handingOffToUpdater must be set BEFORE
    // finishUpdateInstall() runs, because quitAndInstall() can re-fire
    // before-quit synchronously. With the flag set afterwards the re-entry would
    // be preventDefault()'d and the relaunch would hang.
    const shutdown = deferredShutdown();
    const reentry = makePreventableEvent();
    let handlerRef: ((event: BeforeQuitEvent) => void) | null = null;
    const harness = makeHarness(shutdown.promise, {
      isApplyingUpdate: true,
      finishUpdateInstallImpl: () => {
        handlerRef?.(reentry.event);
      },
    });
    handlerRef = harness.handler;

    harness.handler(makePreventableEvent().event);
    shutdown.resolve("clean");
    await shutdown.promise;
    await Promise.resolve();

    assert.equal(harness.getFinishUpdateInstallCalls(), 1);
    // The synchronous re-entry must NOT be prevented (relaunch would hang).
    assert.equal(reentry.wasPrevented(), false);
    // And it must not start a second shutdown or force-exit.
    assert.equal(harness.getShutdownCalls(), 1);
    assert.deepEqual(harness.exits, []);
  });

  test("failed update install hand-off reports telemetry and force-exits", async () => {
    const shutdown = deferredShutdown();
    const harness = makeHarness(shutdown.promise, {
      isApplyingUpdate: true,
      finishUpdateInstallImpl: () => {
        throw new Error("updater not ready");
      },
    });
    const firstEvent = makePreventableEvent();

    harness.handler(firstEvent.event);
    shutdown.resolve("clean");
    await shutdown.promise;
    await Promise.resolve();

    assert.equal(harness.getFinishUpdateInstallCalls(), 1);
    assert.deepEqual(harness.exits, [1]);
    assert.deepEqual(harness.clearedTimers, [harness.timer]);
    assert.deepEqual(harness.failures, [
      {
        trigger: "update-install-failed",
        result: "failed",
        phase: "finishUpdateInstall",
        elapsedMs: 0,
        error: "updater not ready",
      },
    ]);
  });

  test("outer hard-exit preserves the existing log and reports failure telemetry", () => {
    const shutdown = deferredShutdown();
    const harness = makeHarness(shutdown.promise);
    const firstEvent = makePreventableEvent();

    harness.handler(firstEvent.event);
    harness.getHardExitCallback()?.();

    assert.equal(firstEvent.wasPrevented(), true);
    assert.deepEqual(harness.exits, [1]);
    assert.ok(
      harness.logs.some(
        (entry) =>
          entry.level === "error" &&
          entry.message === "hard-exit timeout reached; forcing app.exit(1)"
      )
    );
    assert.deepEqual(harness.failures, [
      {
        trigger: "outer-hard-exit",
        outerHardExit: true,
        elapsedMs: 0,
      },
    ]);
  });

  test("outer hard-exit fires as a fallback when an update install wedges", async () => {
    const shutdown = deferredShutdown();
    const harness = makeHarness(shutdown.promise, { isApplyingUpdate: true });
    const firstEvent = makePreventableEvent();

    harness.handler(firstEvent.event);
    // Cleanup completes and we hand off to the updater, but the updater never
    // quits/relaunches — the watchdog must still terminate the process.
    shutdown.resolve("clean");
    await shutdown.promise;
    await Promise.resolve();
    assert.equal(harness.getFinishUpdateInstallCalls(), 1);
    assert.deepEqual(harness.exits, []);

    harness.getHardExitCallback()?.();
    assert.deepEqual(harness.exits, [1]);
    assert.deepEqual(harness.failures, [
      {
        trigger: "outer-hard-exit",
        outerHardExit: true,
        elapsedMs: 0,
      },
    ]);
  });

  test("shutdown rejection reports the defensive failure path before exiting", async () => {
    const shutdown = deferredShutdown();
    const harness = makeHarness(shutdown.promise);
    const firstEvent = makePreventableEvent();

    harness.handler(firstEvent.event);
    shutdown.reject(new Error("cleanup exploded"));
    await assert.rejects(shutdown.promise, /cleanup exploded/);
    await Promise.resolve();

    assert.deepEqual(harness.exits, [1]);
    assert.deepEqual(harness.clearedTimers, [harness.timer]);
    assert.deepEqual(harness.failures, [
      {
        trigger: "shutdown-rejected",
        result: "failed",
        phase: "desktopApplication.shutdown",
        elapsedMs: 0,
        error: "cleanup exploded",
      },
    ]);
  });
});
