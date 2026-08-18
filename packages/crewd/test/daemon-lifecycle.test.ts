/**
 * @file daemon-lifecycle.test.ts
 * @description The daemon's LIFECYCLE surface (ISS-5296): `start`/`stop`, the tick
 * interval guard, run-record bookkeeping, and the native-slot cursor advance.
 *
 * Scope boundary — `tickOnce`'s due/ownership guards and `runNow` are owned by
 * `daemon.test.ts`, and every ISS-4736/ISS-4814 fire-once behavior is owned by
 * `daemon-one-time-fire.test.ts` (fire-once :48, crash-window restart :84, version
 * skew :140/:444, disable fallback :210/:481, `whenRunDurable` ordering :522).
 * Nothing here re-tests those; two cases that LOOK adjacent to existing ones are
 * deliberately aimed at ground they do not cover, and say so.
 *
 * Time is pinned with fake timers throughout — the interval guard and the cursor
 * advance are clock-driven, and asserting them against the wall clock would be
 * flaky by construction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunRecord, RunStatus } from "../src/model.js";
import { Daemon, type DispatchOutcome } from "../src/scheduler/daemon.js";
import type { LockPort } from "../src/scheduler/lock-port.js";
import {
  config,
  countingDispatch,
  makeTask,
  NOW,
  ok,
  stubStore,
} from "./helpers/daemon-fixtures.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Daemon.start interval guard", () => {
  function spyLock(): LockPort & {
    acquired: () => number;
    released: () => number;
  } {
    let a = 0;
    let r = 0;
    return {
      acquire: () => {
        a += 1;
      },
      release: () => {
        r += 1;
      },
      acquired: () => a,
      released: () => r,
    };
  }

  /** Build a daemon whose ticks are counted via `store.reload()`. */
  function tickCounter(intervalMs: number | undefined) {
    let ticks = 0;
    const store = stubStore([]);
    const daemon = new Daemon(
      {
        store: {
          ...store,
          reload: () => {
            ticks += 1;
          },
        },
        dispatch: countingDispatch().dispatch,
        lock: spyLock(),
      },
      { ...config, intervalMs }
    );
    return { daemon, ticks: () => ticks };
  }

  it("falls back to 30s when intervalMs is NaN rather than busy-looping at delay 0", async () => {
    // `?? 30_000` does not catch NaN, and `setInterval(NaN)` degenerates to a
    // delay-0 loop that pegs a core and re-ticks thousands of times a second.
    // Counting ticks across the window is what makes this fail if the
    // `Number.isFinite` guard is removed — a delay-0 timer would fire thousands
    // of times inside the first 29 s, not zero.
    const { daemon, ticks } = tickCounter(Number.NaN);

    daemon.start();
    expect(ticks()).toBe(1); // the immediate tick only

    await vi.advanceTimersByTimeAsync(29_000);
    expect(ticks()).toBe(1); // still nothing: the interval is 30s, not 0

    await vi.advanceTimersByTimeAsync(2000);
    expect(ticks()).toBe(2);

    await daemon.stop();
  });

  it("ignores an interval of exactly zero and uses the 30s default", async () => {
    // Pinned separately from the negative case: the guard is `configured > 0`, so
    // relaxing it to `>= 0` would let a literal 0 through and produce the same
    // delay-0 busy loop.
    const { daemon, ticks } = tickCounter(0);

    daemon.start();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(ticks()).toBe(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(ticks()).toBe(2);

    await daemon.stop();
  });

  it("ticks on the configured interval when it is positive and finite", async () => {
    let ticks = 0;
    const store = stubStore([]);
    const daemon = new Daemon(
      {
        store: {
          ...store,
          reload: () => {
            ticks += 1;
          },
        },
        dispatch: countingDispatch().dispatch,
        lock: spyLock(),
      },
      { ...config, intervalMs: 1000 }
    );

    daemon.start();
    expect(ticks).toBe(1); // immediate first tick

    await vi.advanceTimersByTimeAsync(3000);
    expect(ticks).toBe(4);

    await daemon.stop();
  });

  it("ignores a NEGATIVE interval and uses the 30s default", async () => {
    const { daemon, ticks } = tickCounter(-5);

    daemon.start();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(ticks()).toBe(1); // still only the immediate tick

    await vi.advanceTimersByTimeAsync(2000);
    expect(ticks()).toBe(2);

    await daemon.stop();
  });

  it("acquires the lock on start and releases it on stop", async () => {
    const lock = spyLock();
    const daemon = new Daemon(
      { store: stubStore([]), dispatch: countingDispatch().dispatch, lock },
      { ...config, intervalMs: 60_000 }
    );

    daemon.start();
    expect(lock.acquired()).toBe(1);

    await daemon.stop();
    expect(lock.released()).toBe(1);
  });

  it("stop() on a never-started daemon does not throw and still releases", async () => {
    const lock = spyLock();
    const daemon = new Daemon(
      { store: stubStore([]), dispatch: countingDispatch().dispatch, lock },
      config
    );

    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(lock.released()).toBe(1);
  });

  it("logs a rejecting tick instead of letting it kill the loop", async () => {
    // The interval callback is fire-and-forget; an unhandled rejection here would
    // take the daemon process down and silently stop every future schedule.
    const logs: string[] = [];
    const daemon = new Daemon(
      {
        store: {
          ...stubStore([]),
          reload: () => {
            throw new Error("store exploded");
          },
        },
        dispatch: countingDispatch().dispatch,
        log: (m) => logs.push(m),
      },
      { ...config, intervalMs: 60_000 }
    );

    daemon.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(logs.some((l) => l.includes("tick error"))).toBe(true);
    await daemon.stop();
  });

  it("logs a tick that rejects with a NON-Error value", async () => {
    // A `StorePort` adapter can throw a string; the log must still name it rather
    // than printing "undefined" and losing the only clue the operator gets.
    const logs: string[] = [];
    const daemon = new Daemon(
      {
        store: {
          ...stubStore([]),
          reload: () => {
            // biome-ignore lint/style/useThrowOnlyError: throwing a non-Error is the case under test
            throw "store exploded as a string";
          },
        },
        dispatch: countingDispatch().dispatch,
        log: (m) => logs.push(m),
      },
      { ...config, intervalMs: 60_000 }
    );

    daemon.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(logs.some((l) => l.includes("store exploded as a string"))).toBe(
      true
    );
    await daemon.stop();
  });

  it("defaults its clock to the real one when no `now` is injected", async () => {
    // `deps.now` is optional; without it the daemon must still resolve a time and
    // tick rather than comparing against `undefined`.
    const task = makeTask({ lastRunAt: null });
    const { dispatch, calls } = countingDispatch();
    const daemon = new Daemon({ store: stubStore([task]), dispatch }, config);

    const report = await daemon.tickOnce();

    expect(report.now).toBe(NOW.toISOString());
    expect(calls()).toHaveLength(1);
    await daemon.drain();
  });
});

