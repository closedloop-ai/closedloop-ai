/**
 * ISS-5346: the desktop window was revealed on the bare `desktop:renderer-ready`
 * IPC, which `renderer-ready-signal.ts` fires BEFORE the React entry mounts — so
 * the user landed on a shell that was painted but not live, and it sat wedged.
 *
 * These tests pin the two electron-free halves of the fix, by behavior:
 *
 *   1. `InitialWindowRevealGate` — the reveal is deferred to the readiness wait,
 *      never fires synchronously on renderer-ready, is one-shot, ALWAYS happens
 *      (a rejected wait still reveals; an unrevealed window is strictly worse
 *      than an early one), and a `reset()` for a rebuilt window INVALIDATES any
 *      wait still in flight for the disposed one.
 *   2. `RendererReadinessGates.waitForInitialWindowRevealReadiness()` — the wait
 *      resolves on the renderer MOUNT, is not released by the downstream
 *      dashboard-data gates, and FAILS OPEN within its bound.
 *
 * The fail-open half is load-bearing: a reveal gated on an unbounded wait would
 * trade the early window this ticket fixes for a permanently invisible one.
 *
 * Production wiring (the IPC phase → gates → reveal chain) is covered by
 * `initial-window-reveal-wiring.test.ts`; the launched-Electron window itself by
 * `test/e2e/startup-window-reveal.spec.ts`.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  InitialWindowRevealGate,
  WindowRevealReason,
  WindowShowIntent,
} from "../src/main/lifecycle/initial-window-reveal-gate.js";
import { RendererReadinessGates } from "../src/main/lifecycle/renderer-readiness-gates.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

/** The bound in renderer-readiness-gates.ts; kept local so a widening fails. */
const INITIAL_WINDOW_REVEAL_FAIL_OPEN_MS = 2000;
// Module-scoped so the matcher isn't recompiled per assertion (useTopLevelRegex).
const FAIL_OPEN_WARNING = /renderer mount timeout/;

type LoggedLine = { scope: string; message: string };

