/**
 * @file daemon-one-time-fire.test.ts
 * @description The fire-once contract for `recurring: false` scheduled tasks
 * (ISS-4736, then ISS-4814's durable `firedAt` cursor). Split out of
 * daemon.test.ts when that file crossed the 1,000-line ceiling; this is the
 * cohesive slice covering how a one-time task is retired, how that retirement
 * survives a crash, and how it degrades against a version-skewed store.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasSpentOneTimeFire,
  shouldStampFireCursor,
  TaskRoute,
} from "../src/model.js";
import {
  Daemon,
  type Dispatch,
  type DispatchOutcome,
} from "../src/scheduler/daemon.js";
import { TaskStore } from "../src/scheduler/store.js";
import type { StorePort } from "../src/scheduler/store-port.js";
import { config, countingDispatch, ok } from "./helpers/daemon-fixtures.js";

let dir: string;
let store: TaskStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crewd-daemon-"));
  store = new TaskStore(join(dir, "s.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Daemon.tickOnce recurring=false (ISS-4736 / ISS-4814)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin the wall clock so `store.startRun`'s `firedAt`/`updatedAt` stamps and
    // the schema's ISO-timestamp fields are deterministic; the daemon reads time
    // through the injected `now`, but the store still uses `new Date()`.
    vi.setSystemTime(new Date("2026-07-22T10:30:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a one-time task once, then never again (durable fire cursor, not the enabled pause)", async () => {
    const t = store.upsertTask({
      name: "one-time",
      cron: "0 * * * *", // hourly
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      recurring: false,
      route: TaskRoute.LocalCascade,
    });
    const { dispatch, calls } = countingDispatch();
    // Second tick is at the NEXT hour's slot — a slot the task WOULD be due for
    // if it were still recurring — proving the cursor, not "already-ran", stops it.
    let at = new Date("2026-07-22T10:30:00Z");
    const d = new Daemon(
      { store, dispatch, now: () => at },
      { ...config, lockPath: join(dir, "l") }
    );

    const r1 = await d.tickOnce();
    await d.drain();
    expect(r1.launched).toEqual([t.id]);
    expect(calls()).toHaveLength(1);
    // ISS-4814: the fire cursor carries the retirement, and `enabled` is left
    // alone so it keeps meaning "operator pause" and nothing else.
    expect(store.getTask(t.id)?.firedAt).toBe("2026-07-22T10:30:00.000Z");
    expect(store.getTask(t.id)?.enabled).toBe(true);

    at = new Date("2026-07-22T11:30:00Z"); // a fresh matching cron slot
    const r2 = await d.tickOnce();
    await d.drain();
    expect(r2.due).not.toContain(t.id);
    expect(r2.launched).toEqual([]);
    expect(calls()).toHaveLength(1); // still exactly one launch
  });

  it("does not re-fire a one-time task after the daemon dies mid-run and restarts (ISS-4814 crash window)", async () => {
    // THE crash window: the daemon is killed AFTER `startRun` persisted the
    // launch but BEFORE the run reaches any terminal bookkeeping. A restarted
    // daemon re-reads the store from disk; `lastRunAt` alone would only suppress
    // the slot that was already running, so the next matching slot must be
    // blocked by the durable fire cursor instead.
    const t = store.upsertTask({
      name: "one-time-crashing",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      recurring: false,
      route: TaskRoute.LocalCascade,
    });
    // A dispatch that never settles == the process died mid-run: nothing after
    // the launch ever executes, so no completion-time retirement can happen.
    const neverSettles: Dispatch = () => new Promise<DispatchOutcome>(() => {});
    const crashed = new Daemon(
      {
        store,
        dispatch: neverSettles,
        now: () => new Date("2026-07-22T10:30:00Z"),
      },
      { ...config, lockPath: join(dir, "l") }
    );
    const r1 = await crashed.tickOnce();
    expect(r1.launched).toEqual([t.id]);
    // The run is still `running` — this daemon never recorded a terminal status.
    expect(store.getTask(t.id)?.lastStatus).toBe("running");

    // Restart: a brand-new daemon over a brand-new store hydrated from the SAME
    // file on disk (no shared in-memory state with the dead process).
    const restarted = new TaskStore(join(dir, "s.json"));
    expect(restarted.getTask(t.id)?.firedAt).toBe("2026-07-22T10:30:00.000Z");
    expect(restarted.getTask(t.id)?.enabled).toBe(true);
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      {
        store: restarted,
        dispatch,
        // A LATER matching cron slot — the task would be due again if the fire
        // were not already recorded as spent.
        now: () => new Date("2026-07-22T12:30:00Z"),
      },
      { ...config, lockPath: join(dir, "l") }
    );

    const r2 = await d.tickOnce();
    await d.drain();
    expect(r2.due).not.toContain(t.id);
    expect(r2.launched).toEqual([]);
    expect(calls()).toHaveLength(0);
    expect(restarted.listRuns(t.id)).toHaveLength(1); // still the one crashed run
  });

  it("treats a persisted row with no fire cursor as NOT yet fired (version skew)", async () => {
    // A one-time row written by a build that predates the `firedAt` column
    // hydrates through the schema default (null). It must still be eligible for
    // its first fire — an absent cursor may never be read as "already fired".
    const t = store.upsertTask({
      name: "legacy-one-time",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      recurring: false,
      route: TaskRoute.LocalCascade,
    });
    expect(store.getTask(t.id)?.firedAt).toBeNull();
    const { dispatch, calls } = countingDispatch();
    let at = new Date("2026-07-22T10:30:00Z");
    const d = new Daemon(
      { store, dispatch, now: () => at },
      { ...config, lockPath: join(dir, "l") }
    );

    const r1 = await d.tickOnce();
    await d.drain();
    expect(r1.launched).toEqual([t.id]); // the legacy row fired
    expect(calls()).toHaveLength(1);

    at = new Date("2026-07-22T11:30:00Z");
    await d.tickOnce();
    await d.drain();
    expect(calls()).toHaveLength(1); // and is spent afterwards
  });

  it("keeps an operator-PAUSED one-time task distinguishable from a fired one", async () => {
    // `enabled` is the operator pause; `firedAt` is the fire cursor. A one-time
    // task paused BEFORE it ever fired carries no cursor, so re-enabling it must
    // let it fire — the pause must never be mistaken for a spent fire.
    const t = store.upsertTask({
      name: "paused-one-time",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      recurring: false,
      route: TaskRoute.LocalCascade,
    });
    store.setEnabled(t.id, false);
    const { dispatch, calls } = countingDispatch();
    let at = new Date("2026-07-22T10:30:00Z");
    const d = new Daemon(
      { store, dispatch, now: () => at },
      { ...config, lockPath: join(dir, "l") }
    );

    await d.tickOnce();
    await d.drain();
    expect(calls()).toHaveLength(0); // paused ⇒ no fire
    expect(store.getTask(t.id)?.firedAt).toBeNull(); // and NOT marked as fired

    // Operator un-pauses at a later slot: the task still owes its one fire. The
    // store stamps the cursor off the wall clock, so advance both clocks.
    store.setEnabled(t.id, true);
    at = new Date("2026-07-22T11:30:00Z");
    vi.setSystemTime(at);
    const r2 = await d.tickOnce();
    await d.drain();
    expect(r2.launched).toEqual([t.id]);
    expect(calls()).toHaveLength(1);
    expect(store.getTask(t.id)?.firedAt).toBe("2026-07-22T11:30:00.000Z");
  });

  it("falls back to disabling a one-time task when the store does not stamp a fire cursor", async () => {
    // Version skew the other way: a `StorePort` adapter built against the older
    // contract records the run but never stamps `firedAt`. The daemon detects the
    // missing cursor right after `startRun` and retires the task the legacy way
    // (disable) — still at run START, so the crash window stays closed.
    const t = store.upsertTask({
      name: "one-time-legacy-store",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      recurring: false,
      route: TaskRoute.LocalCascade,
    });
    const realStartRun = store.startRun.bind(store);
    vi.spyOn(store, "startRun").mockImplementation((task) => {
      const rec = realStartRun(task);
      // Strip the cursor the real store just wrote, emulating a store that never
      // knew about it.
      const persisted = store.getTask(task.id);
      if (persisted) {
        store.upsertTask({ ...persisted, firedAt: null });
      }
      return rec;
    });
    const { dispatch, calls } = countingDispatch();
    let at = new Date("2026-07-22T10:30:00Z");
    const d = new Daemon(
      { store, dispatch, now: () => at },
      { ...config, lockPath: join(dir, "l") }
    );

    const r1 = await d.tickOnce();
    await d.drain();
    expect(r1.launched).toEqual([t.id]);
    expect(calls()).toHaveLength(1);
    expect(store.getTask(t.id)?.firedAt).toBeNull();
    expect(store.getTask(t.id)?.enabled).toBe(false); // legacy retirement applied

    at = new Date("2026-07-22T11:30:00Z");
    const r2 = await d.tickOnce();
    await d.drain();
    expect(r2.launched).toEqual([]);
    expect(calls()).toHaveLength(1); // never re-fired
  });

  it("keeps firing a recurring task at each matching slot", async () => {
    const t = store.upsertTask({
      name: "recurring",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      recurring: true,
      route: TaskRoute.LocalCascade,
    });
    const { dispatch, calls } = countingDispatch();
    let at = new Date("2026-07-22T10:30:00Z");
    const d = new Daemon(
      { store, dispatch, now: () => at },
      { ...config, lockPath: join(dir, "l") }
    );

    await d.tickOnce();
    await d.drain();
    expect(calls()).toHaveLength(1);
    expect(store.getTask(t.id)?.enabled).toBe(true);

    at = new Date("2026-07-22T11:30:00Z"); // next hourly slot
    const r2 = await d.tickOnce();
    await d.drain();
    expect(r2.launched).toEqual([t.id]);
    expect(calls()).toHaveLength(2);
    expect(store.getTask(t.id)?.enabled).toBe(true);
  });

  it("treats a missing `recurring` field as recurring (version-skew default)", async () => {
    // A row written by an older build with no `recurring` column parses to the
    // schema default (`true`), so it must keep firing — never retire.
    const raw = store.snapshot();
    const t = store.upsertTask({
      name: "legacy",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      route: TaskRoute.LocalCascade,
    });
    expect(raw.tasks).toHaveLength(0);
    // Guard: the task carries the defaulted `recurring: true`, not `false`.
    expect(store.getTask(t.id)?.recurring).toBe(true);
    const { dispatch, calls } = countingDispatch();
    let at = new Date("2026-07-22T10:30:00Z");
    const d = new Daemon(
      { store, dispatch, now: () => at },
      { ...config, lockPath: join(dir, "l") }
    );

    await d.tickOnce();
    await d.drain();
    expect(calls()).toHaveLength(1);

    at = new Date("2026-07-22T11:30:00Z");
    const r2 = await d.tickOnce();
    await d.drain();
    expect(r2.launched).toEqual([t.id]);
    expect(calls()).toHaveLength(2);
    expect(store.getTask(t.id)?.enabled).toBe(true);
  });

  it("clears the in-flight guard when run bookkeeping throws, and the one-time fire stays spent", async () => {
    // If `store.finishRun` throws (read-only/full file-backed store, or a
    // rejecting adapter), the in-flight guard must STILL be cleared — otherwise
    // every later tick sees the task as permanently running and never launches
    // it — and the launch promise must not reject (it is fire-and-forget, so an
    // unhandled rejection would kill the daemon). The fire cursor was written by
    // `startRun`, so the one-time task is spent regardless of the lost
    // bookkeeping.
    const t = store.upsertTask({
      name: "one-time-throwing-store",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      recurring: false,
      route: TaskRoute.LocalCascade,
    });
    vi.spyOn(store, "finishRun").mockImplementation(() => {
      throw new Error("EROFS: read-only file system");
    });
    const { dispatch, calls } = countingDispatch();
    let at = new Date("2026-07-22T10:30:00Z");
    const d = new Daemon(
      { store, dispatch, now: () => at },
      { ...config, lockPath: join(dir, "l") }
    );

    const r1 = await d.tickOnce();
    await d.drain(); // must resolve — no unhandled rejection, no leaked guard
    expect(r1.launched).toEqual([t.id]);
    expect(calls()).toHaveLength(1);
    expect(store.getTask(t.id)?.firedAt).toBe("2026-07-22T10:30:00.000Z");

    // Next matching slot: the guard was cleared (a recurring task would re-fire
    // here), and the spent one-time fire keeps this one from launching again.
    at = new Date("2026-07-22T11:30:00Z");
    const r2 = await d.tickOnce();
    await d.drain();
    expect(r2.launched).toEqual([]);
    expect(calls()).toHaveLength(1);
  });

  it("honors a mid-run edit to recurring=true (the task keeps firing, no clobber)", async () => {
    // A slow one-time run is in flight; the operator edits it to recurring=true
    // through the store. The start-of-run fire cursor is already stamped, but it
    // is only load-bearing while `recurring` is false — so the now-recurring task
    // must stay enabled AND keep firing at later slots.
    const t = store.upsertTask({
      name: "edited-mid-run",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      recurring: false,
      route: TaskRoute.LocalCascade,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let dispatchCalls = 0;
    const dispatch: Dispatch = async () => {
      dispatchCalls += 1;
      await gate;
      return ok;
    };
    let at = new Date("2026-07-22T10:30:00Z");
    const d = new Daemon(
      { store, dispatch, now: () => at },
      { ...config, lockPath: join(dir, "l") }
    );

    const r1 = await d.tickOnce(); // launches, dispatch parked on the gate
    expect(r1.launched).toEqual([t.id]);
    // Concurrent edit: flip the persisted row to recurring=true while in flight.
    store.upsertTask({ id: t.id, name: t.name, cron: t.cron, recurring: true });
    release();
    await d.drain();

    expect(store.getTask(t.id)?.enabled).toBe(true);
    expect(store.getTask(t.id)?.recurring).toBe(true);

    // The edit is honored at the next matching slot: a recurring task fires
    // again even though the stale one-time cursor is still on the row.
    at = new Date("2026-07-22T11:30:00Z");
    const r2 = await d.tickOnce();
    await d.drain();
    expect(r2.launched).toEqual([t.id]);
    expect(dispatchCalls).toBe(2);
  });

  it("spends the one-time fire even when its first run FAILED (fire-once regardless)", async () => {
    const t = store.upsertTask({
      name: "one-time-failing",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      recurring: false,
      route: TaskRoute.LocalCascade,
    });
    let dispatchCalls = 0;
    const dispatch: Dispatch = () => {
      dispatchCalls += 1;
      return Promise.reject(new Error("boom"));
    };
    let at = new Date("2026-07-22T10:30:00Z");
    const d = new Daemon(
      { store, dispatch, now: () => at },
      { ...config, lockPath: join(dir, "l") }
    );

    const r1 = await d.tickOnce();
    await d.drain();
    expect(r1.launched).toEqual([t.id]);
    expect(dispatchCalls).toBe(1);
    expect(store.getTask(t.id)?.lastStatus).toBe("failed");
    expect(store.getTask(t.id)?.firedAt).toBe("2026-07-22T10:30:00.000Z");

    at = new Date("2026-07-22T11:30:00Z"); // next matching slot
    const r2 = await d.tickOnce();
    await d.drain();
    expect(r2.launched).toEqual([]);
    expect(dispatchCalls).toBe(1); // never re-fired
  });

  it("treats a task object that OMITS the firedAt key as not yet fired", async () => {
    // wongk on #4252: `undefined !== null`, so a `!== null` cursor check would
    // read every task from a pre-ISS-4814 `StorePort` — which returns raw task
    // objects that never went through `scheduledTaskSchema` and simply have no
    // `firedAt` key — as ALREADY SPENT, permanently stranding it. The key is
    // genuinely deleted here, not set to undefined, so the object matches what
    // such an adapter really hands over.
    const t = store.upsertTask({
      name: "keyless-one-time",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      recurring: false,
      route: TaskRoute.LocalCascade,
    });
    const keyless = { ...t };
    Reflect.deleteProperty(keyless, "firedAt");
    expect(Object.hasOwn(keyless, "firedAt")).toBe(false);
    expect(hasSpentOneTimeFire(keyless)).toBe(false); // NOT spent
    expect(shouldStampFireCursor(keyless)).toBe(true); // and still stampable

    // End to end: a store handing back that keyless row still fires it once.
    vi.spyOn(store, "listTasks").mockImplementation(() => [keyless]);
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
  });

  it("still applies the disable fallback for a keyless row the store never stamps", async () => {
    // The same `undefined`-vs-`null` confusion at the OTHER boundary
    // (`confirmOneTimeFireRecorded`): reading a missing key as a stamped cursor
    // would skip the advertised legacy retirement entirely, so a task backed by
    // an older adapter would be retired by neither path and re-fire forever.
    const t = store.upsertTask({
      name: "keyless-legacy-store",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      recurring: false,
      route: TaskRoute.LocalCascade,
    });
    const realStartRun = store.startRun.bind(store);
    vi.spyOn(store, "startRun").mockImplementation((task) => {
      const rec = realStartRun(task);
      const persisted = store.getTask(task.id);
      if (persisted) {
        // An older adapter's row: no cursor, and no `firedAt` key at all.
        const keyless = { ...persisted, firedAt: null };
        Reflect.deleteProperty(keyless, "firedAt");
        vi.spyOn(store, "getTask").mockReturnValue(keyless);
      }
      return rec;
    });
    const { dispatch, calls } = countingDispatch();
    const at = new Date("2026-07-22T10:30:00Z");
    const setEnabled = vi.spyOn(store, "setEnabled");
    const d = new Daemon(
      { store, dispatch, now: () => at },
      { ...config, lockPath: join(dir, "l") }
    );

    await d.tickOnce();
    await d.drain();
    expect(calls()).toHaveLength(1);
    // The fallback ran rather than being skipped by a phantom cursor.
    expect(setEnabled).toHaveBeenCalledWith(t.id, false);
  });

  it("waits for the launch write to be DURABLE before it dispatches", async () => {
    // wongk on #4252: stamping the cursor in `startRun` is only half the barrier
    // for a write-behind store — `startRun` returns after queueing, so a kill
    // after dispatch began but before the write landed still loses the cursor and
    // re-fires. The daemon must not dispatch until `whenRunDurable` resolves.
    const t = store.upsertTask({
      name: "durable-before-dispatch",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      recurring: false,
      route: TaskRoute.LocalCascade,
    });
    let release: (() => void) | undefined;
    const durable = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writeBehindStore: StorePort = {
      ...store,
      listTasks: () => store.listTasks(),
      getTask: (id) => store.getTask(id),
      upsertTask: (input) => store.upsertTask(input),
      removeTask: (id) => store.removeTask(id),
      setEnabled: (id, enabled) => store.setEnabled(id, enabled),
      refreshNextRuns: () => store.refreshNextRuns(),
      advanceLastRun: (id, iso) => store.advanceLastRun(id, iso),
      startRun: (task) => store.startRun(task),
      finishRun: (id, patch) => store.finishRun(id, patch),
      listRuns: (taskId, limit) => store.listRuns(taskId, limit),
      reload: () => store.reload(),
      snapshot: () => store.snapshot(),
      whenRunDurable: () => durable,
    };
    const { dispatch, calls } = countingDispatch();
    const d = new Daemon(
      {
        store: writeBehindStore,
        dispatch,
        now: () => new Date("2026-07-22T10:30:00Z"),
      },
      { ...config, lockPath: join(dir, "l") }
    );

    const r1 = await d.tickOnce();
    expect(r1.launched).toEqual([t.id]);
    // The launch record is already in the store, but nothing has been dispatched
    // — the harness cannot have produced a side effect yet.
    expect(store.listRuns(t.id)).toHaveLength(1);
    expect(calls()).toHaveLength(0);

    release?.();
    await d.drain();
    expect(calls()).toHaveLength(1); // dispatched only once the write landed
  });

  it("stops advertising a nextRunAt once the one-time fire is spent", async () => {
    // A spent one-time task deliberately stays `enabled`, so without an explicit
    // guard `computeNextRun` keeps publishing the next cron slot — a slot the
    // fire-once guard will always refuse. The task list must not promise a run
    // that can never happen.
    const t = store.upsertTask({
      name: "one-time-next-run",
      cron: "0 * * * *",
      kind: "custom",
      catchUp: true,
      timezone: "UTC",
      recurring: false,
      route: TaskRoute.LocalCascade,
    });
    expect(store.getTask(t.id)?.nextRunAt).not.toBeNull();
    const { dispatch } = countingDispatch();
    let at = new Date("2026-07-22T10:30:00Z");
    const d = new Daemon(
      { store, dispatch, now: () => at },
      { ...config, lockPath: join(dir, "l") }
    );

    await d.tickOnce();
    await d.drain();
    expect(store.getTask(t.id)?.firedAt).not.toBeNull();
    expect(store.getTask(t.id)?.enabled).toBe(true); // still an operator pause
    expect(store.getTask(t.id)?.nextRunAt).toBeNull();

    // And a later tick's refresh does not resurrect it.
    at = new Date("2026-07-22T11:30:00Z");
    await d.tickOnce();
    await d.drain();
    expect(store.getTask(t.id)?.nextRunAt).toBeNull();
  });
});
