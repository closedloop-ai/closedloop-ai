import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_ROUTINE_ID_META_KEY,
  NATIVE_OWNER_META_KEY,
  TaskRoute,
} from "../src/model.js";
import { Daemon, type Dispatch } from "../src/scheduler/daemon.js";
import { TaskStore } from "../src/scheduler/store.js";
import { config, countingDispatch, ok } from "./helpers/daemon-fixtures.js";

let dir: string;
let store: TaskStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crewd-daemon-"));
  store = new TaskStore(join(dir, "s.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Daemon.tickOnce", () => {
  it("fires a due task exactly once, then not again until the next slot", async () => {
    const t = store.upsertTask({
      name: "hourly",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
    });
    const { dispatch, calls } = countingDispatch();
    const at = new Date("2026-07-22T10:30:00Z");
    const d = new Daemon(
      { store, dispatch, now: () => at },
      { ...config, lockPath: join(dir, "l") }
    );

    const r1 = await d.tickOnce();
    await d.drain();
    expect(r1.launched).toEqual([t.id]);
    expect(calls()).toHaveLength(1);
    expect(store.getTask(t.id)?.lastStatus).toBe("success");

    const r2 = await d.tickOnce();
    await d.drain();
    expect(r2.launched).toEqual([]); // same slot already ran
    expect(calls()).toHaveLength(1);
  });

  it("never fires a disabled task", async () => {
    const t = store.upsertTask({
      name: "off",
      cron: "0 * * * *",
      kind: "custom",
      timezone: "UTC",
    });
    store.setEnabled(t.id, false);
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
      { ...config, lockPath: join(dir, "l") }
    );
    await d.tickOnce();
    await d.drain();
    expect(calls()).toHaveLength(0);
  });

  it("skips a CONFIRMED claude-routine task but still launches a local-cascade task (FEA-3912)", async () => {
    // A claude-routine task whose cloud ownership is CONFIRMED (the registrar
    // stamped a routine id) is owned by the Claude cloud routine; the local
    // daemon must NOT fire it too (double-execution). A local-cascade task on
    // the same due slot must still launch.
    const routed = store.upsertTask({
      name: "cloud",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      route: TaskRoute.ClaudeRoutine,
      meta: { [CLOUD_ROUTINE_ID_META_KEY]: "routine-cloud" },
    });
    const local = store.upsertTask({
      name: "local",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      route: TaskRoute.LocalCascade,
    });
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
      { ...config, lockPath: join(dir, "l") }
    );

    const report = await d.tickOnce();
    await d.drain();

    // The cloud-routed task is neither counted as locally due nor launched.
    expect(report.due).not.toContain(routed.id);
    expect(report.launched).not.toContain(routed.id);
    // The local-cascade task still fires exactly once.
    expect(report.launched).toEqual([local.id]);
    const launchedIds = calls().map((t) => t.id);
    expect(launchedIds).toEqual([local.id]);
    expect(launchedIds).not.toContain(routed.id);
    expect(store.getTask(routed.id)?.lastStatus).toBeNull();
    expect(store.getTask(local.id)?.lastStatus).toBe("success");
  });

  it("skips a CONFIRMED claude-scheduled-tasks task so it does not double-fire (FEA-3958)", async () => {
    // A claude-scheduled-tasks task whose native ownership is CONFIRMED (the
    // ScheduledTasksRegistrar stamped an owner id) is owned by Claude Code's
    // local scheduler; the daemon must NOT also fire it locally, or it runs
    // twice (once locally, once via Claude Code). This is the daemon-side half of
    // the native-route guard.
    const native = store.upsertTask({
      name: "native-local",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      route: TaskRoute.ClaudeScheduledTasks,
      meta: { [NATIVE_OWNER_META_KEY]: "entry-abc" },
    });
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
      { ...config, lockPath: join(dir, "l") }
    );

    const report = await d.tickOnce();
    await d.drain();

    expect(report.due).not.toContain(native.id);
    expect(report.launched).not.toContain(native.id);
    expect(calls()).toHaveLength(0);
    expect(store.getTask(native.id)?.lastStatus).toBeNull();
  });

  it("STILL launches a claude-scheduled-tasks task whose native ownership is UNCONFIRMED (FEA-3958)", async () => {
    // Opt-in to the native route but the writer never confirmed (ok:false / no
    // owner marker). Suppressing it would leave the task running nowhere, so the
    // daemon keeps firing it locally until ownership lands.
    const unconfirmed = store.upsertTask({
      name: "native-not-yet-owned",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      route: TaskRoute.ClaudeScheduledTasks,
      // No NATIVE_OWNER_META_KEY marker ⇒ ownership not confirmed.
    });
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
      { ...config, lockPath: join(dir, "l") }
    );

    const report = await d.tickOnce();
    await d.drain();

    expect(report.launched).toEqual([unconfirmed.id]);
    expect(calls().map((t) => t.id)).toEqual([unconfirmed.id]);
    expect(store.getTask(unconfirmed.id)?.lastStatus).toBe("success");
  });

  it("STILL launches a claude-routine task whose cloud ownership is UNCONFIRMED (FEA-3912)", async () => {
    // The operator flipped a task to claude-routine, but the cloud registration
    // failed or is unwired (the stub registrar reports ok:false) — no routine id
    // marker was stamped. Suppressing the local run here would leave the task
    // running NOWHERE, so the daemon must keep firing it locally until ownership
    // is actually confirmed.
    const unconfirmed = store.upsertTask({
      name: "opt-in-not-yet-owned",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      route: TaskRoute.ClaudeRoutine,
      // No CLOUD_ROUTINE_ID_META_KEY marker ⇒ ownership not confirmed.
    });
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
      { ...config, lockPath: join(dir, "l") }
    );

    const report = await d.tickOnce();
    await d.drain();

    expect(report.launched).toEqual([unconfirmed.id]);
    expect(calls().map((t) => t.id)).toEqual([unconfirmed.id]);
    expect(store.getTask(unconfirmed.id)?.lastStatus).toBe("success");
  });

  it("advances a CONFIRMED cloud task's local lastRunAt cursor so a flip back does not replay (FEA-3912)", async () => {
    // While the cloud owns the task, each due tick must advance the local cursor
    // to the slot the cloud ran — so a later flip back to local-cascade with
    // catchUp does NOT replay a slot the cloud already executed.
    const at = new Date("2026-07-22T10:30:00Z");
    const routed = store.upsertTask({
      name: "cloud",
      cron: "0 * * * *", // fires at the top of each hour → last slot is 10:00Z
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      route: TaskRoute.ClaudeRoutine,
      meta: { [CLOUD_ROUTINE_ID_META_KEY]: "routine-cloud" },
    });
    // Baseline: cursor well before the 10:00Z slot, so the task is due now.
    store.upsertTask({
      id: routed.id,
      name: "cloud",
      cron: "0 * * * *",
      route: TaskRoute.ClaudeRoutine,
      meta: { [CLOUD_ROUTINE_ID_META_KEY]: "routine-cloud" },
      lastRunAt: new Date("2026-07-22T09:00:00Z").toISOString(),
    });
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      { store, dispatch, now: () => at },
      { ...config, lockPath: join(dir, "l") }
    );

    await d.tickOnce();
    await d.drain();

    // The cloud task never fired locally, but its cursor advanced to the 10:00Z
    // slot the cloud ran.
    expect(calls()).toHaveLength(0);
    expect(store.getTask(routed.id)?.lastRunAt).toBe(
      new Date("2026-07-22T10:00:00Z").toISOString()
    );

    // Flip back to local-cascade (clear the confirmed marker). The next tick at
    // the SAME slot must NOT replay 10:00Z (the cursor already moved past it).
    store.upsertTask({
      id: routed.id,
      name: "cloud",
      cron: "0 * * * *",
      route: TaskRoute.LocalCascade,
      meta: {},
      lastRunAt: store.getTask(routed.id)?.lastRunAt ?? undefined,
    });
    const r2 = await d.tickOnce();
    await d.drain();
    expect(r2.launched).toEqual([]);
    expect(calls()).toHaveLength(0);
  });

  it("guards against launching a task whose previous run is still in flight", async () => {
    store.upsertTask({
      name: "slow",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const dispatch: Dispatch = async () => {
      await gate;
      return ok;
    };
    const d = new Daemon(
      { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
      { ...config, lockPath: join(dir, "l") }
    );
    const a = await d.tickOnce(); // launches, dispatch parked on gate
    const b = await d.tickOnce(); // in-flight guard → no relaunch
    expect(a.launched).toHaveLength(1);
    expect(b.launched).toHaveLength(0);
    release();
    await d.drain();
  });
});

describe("Daemon.runNow (FEA-3853)", () => {
  it("fires a task off-schedule and records its run", async () => {
    // A yearly cron that is NOT due at `now`.
    const task = store.upsertTask({
      name: "manual",
      cron: "0 9 1 1 *",
      kind: "custom",
      timezone: "UTC",
    });
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
      { ...config, lockPath: join(dir, "l") }
    );

    expect(d.runNow(task.id)).toBe(true);
    await d.drain();

    // The dispatch ran for the task, and a finished run was recorded.
    expect(calls()).toHaveLength(1);
    const runs = store.listRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.finishedAt).toBeTruthy();
  });

  it("rejects runNow for a CONFIRMED claude-routine task (FEA-3912)", async () => {
    // "Run now" on a task a confirmed cloud routine owns would locally
    // double-fire against the cloud routine, so the daemon rejects it (the UI
    // routes such a manual fire to the cloud owner instead).
    const cloud = store.upsertTask({
      name: "cloud manual",
      cron: "0 9 1 1 *",
      kind: "custom",
      timezone: "UTC",
      route: TaskRoute.ClaudeRoutine,
      meta: { [CLOUD_ROUTINE_ID_META_KEY]: "routine-cloud" },
    });
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
      { ...config, lockPath: join(dir, "l") }
    );

    expect(d.runNow(cloud.id)).toBe(false);
    await d.drain();
    // No local run was dispatched or recorded.
    expect(calls()).toHaveLength(0);
    expect(store.listRuns(cloud.id)).toHaveLength(0);
  });

  it("rejects runNow for a CONFIRMED claude-scheduled-tasks task (FEA-3958)", async () => {
    // "Run now" on a task Claude Code's local scheduler owns would locally
    // double-fire, so the daemon rejects it the same way it rejects a confirmed
    // cloud routine.
    const native = store.upsertTask({
      name: "native manual",
      cron: "0 9 1 1 *",
      kind: "custom",
      timezone: "UTC",
      route: TaskRoute.ClaudeScheduledTasks,
      meta: { [NATIVE_OWNER_META_KEY]: "entry-abc" },
    });
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
      { ...config, lockPath: join(dir, "l") }
    );

    expect(d.runNow(native.id)).toBe(false);
    await d.drain();
    expect(calls()).toHaveLength(0);
    expect(store.listRuns(native.id)).toHaveLength(0);
  });

  it("still allows runNow for an UNCONFIRMED claude-routine task (FEA-3912)", async () => {
    // Ownership not confirmed (no marker) ⇒ the task is still locally owned, so a
    // manual "Run now" must fire it locally.
    const unconfirmed = store.upsertTask({
      name: "opt-in manual",
      cron: "0 9 1 1 *",
      kind: "custom",
      timezone: "UTC",
      route: TaskRoute.ClaudeRoutine,
    });
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
      { ...config, lockPath: join(dir, "l") }
    );

    expect(d.runNow(unconfirmed.id)).toBe(true);
    await d.drain();
    expect(calls()).toHaveLength(1);
    expect(store.listRuns(unconfirmed.id)).toHaveLength(1);
  });

  it("rejects runNow for a one-time task whose fire cursor is spent (ISS-4814)", async () => {
    // The post-ISS-4814 retired shape: the task is still ENABLED (the operator
    // never paused it) and only the durable fire cursor marks the fire as spent.
    // "Run now" must not re-fire it — fire-once holds for the manual path too.
    const t = store.upsertTask({
      name: "spent one-time",
      cron: "0 9 1 1 *",
      kind: "custom",
      timezone: "UTC",
      recurring: false,
      route: TaskRoute.LocalCascade,
      firedAt: "2026-07-22T09:00:00.000Z",
    });
    expect(store.getTask(t.id)?.enabled).toBe(true);
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
      { ...config, lockPath: join(dir, "l") }
    );

    expect(d.runNow(t.id)).toBe(false);
    await d.drain();
    expect(calls()).toHaveLength(0);
    expect(store.listRuns(t.id)).toHaveLength(0);
  });

  it("rejects runNow for a one-time task retired the pre-ISS-4814 way (disabled, no cursor)", async () => {
    // Compatibility: a store written by a build that retired one-time tasks by
    // DISABLING them carries no fire cursor. That shape must stay rejected after
    // an upgrade, or the manual path would re-fire an already-spent task.
    const t = store.upsertTask({
      name: "retired one-time",
      cron: "0 9 1 1 *",
      kind: "custom",
      timezone: "UTC",
      recurring: false,
      route: TaskRoute.LocalCascade,
    });
    store.setEnabled(t.id, false); // the legacy post-retirement state
    expect(store.getTask(t.id)?.firedAt).toBeNull();
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
      { ...config, lockPath: join(dir, "l") }
    );

    expect(d.runNow(t.id)).toBe(false);
    await d.drain();
    expect(calls()).toHaveLength(0);
    expect(store.listRuns(t.id)).toHaveLength(0);
  });

  it("stamps the fire cursor when runNow fires a one-time task", async () => {
    // The manual path goes through the same `startRun` seam, so a manual fire
    // spends the one-time fire durably too.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:30:00Z"));
    try {
      const t = store.upsertTask({
        name: "manual one-time",
        cron: "0 9 1 1 *",
        kind: "custom",
        timezone: "UTC",
        recurring: false,
        route: TaskRoute.LocalCascade,
      });
      const { dispatch, calls } = countingDispatch();
      const d = new Daemon(
        { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
        { ...config, lockPath: join(dir, "l") }
      );

      expect(d.runNow(t.id)).toBe(true);
      await d.drain();
      expect(calls()).toHaveLength(1);
      expect(store.getTask(t.id)?.firedAt).toBe("2026-07-22T10:30:00.000Z");
      // A second manual fire is rejected by the now-spent cursor.
      expect(d.runNow(t.id)).toBe(false);
      await d.drain();
      expect(calls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still allows runNow for a manually-disabled RECURRING task (pause is overridable)", async () => {
    // Disabling a recurring task is an operator pause; an explicit manual fire is
    // meant to override that. The retired-one-time gate keys on recurring=false,
    // so a disabled recurring task stays manually fireable.
    const t = store.upsertTask({
      name: "paused recurring",
      cron: "0 9 1 1 *",
      kind: "custom",
      timezone: "UTC",
      recurring: true,
      route: TaskRoute.LocalCascade,
    });
    store.setEnabled(t.id, false);
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
      { ...config, lockPath: join(dir, "l") }
    );

    expect(d.runNow(t.id)).toBe(true);
    await d.drain();
    expect(calls()).toHaveLength(1);
    expect(store.listRuns(t.id)).toHaveLength(1);
  });

  it("returns false for an unknown id and for a task already in flight", async () => {
    const task = store.upsertTask({
      name: "parked",
      cron: "0 9 1 1 *",
      kind: "custom",
      timezone: "UTC",
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const dispatch: Dispatch = async () => {
      await gate;
      return ok;
    };
    const d = new Daemon(
      { store, dispatch, now: () => new Date("2026-07-22T10:30:00Z") },
      { ...config, lockPath: join(dir, "l") }
    );

    expect(d.runNow("missing")).toBe(false);
    expect(d.runNow(task.id)).toBe(true); // launched, parked on the gate
    expect(d.runNow(task.id)).toBe(false); // in-flight guard blocks a re-fire
    release();
    await d.drain();
  });
});