function createRecordingLog(): {
  info: (scope: string, message: string) => void;
  warn: (scope: string, message: string) => void;
  warnings: LoggedLine[];
} {
  const warnings: LoggedLine[] = [];
  return {
    info: () => undefined,
    warn: (scope, message) => {
      warnings.push({ scope, message });
    },
    warnings,
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("ISS-5346 InitialWindowRevealGate", () => {
  test("requestReveal does not reveal synchronously on renderer-ready", () => {
    const revealed: WindowRevealReason[] = [];
    let settleReadiness: (reason: WindowRevealReason) => void = () => undefined;
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () =>
        new Promise<WindowRevealReason>((resolve) => {
          settleReadiness = resolve;
        }),
      reveal: (reason) => revealed.push(reason),
    });

    gate.requestReveal();

    // The pre-ISS-5346 bug in one assertion: renderer-ready alone must not show
    // the window. `settleReadiness` is captured but deliberately not called.
    assert.deepEqual(revealed, []);
    assert.equal(typeof settleReadiness, "function");
  });

  test("reveals with the mounted reason once the readiness wait resolves", async () => {
    const revealed: WindowRevealReason[] = [];
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () => Promise.resolve(WindowRevealReason.AppMounted),
      reveal: (reason) => revealed.push(reason),
    });

    gate.requestReveal();
    await gate.whenRevealSettled();

    assert.deepEqual(revealed, [WindowRevealReason.AppMounted]);
  });

  test("reveals on the fail-open reason so a stuck renderer cannot hide the window", async () => {
    const revealed: WindowRevealReason[] = [];
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () => Promise.resolve(WindowRevealReason.MountFailOpen),
      reveal: (reason) => revealed.push(reason),
    });

    gate.requestReveal();
    await gate.whenRevealSettled();

    assert.deepEqual(revealed, [WindowRevealReason.MountFailOpen]);
  });

  test("a readiness wait that throws still reveals the window and reports why", async () => {
    const revealed: WindowRevealReason[] = [];
    const errors: string[] = [];
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () => Promise.reject(new Error("gates exploded")),
      reveal: (reason) => revealed.push(reason),
      onReadinessError: (message) => errors.push(message),
    });

    gate.requestReveal();
    await gate.whenRevealSettled();

    assert.deepEqual(revealed, [WindowRevealReason.MountWaitFailed]);
    assert.deepEqual(errors, ["gates exploded"]);
  });

  test("is one-shot: the post-mount renderer-ready does not start a second wait", async () => {
    let waits = 0;
    const revealed: WindowRevealReason[] = [];
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () => {
        waits += 1;
        return Promise.resolve(WindowRevealReason.AppMounted);
      },
      reveal: (reason) => revealed.push(reason),
    });

    // `renderer-ready-signal.ts` fires pre-mount and `main.tsx` fires again
    // post-mount; both land on the same gate.
    gate.requestReveal();
    gate.requestReveal();
    await gate.whenRevealSettled();

    assert.equal(waits, 1);
    assert.deepEqual(revealed, [WindowRevealReason.AppMounted]);
  });

  test("an app-activate show BEFORE the reveal arms the gate instead of showing", () => {
    // wongk: Electron emits `activate` on the first macOS launch and
    // `startup.ts` routes it through `handleActivate()` to `DesktopWindow.show()`.
    // That path used to reach `BrowserWindow.show()` directly, bypassing the
    // gate and exposing the pre-mount shell it exists to hide. `boot()` never
    // shows the window itself, so this event IS the cold-launch show call and
    // cannot take the user-requested shortcut below.
    const shownNow: string[] = [];
    const revealed: WindowRevealReason[] = [];
    let waits = 0;
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () => {
        waits += 1;
        return new Promise<WindowRevealReason>(() => undefined);
      },
      reveal: (reason) => revealed.push(reason),
    });

    gate.requestShow(WindowShowIntent.AppActivated, () =>
      shownNow.push("show")
    );

    assert.deepEqual(shownNow, []);
    assert.deepEqual(revealed, []);
    // It armed the (bounded) wait rather than doing nothing — an explicit open
    // must still surface the window, just not on a dead shell.
    assert.equal(waits, 1);
  });

  test("a USER-REQUESTED show BEFORE the reveal reveals immediately", () => {
    // A tray "Open", notification click, or deep link has no cold-launch source,
    // so holding it answers an explicit request with nothing for the whole
    // bound. Reveal on the splash instead.
    const shownNow: string[] = [];
    const revealed: WindowRevealReason[] = [];
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () => new Promise<WindowRevealReason>(() => undefined),
      reveal: (reason) => revealed.push(reason),
    });

    gate.requestShow(WindowShowIntent.UserRequested, () =>
      shownNow.push("show")
    );

    assert.deepEqual(revealed, [WindowRevealReason.UserRequested]);
    assert.deepEqual(shownNow, ["show"]);
  });

  test("a user-requested reveal is not re-revealed when the mount later lands", async () => {
    const revealed: WindowRevealReason[] = [];
    let settleReadiness: (reason: WindowRevealReason) => void = () => undefined;
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () =>
        new Promise<WindowRevealReason>((resolve) => {
          settleReadiness = resolve;
        }),
      reveal: (reason) => revealed.push(reason),
    });

    gate.requestReveal();
    gate.requestShow(WindowShowIntent.UserRequested, () => undefined);
    settleReadiness(WindowRevealReason.AppMounted);
    await flushMicrotasks();

    // One reveal, attributed to the path that actually put the window on screen.
    assert.deepEqual(revealed, [WindowRevealReason.UserRequested]);
  });

  test("an app-activate show queued during the hold runs when the reveal lands", async () => {
    // `reveal()` shows the window but does NOT focus it, so a dropped `showNow`
    // leaves the requester with an unfocused window for the rest of the boot.
    const shownNow: string[] = [];
    const revealed: WindowRevealReason[] = [];
    let settleReadiness: (reason: WindowRevealReason) => void = () => undefined;
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () =>
        new Promise<WindowRevealReason>((resolve) => {
          settleReadiness = resolve;
        }),
      reveal: (reason) => revealed.push(reason),
    });

    gate.requestShow(WindowShowIntent.AppActivated, () =>
      shownNow.push("show")
    );
    assert.deepEqual(shownNow, []);

    settleReadiness(WindowRevealReason.AppMounted);
    await flushMicrotasks();

    assert.deepEqual(revealed, [WindowRevealReason.AppMounted]);
    assert.deepEqual(shownNow, ["show"]);
  });

  test("a queued show still runs when the readiness wait REJECTS", async () => {
    const shownNow: string[] = [];
    const revealed: WindowRevealReason[] = [];
    let rejectReadiness: (error: Error) => void = () => undefined;
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () =>
        new Promise<WindowRevealReason>((_resolve, reject) => {
          rejectReadiness = reject;
        }),
      reveal: (reason) => revealed.push(reason),
    });

    gate.requestShow(WindowShowIntent.AppActivated, () =>
      shownNow.push("show")
    );
    rejectReadiness(new Error("mount wait blew up"));
    await flushMicrotasks();

    assert.deepEqual(revealed, [WindowRevealReason.MountWaitFailed]);
    assert.deepEqual(shownNow, ["show"]);
  });

  test("reset DROPS a show queued against the disposed window", async () => {
    const shownNow: string[] = [];
    let settleFirstWait: (reason: WindowRevealReason) => void = () => undefined;
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () =>
        new Promise<WindowRevealReason>((resolve) => {
          settleFirstWait = resolve;
        }),
      reveal: () => undefined,
    });

    gate.requestShow(WindowShowIntent.AppActivated, () =>
      shownNow.push("show")
    );
    // The queued callback closes over the DISPOSED BrowserWindow.
    gate.reset();
    settleFirstWait(WindowRevealReason.AppMounted);
    await flushMicrotasks();

    assert.deepEqual(shownNow, []);
  });

  test("an explicit show AFTER the reveal shows immediately", async () => {
    const shownNow: string[] = [];
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () => Promise.resolve(WindowRevealReason.AppMounted),
      reveal: () => undefined,
    });

    gate.requestReveal();
    await gate.whenRevealSettled();
    gate.requestShow(WindowShowIntent.UserRequested, () =>
      shownNow.push("show")
    );

    assert.deepEqual(shownNow, ["show"]);
  });

  test("an explicit show after a FAIL-OPEN reveal also shows immediately", async () => {
    // The fail-open still counts as revealed: the window is on screen, so a
    // later tray/dock open must not be swallowed by the one-shot gate.
    const shownNow: string[] = [];
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () => Promise.resolve(WindowRevealReason.MountFailOpen),
      reveal: () => undefined,
    });

    gate.requestReveal();
    await gate.whenRevealSettled();
    gate.requestShow(WindowShowIntent.UserRequested, () =>
      shownNow.push("show")
    );

    assert.deepEqual(shownNow, ["show"]);
  });

  test("a reset re-closes the app-activate show path for the rebuilt window", () => {
    const shownNow: string[] = [];
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () => new Promise<WindowRevealReason>(() => undefined),
      reveal: () => undefined,
    });

    gate.requestReveal();
    gate.reset();
    gate.requestShow(WindowShowIntent.AppActivated, () =>
      shownNow.push("show")
    );

    assert.deepEqual(shownNow, []);
  });

  test("reset re-arms the gate for a rebuilt window", async () => {
    let waits = 0;
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () => {
        waits += 1;
        return Promise.resolve(WindowRevealReason.AppMounted);
      },
      reveal: () => undefined,
    });

    gate.requestReveal();
    await gate.whenRevealSettled();
    gate.reset();
    gate.requestReveal();
    await gate.whenRevealSettled();

    assert.equal(waits, 2);
  });

  test("reset INVALIDATES a reveal still pending for the disposed window", async () => {
    const revealed: WindowRevealReason[] = [];
    let settleFirstWait: (reason: WindowRevealReason) => void = () => undefined;
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () =>
        new Promise<WindowRevealReason>((resolve) => {
          settleFirstWait = resolve;
        }),
      reveal: (reason) => revealed.push(reason),
    });

    gate.requestReveal();
    // The window is torn down while its (bounded) readiness wait is still in
    // flight — `DesktopWindow.dispose()` calls reset() here.
    gate.reset();
    // The old window's wait now settles. Without a generation guard this
    // continuation reveals the REPLACEMENT window before its own renderer has
    // mounted, which is precisely the early reveal the gate exists to stop.
    settleFirstWait(WindowRevealReason.MountFailOpen);
    await flushMicrotasks();

    assert.deepEqual(revealed, []);
  });

  test("reset also invalidates a pending reveal whose wait REJECTS", async () => {
    const revealed: WindowRevealReason[] = [];
    const errors: string[] = [];
    let rejectFirstWait: (error: Error) => void = () => undefined;
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () =>
        new Promise<WindowRevealReason>((_resolve, reject) => {
          rejectFirstWait = reject;
        }),
      reveal: (reason) => revealed.push(reason),
      onReadinessError: (message) => errors.push(message),
    });

    gate.requestReveal();
    gate.reset();
    rejectFirstWait(new Error("torn down mid-wait"));
    await flushMicrotasks();

    // The always-reveal guarantee is scoped to the CURRENT window: a stale
    // rejection must not force the replacement window open either.
    assert.deepEqual(revealed, []);
    assert.deepEqual(errors, []);
  });

  test("after a reset the NEW window's own wait still reveals it", async () => {
    const revealed: WindowRevealReason[] = [];
    let settleWait: (reason: WindowRevealReason) => void = () => undefined;
    const gate = new InitialWindowRevealGate({
      waitForReadiness: () =>
        new Promise<WindowRevealReason>((resolve) => {
          settleWait = resolve;
        }),
      reveal: (reason) => revealed.push(reason),
    });

    gate.requestReveal();
    const settleStaleWait = settleWait;
    gate.reset();
    gate.requestReveal();
    settleStaleWait(WindowRevealReason.MountFailOpen);
    settleWait(WindowRevealReason.AppMounted);
    await gate.whenRevealSettled();
    await flushMicrotasks();

    // Only the live generation reveals — the stale settle above is dropped.
    assert.deepEqual(revealed, [WindowRevealReason.AppMounted]);
  });
});

