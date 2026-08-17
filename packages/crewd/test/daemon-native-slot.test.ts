/**
 * @file daemon-native-slot.test.ts
 * @description `Daemon.advanceNativeSlot` (ISS-5296) — the local cursor bookkeeping
 * for a task a CONFIRMED native scheduler owns.
 *
 * Split from `daemon-lifecycle.test.ts` when that file crossed the 500-line smell
 * line. The seam is real: this is cursor/timezone arithmetic, that file is
 * start/stop and run bookkeeping. Shared fixtures live in
 * `helpers/daemon-fixtures.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_OWNER_META_KEY,
  type ScheduledTask,
  TaskRoute,
} from "../src/model.js";
import { Daemon } from "../src/scheduler/daemon.js";
import {
  config,
  countingDispatch,
  makeTask,
  NOW,
  stubStore,
} from "./helpers/daemon-fixtures.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Daemon native-slot cursor advance", () => {
  function nativeTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
    return makeTask({
      route: TaskRoute.ClaudeScheduledTasks,
      meta: { [NATIVE_OWNER_META_KEY]: "owner-1" },
      ...over,
    });
  }

  it("advances a confirmed-native task's local cursor to the slot it skipped", async () => {
    // Claude ran this slot, so the local daemon must not. But the cursor still has
    // to move: a later flip back to local-cascade would otherwise `catchUp`-replay
    // a slot that already executed. Pinned to UTC so the expected instant does not
    // depend on the host's timezone.
    const task = nativeTask({ timezone: "UTC" });
    const { dispatch, calls } = countingDispatch();
    const daemon = new Daemon({ store: stubStore([task]), dispatch }, config);

    const report = await daemon.tickOnce();

    expect(calls()).toEqual([]); // never launched locally
    expect(report.launched).toEqual([]);
    expect(task.lastRunAt).toBe("2026-08-11T03:00:00.000Z");
  });

  it("leaves the cursor alone when the native task is NOT due at this tick", async () => {
    // Advancing a not-yet-due task would move its cursor past a slot that has not
    // happened, silently skipping the next real fire.
    const task = nativeTask({
      timezone: "UTC",
      lastRunAt: "2026-08-11T03:00:00.000Z",
    });
    const daemon = new Daemon(
      { store: stubStore([task]), dispatch: countingDispatch().dispatch },
      config
    );

    await daemon.tickOnce();

    expect(task.lastRunAt).toBe("2026-08-11T03:00:00.000Z");
  });

  it("leaves the cursor alone when a native task's cron is malformed", async () => {
    // One bad persisted row must not abort the tick and starve every later task.
    const task = nativeTask({ cron: "not a cron" });
    const daemon = new Daemon(
      { store: stubStore([task]), dispatch: countingDispatch().dispatch },
      config
    );

    await expect(daemon.tickOnce()).resolves.toBeDefined();
    expect(task.lastRunAt).toBeNull();
  });

  it("resolves the slot in the task's OWN timezone, not host-local", async () => {
    // Two identical `0 3 * * *` tasks that differ only in timezone must land on
    // DIFFERENT instants; if the field were dropped they would coincide. At
    // 2026-08-11T03:00:30Z the last 3am slot is that same instant in UTC, but
    // 2026-08-10T18:00Z in Tokyo (3am Aug 11 local). Asserting the delta rather
    // than one absolute keeps this independent of the host's own zone.
    const utc = nativeTask({ id: "utc", timezone: "UTC" });
    const tokyo = nativeTask({ id: "tokyo", timezone: "Asia/Tokyo" });
    const daemon = new Daemon(
      {
        store: stubStore([utc, tokyo]),
        dispatch: countingDispatch().dispatch,
      },
      config
    );

    await daemon.tickOnce();

    expect(utc.lastRunAt).toBe("2026-08-11T03:00:00.000Z");
    expect(tokyo.lastRunAt).toBe("2026-08-10T18:00:00.000Z");
  });
});