describe("Daemon run bookkeeping", () => {
  it("persists a dispatch outcome's logPath onto the run record", async () => {
    const patches: Partial<RunRecord>[] = [];
    const withLogPath: DispatchOutcome = {
      ...ok,
      logPath: "/tmp/findings.jsonl",
    };
    const daemon = new Daemon(
      {
        store: stubStore([makeTask()], {
          finishRun: (_id, patch) => {
            patches.push(patch);
            return undefined;
          },
        }),
        dispatch: () => Promise.resolve(withLogPath),
      },
      config
    );

    await daemon.tickOnce();
    await daemon.drain();

    expect(patches[0]?.logPath).toBe("/tmp/findings.jsonl");
  });

  it("OMITS logPath entirely when the outcome carries none", async () => {
    // Omission, not null. `logPath` crosses into the persisted run record that the
    // desktop surface reads; writing an explicit null where the field was simply
    // absent asserts "this run produced no artifact" as a fact it never observed.
    const patches: Partial<RunRecord>[] = [];
    const daemon = new Daemon(
      {
        store: stubStore([makeTask()], {
          finishRun: (_id, patch) => {
            patches.push(patch);
            return undefined;
          },
        }),
        dispatch: () => Promise.resolve(ok),
      },
      config
    );

    await daemon.tickOnce();
    await daemon.drain();

    expect(patches[0]).not.toHaveProperty("logPath");
  });

  it("records a dispatch that THROWS as a failed run, not a lost one", async () => {
    const patches: Partial<RunRecord>[] = [];
    const daemon = new Daemon(
      {
        store: stubStore([makeTask()], {
          finishRun: (_id, patch) => {
            patches.push(patch);
            return undefined;
          },
        }),
        dispatch: () => Promise.reject(new Error("harness blew up")),
      },
      config
    );

    await daemon.tickOnce();
    await daemon.drain();

    expect(patches[0]?.status).toBe(RunStatus.Failed);
    expect(patches[0]?.error).toBe("harness blew up");
  });

  it("records a dispatch that rejects with a NON-Error value", async () => {
    // A harness adapter can reject with a string; stringifying it keeps the run
    // record honest instead of persisting "undefined".
    const patches: Partial<RunRecord>[] = [];
    const daemon = new Daemon(
      {
        store: stubStore([makeTask()], {
          finishRun: (_id, patch) => {
            patches.push(patch);
            return undefined;
          },
        }),
        dispatch: () => Promise.reject("just a string"),
      },
      config
    );

    await daemon.tickOnce();
    await daemon.drain();

    expect(patches[0]?.error).toBe("just a string");
  });

  it("logs and swallows a store that throws from BOTH finishRun paths", async () => {
    // Distinct from `daemon-one-time-fire.test.ts:320`, which covers the same
    // store failure for a ONE-TIME task and asserts the fire stays spent. Here the
    // task is RECURRING: the point is that the launch promise never rejects (an
    // unhandled rejection would kill the daemon) and the in-flight guard still
    // clears so the task can run again.
    const logs: string[] = [];
    const task = makeTask({ recurring: true });
    const daemon = new Daemon(
      {
        store: stubStore([task], {
          finishRun: () => {
            throw new Error("disk full");
          },
        }),
        dispatch: () => Promise.resolve(ok),
        log: (m) => logs.push(m),
      },
      config
    );

    await daemon.tickOnce();
    await daemon.drain();

    expect(logs.some((l) => l.includes("record") && l.includes("FAILED"))).toBe(
      true
    );
    // The guard cleared, so a later tick can launch the task again. (The stub's
    // `startRun` deliberately leaves `lastRunAt` alone, so the task is still due.)
    const second = await daemon.tickOnce();
    expect(second.launched).toEqual([task.id]);
    await daemon.drain();
  });

  it("skips a task whose previous run is still in flight", async () => {
    // Distinct from `daemon.test.ts:253`: with the real store, `startRun` advances
    // `lastRunAt`, so the second tick exits as NOT DUE before the in-flight check
    // is ever consulted. This stub deliberately does not advance the cursor, so the
    // task stays due and the guard is the only thing that can stop a double launch.
    const logs: string[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<DispatchOutcome>((resolve) => {
      release = () => resolve(ok);
    });
    const task = makeTask();
    const daemon = new Daemon(
      {
        store: stubStore([task]),
        dispatch: () => blocked,
        log: (m) => logs.push(m),
      },
      config
    );

    const first = await daemon.tickOnce();
    const second = await daemon.tickOnce();

    expect(first.launched).toEqual([task.id]);
    expect(second.due).toEqual([task.id]); // still due…
    expect(second.launched).toEqual([]); // …but NOT launched again
    expect(logs.some((l) => l.includes("still in flight"))).toBe(true);

    release?.();
    await daemon.drain();
  });
});