describe("ISS-5346 waitForInitialWindowRevealReadiness", () => {
  test("does not resolve until the renderer app has mounted", async () => {
    const gates = new RendererReadinessGates(createRecordingLog());
    let settled: WindowRevealReason | null = null;
    const pending = gates
      .waitForInitialWindowRevealReadiness()
      .then((reason) => {
        settled = reason;
        return reason;
      });

    await flushMicrotasks();
    // The pre-mount `Shell` phase arms this wait but must not release it — the
    // reveal the bug fired.
    assert.equal(settled, null);

    gates.notifyRendererMounted();
    assert.equal(await pending, WindowRevealReason.AppMounted);
  });

  test("resolves immediately when the renderer mounted before the wait", async () => {
    const gates = new RendererReadinessGates(createRecordingLog());
    gates.notifyRendererMounted();

    assert.equal(
      await gates.waitForInitialWindowRevealReadiness(),
      WindowRevealReason.AppMounted
    );
  });

  test("the DOWNSTREAM dashboard gates do not release the reveal", async () => {
    // The circularity regression, pinned. `initialDashboardDataServed` is
    // produced only by the live `withDb` wrapper and `initialRendererLiveDbIdle`
    // only after `desktop:db:ready` — both need the agent-dashboard runtime,
    // which `schedulePostInitialWindowBootTasks` creates only AFTER
    // `whenInitiallyShown()`. Gating the reveal on them made every first boot
    // hit the fail-open instead of the healthy path.
    const gates = new RendererReadinessGates(createRecordingLog());
    let settled: WindowRevealReason | null = null;
    const pending = gates
      .waitForInitialWindowRevealReadiness()
      .then((reason) => {
        settled = reason;
        return reason;
      });

    gates.notifyInitialDashboardDataServed();
    gates.notifyInitialRendererLiveDbIdle();
    await flushMicrotasks();
    assert.equal(settled, null);

    gates.notifyRendererMounted();
    assert.equal(await pending, WindowRevealReason.AppMounted);
  });

  test("FAIL-OPEN: a renderer that never mounts still reveals, at its bound, with the reason logged", async () => {
    const log = createRecordingLog();
    const gates = new RendererReadinessGates(log);

    // Pinned clock, not a wall-clock delta: the bound is asserted by advancing
    // TO it, which pins both halves of the contract (held one tick short,
    // revealed on the tick that reaches it) and stays deterministic on a loaded
    // runner. Only `setTimeout` is mocked, so the `setImmediate` used to flush
    // microtasks below still runs for real.
    nodeTestTimers.enable(["setTimeout"]);
    try {
      let settled: WindowRevealReason | null = null;
      const pending = gates
        .waitForInitialWindowRevealReadiness()
        .then((reason) => {
          settled = reason;
          return reason;
        });

      nodeTestTimers.tick(INITIAL_WINDOW_REVEAL_FAIL_OPEN_MS - 1);
      await flushMicrotasks();
      // One tick short of the bound the window is still held: the fail-open is
      // a real timeout, not an immediate resolve that only looks like one.
      assert.equal(settled, null);

      nodeTestTimers.tick(1);
      // The whole point: bounded. An unbounded wait here would leave the window
      // permanently invisible, which is strictly worse than the early reveal.
      assert.equal(await pending, WindowRevealReason.MountFailOpen);
    } finally {
      nodeTestTimers.reset();
    }

    assert.equal(log.warnings.length, 1);
    assert.equal(log.warnings[0]?.scope, "startup");
    assert.match(log.warnings[0]?.message ?? "", FAIL_OPEN_WARNING);
  });

  test("a mount landing on the same turn as the timer is a gated reveal, not a fail-open", async () => {
    const log = createRecordingLog();
    const gates = new RendererReadinessGates(log);

    nodeTestTimers.enable(["setTimeout"]);
    try {
      const pending = gates.waitForInitialWindowRevealReadiness();
      // Fire the bound FIRST so the timeout arm is the one that wins the race,
      // then mount in the same synchronous turn. Only the post-race
      // `initialRendererMounted` re-check can classify this correctly; without
      // it a mount that landed with the timer would be logged as a fail-open.
      nodeTestTimers.tick(INITIAL_WINDOW_REVEAL_FAIL_OPEN_MS);
      gates.notifyRendererMounted();

      assert.equal(await pending, WindowRevealReason.AppMounted);
    } finally {
      nodeTestTimers.reset();
    }

    assert.deepEqual(log.warnings, []);
  });
});
