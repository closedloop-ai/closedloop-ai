/**
 * FEA-4069 — the native `claude-scheduled-tasks` route executes end-to-end from
 * the JSON `TaskStore` (the `crewd` CLI's store), with the daemon standing down
 * as the confirmed-owner backup. These are BEHAVIORAL tests: they drive the store
 * + writer + daemon through the real code path and assert the observable effect
 * (the on-disk Claude entry, the stamped owner marker, whether the daemon fires),
 * not implementation details. No timing assertions.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasConfirmedNativeOwner,
  NATIVE_OWNER_META_KEY,
  type ScheduledTask,
  TaskRoute,
} from "../src/model.js";
import { prevRun } from "../src/scheduler/cron.js";
import {
  Daemon,
  type Dispatch,
  type DispatchOutcome,
} from "../src/scheduler/daemon.js";
import { createScheduledTasksWriter } from "../src/scheduler/native-scheduled-tasks.js";
import { TaskStore } from "../src/scheduler/store.js";

let dir: string;
let storePath: string;
let nativePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crewd-fea4069-"));
  storePath = join(dir, "scheduled_tasks.json");
  nativePath = join(dir, "claude", "scheduled_tasks.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A store wired to a native writer pointed at a temp Claude file. */
function makeStore(): TaskStore {
  return new TaskStore(storePath, {
    scheduledTasksRegistrar: createScheduledTasksWriter({ path: nativePath }),
  });
}

function readNativeEntries(): Array<{ id: string; cron: string }> {
  const parsed = JSON.parse(readFileSync(nativePath, "utf8")) as {
    tasks: Array<{ id: string; cron: string }>;
  };
  return parsed.tasks;
}

const ok: DispatchOutcome = {
  status: "success",
  harnessUsed: "claude",
  attempts: [],
  summary: "ok",
  error: null,
};

function countingDispatch(): { dispatch: Dispatch; calls: () => string[] } {
  const seen: string[] = [];
  const dispatch: Dispatch = (task) => {
    seen.push(task.id);
    return Promise.resolve(ok);
  };
  return { dispatch, calls: () => seen };
}

describe("TaskStore native-schedule reconcile (FEA-4069)", () => {
  it("materializes an enabled native task into Claude's file and confirms the owner", async () => {
    const store = makeStore();
    const task = store.upsertTask({
      name: "nightly-produce",
      cron: "0 3 * * *",
      prompt: "run the produce loop",
      route: TaskRoute.ClaudeScheduledTasks,
      timezone: "",
    });
    await store.whenReconciled();

    // The task's timing is now materialized into Claude Code's file.
    expect(existsSync(nativePath)).toBe(true);
    const entries = readNativeEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(task.id);
    expect(entries[0]?.cron).toBe("0 3 * * *");

    // …and the confirmed-owner marker is stamped, so the daemon will suppress it.
    const stored = store.getTask(task.id) as ScheduledTask;
    expect(stored.meta[NATIVE_OWNER_META_KEY]).toBe(task.id);
    expect(hasConfirmedNativeOwner(stored)).toBe(true);
  });

  it("keeps an UNREPRESENTABLE native task daemon-owned (empty prompt → no owner)", async () => {
    const store = makeStore();
    const task = store.upsertTask({
      name: "no-prompt",
      cron: "0 3 * * *",
      prompt: "",
      route: TaskRoute.ClaudeScheduledTasks,
      timezone: "",
    });
    await store.whenReconciled();

    // The writer rejected it (empty prompt), so no entry and no owner marker:
    // the daemon keeps running it locally rather than dropping it nowhere.
    expect(existsSync(nativePath)).toBe(false);
    const stored = store.getTask(task.id) as ScheduledTask;
    expect(stored.meta[NATIVE_OWNER_META_KEY]).toBeUndefined();
    expect(hasConfirmedNativeOwner(stored)).toBe(false);
  });

  it("deregisters (removes the native entry + clears owner) on a flip back to local-cascade", async () => {
    const store = makeStore();
    const task = store.upsertTask({
      name: "flip",
      cron: "0 3 * * *",
      prompt: "do work",
      route: TaskRoute.ClaudeScheduledTasks,
      timezone: "",
    });
    await store.whenReconciled();
    expect(readNativeEntries()).toHaveLength(1);

    store.upsertTask({ ...task, route: TaskRoute.LocalCascade });
    await store.whenReconciled();

    // The native entry is gone and the owner marker is cleared, so the daemon
    // takes the task back.
    expect(readNativeEntries()).toHaveLength(0);
    const stored = store.getTask(task.id) as ScheduledTask;
    expect(stored.meta[NATIVE_OWNER_META_KEY]).toBeUndefined();
    expect(hasConfirmedNativeOwner(stored)).toBe(false);
  });

  it("removes the native entry when a native task is disabled", async () => {
    const store = makeStore();
    const task = store.upsertTask({
      name: "toggle",
      cron: "0 3 * * *",
      prompt: "do work",
      route: TaskRoute.ClaudeScheduledTasks,
      timezone: "",
    });
    await store.whenReconciled();
    expect(readNativeEntries()).toHaveLength(1);

    store.setEnabled(task.id, false);
    await store.whenReconciled();

    expect(readNativeEntries()).toHaveLength(0);
    const stored = store.getTask(task.id) as ScheduledTask;
    expect(hasConfirmedNativeOwner(stored)).toBe(false);
  });

  it("removes the native entry when a native task is deleted", async () => {
    const store = makeStore();
    const task = store.upsertTask({
      name: "doomed",
      cron: "0 3 * * *",
      prompt: "do work",
      route: TaskRoute.ClaudeScheduledTasks,
      timezone: "",
    });
    await store.whenReconciled();
    expect(readNativeEntries()).toHaveLength(1);

    store.removeTask(task.id);
    await store.whenReconciled();
    expect(readNativeEntries()).toHaveLength(0);
  });

  it("preserves an unrelated Claude schedule when materializing a crew task", async () => {
    // First materialize a crew task so the writer creates the file + dir…
    const store = makeStore();
    const seed = store.upsertTask({
      name: "seed",
      cron: "0 1 * * *",
      prompt: "seed work",
      route: TaskRoute.ClaudeScheduledTasks,
      timezone: "",
    });
    await store.whenReconciled();
    // …then hand-add a foreign Claude entry beside it (simulating an entry the
    // operator created directly in Claude Code).
    const current = JSON.parse(readFileSync(nativePath, "utf8")) as {
      tasks: Array<{ id: string; cron: string; prompt: string }>;
    };
    current.tasks.push({
      id: "foreign-1",
      cron: "0 9 * * *",
      prompt: "theirs",
    });
    writeFileSync(nativePath, JSON.stringify(current, null, 2), "utf8");

    // A second crew task must merge, not clobber the foreign entry.
    const second = store.upsertTask({
      name: "second",
      cron: "0 5 * * *",
      prompt: "more work",
      route: TaskRoute.ClaudeScheduledTasks,
      timezone: "",
    });
    await store.whenReconciled();

    const ids = readNativeEntries()
      .map((e) => e.id)
      .sort();
    expect(ids).toEqual([second.id, seed.id, "foreign-1"].sort());
  });
});

