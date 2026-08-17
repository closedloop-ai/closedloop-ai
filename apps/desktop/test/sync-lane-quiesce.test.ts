/**
 * @file sync-lane-quiesce.test.ts
 * @description ISS-4903 — the shutdown path must drain the db-host CONSUMERS
 * before the db-host is disposed, and must never report `clean` while a lane is
 * still executing work.
 *
 * The bug this pins: `stop()` cleared each lane's timers and returned, so a tick
 * already in the air kept reading/writing a handle the sequence then tore down.
 * Shutdown logged `clean`; 20ms later five subsystems failed with `db-host
 * exited (code: 0)`. These tests assert both halves of the fix — the bounded
 * drain, and the verdict that can no longer lie about it.
 *
 * Timing is fully injected (`setTimeoutFn`/`clearTimeoutFn`), so nothing here
 * depends on the wall clock (FEA-2399 `test:node` determinism).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BackgroundTaskTracker,
  QuiesceOutcome,
  quiesceDesktopSyncLanes,
  quiesceSyncLanes,
  SYNC_LANE_QUIESCE_BUDGET_MS,
  TRANSCRIPT_SYNC_LANE_NAME,
} from "../src/main/lifecycle/sync-lane-quiesce.js";

const BUDGET_MS = 2000;

/**
 * Timer seam that never fires on its own: a test fires the budget explicitly
 * when it wants the timed-out branch, and records every clear so a leaked
 * handle is observable.
 */
function makeManualTimers() {
  const fired: Array<() => void> = [];
  const cleared: unknown[] = [];
  let nextHandle = 1;
  const handles = new Map<number, () => void>();
  const setTimeoutFn = ((callback: () => void) => {
    const handle = nextHandle;
    nextHandle += 1;
    handles.set(handle, callback);
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((handle: unknown) => {
    cleared.push(handle);
  }) as unknown as typeof clearTimeout;
  return {
    deps: { setTimeoutFn, clearTimeoutFn },
    cleared,
    fired,
    /** Fire every scheduled budget timer (the "budget elapsed" branch). */
    expire(): void {
      for (const callback of handles.values()) {
        fired.push(callback);
        callback();
      }
    },
    get scheduledCount(): number {
      return handles.size;
    },
  };
}

/** A promise plus its resolver — the sanctioned alternative to a poll loop. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => {
    // Replaced synchronously below.
  };
  let reject: (error: unknown) => void = () => {
    // Replaced synchronously below.
  };
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("ISS-4903: quiesce drains once every tracked task settles", async () => {
  const tracker = new BackgroundTaskTracker();
  const task = deferred();
  tracker.track(task.promise);
  assert.equal(tracker.pendingCount, 1, "the in-flight task is tracked");

  const timers = makeManualTimers();
  const quiescing = tracker.quiesce(BUDGET_MS, timers.deps);
  task.resolve();

  assert.equal(
    await quiescing,
    QuiesceOutcome.Drained,
    "a lane whose work settles inside the budget reports drained"
  );
  assert.equal(tracker.pendingCount, 0, "the tracker self-prunes on settle");
  assert.equal(
    timers.cleared.length,
    1,
    "the budget timer is cleared on the drained branch (no leaked handle)"
  );
});

test("ISS-4903: quiesce reports timed_out while work is STILL in the air", async () => {
  const tracker = new BackgroundTaskTracker();
  const wedged = deferred();
  tracker.track(wedged.promise);

  const timers = makeManualTimers();
  const quiescing = tracker.quiesce(BUDGET_MS, timers.deps);
  // The lane never settles; the budget elapses instead. This is the case the
  // old code silently reported as `clean`.
  timers.expire();

  assert.equal(
    await quiescing,
    QuiesceOutcome.TimedOut,
    "a lane still running at the budget must NOT be reported as drained"
  );
  assert.equal(tracker.pendingCount, 1, "the task really is still in the air");
  // Release the wedged task so the test leaves no dangling work.
  wedged.resolve();
});

test("ISS-4903: a task that REJECTS still counts as settled (drained, not stuck)", async () => {
  const tracker = new BackgroundTaskTracker();
  const failing = deferred();
  // The lane owns its own rejection handling; the tracker must not turn a
  // failed-but-finished task into a permanently un-drainable lane.
  tracker.track(failing.promise.catch(() => undefined));
  const timers = makeManualTimers();
  const quiescing = tracker.quiesce(BUDGET_MS, timers.deps);
  failing.reject(new Error("db-host exited (code: 0)"));

  assert.equal(
    await quiescing,
    QuiesceOutcome.Drained,
    "a settled-by-rejection task is drained work, not live work"
  );
  assert.equal(tracker.pendingCount, 0);
});

test("ISS-4903: an empty tracker drains immediately and schedules no timer", async () => {
  const tracker = new BackgroundTaskTracker();
  const timers = makeManualTimers();

  assert.equal(
    await tracker.quiesce(BUDGET_MS, timers.deps),
    QuiesceOutcome.Drained
  );
  assert.equal(
    timers.scheduledCount,
    0,
    "nothing in the air means no budget timer is armed at all"
  );
});

test("ISS-4903: quiesceSyncLanes names ONLY the lanes that did not drain", async () => {
  const unquiesced = await (async () => {
    const pending = quiesceSyncLanes(
      [
        {
          name: "fast.lane",
          quiesce: () => Promise.resolve(QuiesceOutcome.Drained),
        },
        {
          name: "wedged.lane",
          quiesce: () => Promise.resolve(QuiesceOutcome.TimedOut),
        },
      ],
      // `quiesceSyncLanes` owns no timers of its own — each lane honors the
      // budget inside its own `quiesce`, so there is no timer-deps parameter.
      BUDGET_MS
    );
    return await pending;
  })();

  assert.deepEqual(
    [...unquiesced],
    ["wedged.lane"],
    "a drained lane is not reported; only live work is"
  );
});

test("ISS-4903: a lane whose quiesce REJECTS is reported un-quiesced, not silently dropped", async () => {
  const unquiesced = await quiesceSyncLanes(
    [
      {
        name: "broken.lane",
        quiesce: () => Promise.reject(new Error("lane exploded")),
      },
    ],
    BUDGET_MS
  );

  assert.deepEqual(
    [...unquiesced],
    ["broken.lane"],
    "a lane that cannot even report whether it drained must degrade the verdict"
  );
});

test("ISS-4903: quiesceDesktopSyncLanes drains vacuously when the transcript lane was never constructed", async () => {
  assert.deepEqual([...(await quiesceDesktopSyncLanes(null))], []);
  assert.deepEqual([...(await quiesceDesktopSyncLanes(undefined))], []);
});

test("ISS-4903: quiesceDesktopSyncLanes names the transcript lane and honors the shared budget", async () => {
  const budgets: number[] = [];
  const unquiesced = await quiesceDesktopSyncLanes({
    quiesce: (budgetMs: number) => {
      budgets.push(budgetMs);
      return Promise.resolve(QuiesceOutcome.TimedOut);
    },
  });

  assert.deepEqual([...unquiesced], [TRANSCRIPT_SYNC_LANE_NAME]);
  assert.deepEqual(
    budgets,
    [SYNC_LANE_QUIESCE_BUDGET_MS],
    "the lane is quiesced against the shared default budget, never unbounded"
  );
});