describe("Daemon owner handoff for a native task (FEA-4069)", () => {
  it("does NOT fire a confirmed-native task locally (Claude owns it), but advances the local cursor", async () => {
    const store = makeStore();
    // A native-materializable task has host-local timezone (Claude's file has no
    // timezone field, so the writer rejects a pinned tz — see toClaudeEntry).
    const task = store.upsertTask({
      name: "native-owned",
      cron: "0 * * * *",
      prompt: "hourly work",
      route: TaskRoute.ClaudeScheduledTasks,
      timezone: "",
    });
    await store.whenReconciled();
    expect(
      hasConfirmedNativeOwner(store.getTask(task.id) as ScheduledTask)
    ).toBe(true);

    const { dispatch, calls } = countingDispatch();
    const at = new Date("2026-07-22T10:30:00Z");
    const daemon = new Daemon(
      { store, dispatch, now: () => at },
      { defaultCascade: [{ harness: "claude" }], lockPath: join(dir, "l") }
    );

    const report = await daemon.tickOnce();
    await daemon.drain();

    // The daemon skipped its own run for the confirmed-native slot — no double
    // fire — and advanced lastRunAt to the slot so a later flip back to
    // local-cascade does not catchUp-replay the slot Claude already ran.
    expect(calls()).toEqual([]);
    expect(report.launched).toEqual([]);
    const cursor = store.getTask(task.id)?.lastRunAt;
    const expectedSlot = prevRun("0 * * * *", at)?.toISOString();
    expect(cursor).toBe(expectedSlot);
  });

  it("DOES fire a native-route task locally while its ownership is unconfirmed (honest fallback)", async () => {
    // No native registrar wired ⇒ route persists as intent but no owner is
    // confirmed, so the daemon must keep running it locally (never nowhere).
    const store = new TaskStore(storePath);
    const task = store.upsertTask({
      name: "unconfirmed-native",
      cron: "0 * * * *",
      prompt: "hourly work",
      route: TaskRoute.ClaudeScheduledTasks,
      timezone: "UTC",
    });
    expect(
      hasConfirmedNativeOwner(store.getTask(task.id) as ScheduledTask)
    ).toBe(false);

    const { dispatch, calls } = countingDispatch();
    const at = new Date("2026-07-22T10:30:00Z");
    const daemon = new Daemon(
      { store, dispatch, now: () => at },
      { defaultCascade: [{ harness: "claude" }], lockPath: join(dir, "l") }
    );
    await daemon.tickOnce();
    await daemon.drain();

    expect(calls()).toEqual([task.id]);
  });
});

describe("TaskStore.reconcileNativeSchedulesOnStartup (FEA-4069)", () => {
  it("re-materializes + re-confirms an enabled native task added before a registrar was wired", async () => {
    // First invocation: NO registrar, so the native route persists but nothing
    // was materialized and no owner was confirmed (the pre-FEA-4069 CLI state).
    const cold = new TaskStore(storePath);
    const task = cold.upsertTask({
      name: "pre-existing",
      cron: "0 3 * * *",
      prompt: "do work",
      route: TaskRoute.ClaudeScheduledTasks,
      timezone: "",
    });
    expect(existsSync(nativePath)).toBe(false);
    expect(
      hasConfirmedNativeOwner(cold.getTask(task.id) as ScheduledTask)
    ).toBe(false);

    // Second invocation (a fresh `crewd start`): the store hydrates the same file
    // and the startup pass materializes + confirms the enabled native task.
    const warm = makeStore();
    warm.reconcileNativeSchedulesOnStartup();
    await warm.whenReconciled();

    expect(readNativeEntries().map((e) => e.id)).toEqual([task.id]);
    expect(
      hasConfirmedNativeOwner(warm.getTask(task.id) as ScheduledTask)
    ).toBe(true);
  });
});
