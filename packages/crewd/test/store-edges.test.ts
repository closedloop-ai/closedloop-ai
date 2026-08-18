/**
 * @file store-edges.test.ts
 * @description Store behavior at the edges (ISS-5296): unknown ids, the bounded
 * run-history ring, and the native-registrar CONTRACT — what the store does when a
 * registrar answers in a way the happy path does not anticipate.
 *
 * Scope boundary — `store.test.ts` owns upsert defaults, hydration, route
 * normalization, and corrupt-file handling; `native-scheduled-tasks-store.test.ts`
 * owns the ordinary reconcile/owner-marker flow. Nothing here re-tests those.
 * A sibling file rather than growing either, so the throwing/misbehaving-registrar
 * scaffolding stays out of the plain-store suites.
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyStore,
  NATIVE_OWNER_META_KEY,
  RunStatus,
  runRecordSchema,
  type ScheduledTask,
  TaskRoute,
} from "../src/model.js";
import type { ScheduledTasksRegistrar } from "../src/scheduler/routine-registrar.js";
import {
  defaultStorePath,
  MAX_RUN_HISTORY,
  TaskStore,
} from "../src/scheduler/store.js";

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crewd-store-edges-"));
  storePath = join(dir, "scheduled_tasks.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A registrar whose register/deregister answers are scripted per test. */
function registrarThat(
  answer: () => Promise<{ ok: boolean; ownerId?: string; note?: string }>
): ScheduledTasksRegistrar {
  return { register: answer, deregister: answer } as ScheduledTasksRegistrar;
}

function seedTask(store: TaskStore, over: Partial<ScheduledTask> = {}) {
  return store.upsertTask({
    name: "nightly",
    cron: "0 3 * * *",
    prompt: "work",
    timezone: "",
    ...over,
  });
}

describe("TaskStore unknown-id handling", () => {
  it("setEnabled on an unknown id returns undefined and writes nothing", () => {
    const store = new TaskStore(storePath);
    seedTask(store);
    const before = readFileSync(storePath, "utf8");

    expect(store.setEnabled("no-such-task", false)).toBeUndefined();
    expect(readFileSync(storePath, "utf8")).toBe(before);
  });

  it("finishRun with an unknown runId is a no-op, not a phantom record", () => {
    const store = new TaskStore(storePath);
    const task = seedTask(store);
    store.startRun(task);
    const before = readFileSync(storePath, "utf8");

    expect(
      store.finishRun("no-such-run", { status: RunStatus.Success })
    ).toBeUndefined();
    expect(readFileSync(storePath, "utf8")).toBe(before);
  });

  it("advanceLastRun on an unknown id writes nothing", () => {
    const store = new TaskStore(storePath);
    seedTask(store);
    const before = readFileSync(storePath, "utf8");

    store.advanceLastRun("no-such-task", "2026-08-11T03:00:00.000Z");

    expect(readFileSync(storePath, "utf8")).toBe(before);
  });

  it("updates the right row when several tasks exist", () => {
    const store = new TaskStore(storePath);
    const a = seedTask(store, { name: "a" });
    const b = seedTask(store, { name: "b" });

    store.setEnabled(b.id, false);

    const reread = new TaskStore(storePath);
    expect(reread.getTask(a.id)?.enabled).toBe(true);
    expect(reread.getTask(b.id)?.enabled).toBe(false);
  });
});

describe("TaskStore run-history ring", () => {
  it("caps history at MAX_RUN_HISTORY, keeping the NEWEST runs", () => {
    // Seeded rather than looped: each `startRun` is a full reload + whole-file
    // JSON write, so driving the cap with 500 real calls would dominate the suite's
    // runtime for one branch.
    const store = new TaskStore(storePath);
    const task = seedTask(store);
    const file = emptyStore();
    file.tasks = [task];
    // Built through the schema so the seeded rows carry every defaulted field —
    // a hand-rolled partial would not survive the store's own parse on reload.
    file.runs = Array.from({ length: MAX_RUN_HISTORY }, (_, i) =>
      runRecordSchema.parse({
        id: `seeded-${i}`,
        taskId: task.id,
        taskName: task.name,
        status: RunStatus.Success,
        startedAt: "2026-08-01T00:00:00.000Z",
      })
    );
    writeFileSync(storePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");

    const fresh = new TaskStore(storePath);
    const rec = fresh.startRun(task);

    const runs = new TaskStore(storePath).listRuns(
      undefined,
      MAX_RUN_HISTORY + 10
    );
    expect(runs).toHaveLength(MAX_RUN_HISTORY);
    expect(runs[0]?.id).toBe(rec.id); // newest first…
    // …and the oldest seeded record fell off the end.
    expect(runs.some((r) => r.id === `seeded-${MAX_RUN_HISTORY - 1}`)).toBe(
      false
    );
  });
});

describe("TaskStore upsert validation", () => {
  it("re-validates the cron on an edit and preserves a valid one", () => {
    // `setEnabled` re-upserts a spread of the existing task, so an edit that does
    // not touch the schedule must not disturb it.
    const store = new TaskStore(storePath);
    const task = seedTask(store, { cron: "*/5 * * * *" });

    const updated = store.upsertTask({
      id: task.id,
      name: task.name,
      cron: task.cron,
      enabled: false,
    });

    expect(updated.cron).toBe("*/5 * * * *");
    expect(updated.enabled).toBe(false);
  });
});

describe("TaskStore native-registrar contract violations", () => {
  it("leaves a task DAEMON-owned when a register reports ok with NO ownerId", async () => {
    // A registrar that claims success but hands back no owner id cannot be
    // confirmed. Stamping anything here would make the daemon suppress its own run
    // for a slot no native scheduler is provably holding — the task would run in
    // neither scheduler.
    const logs: string[] = [];
    const store = new TaskStore(storePath, {
      scheduledTasksRegistrar: registrarThat(() =>
        Promise.resolve({ ok: true })
      ),
      log: (m) => logs.push(m),
    });

    const task = seedTask(store, { route: TaskRoute.ClaudeScheduledTasks });
    await store.whenReconciled();

    const reread = new TaskStore(storePath).getTask(task.id);
    expect(reread?.meta[NATIVE_OWNER_META_KEY]).toBeUndefined();
    expect(logs.some((l) => l.includes("no ownerId"))).toBe(true);
  });

  it("clears the owner and keeps whenReconciled() resolving when a register REJECTS with an Error", async () => {
    const logs: string[] = [];
    const store = new TaskStore(storePath, {
      scheduledTasksRegistrar: registrarThat(() =>
        Promise.reject(new Error("permission denied"))
      ),
      log: (m) => logs.push(m),
    });

    const task = seedTask(store, { route: TaskRoute.ClaudeScheduledTasks });
    await expect(store.whenReconciled()).resolves.toBeUndefined();

    const reread = new TaskStore(storePath).getTask(task.id);
    expect(reread?.meta[NATIVE_OWNER_META_KEY]).toBeUndefined();
    expect(logs.some((l) => l.includes("permission denied"))).toBe(true);
  });

  it("also survives a register that rejects with a NON-Error value", async () => {
    // A hand-rolled registrar can `Promise.reject("nope")`. Stringifying keeps the
    // diagnostic honest instead of logging "undefined".
    const logs: string[] = [];
    const store = new TaskStore(storePath, {
      scheduledTasksRegistrar: registrarThat(() =>
        Promise.reject("plain string")
      ),
      log: (m) => logs.push(m),
    });

    seedTask(store, { route: TaskRoute.ClaudeScheduledTasks });
    await expect(store.whenReconciled()).resolves.toBeUndefined();

    expect(logs.some((l) => l.includes("plain string"))).toBe(true);
  });

  it("logs the registrar's note when it answers ok:false", async () => {
    const logs: string[] = [];
    const store = new TaskStore(storePath, {
      scheduledTasksRegistrar: registrarThat(() =>
        Promise.resolve({ ok: false, note: "unrepresentable task" })
      ),
      log: (m) => logs.push(m),
    });

    seedTask(store, { route: TaskRoute.ClaudeScheduledTasks });
    await store.whenReconciled();

    expect(logs.some((l) => l.includes("unrepresentable task"))).toBe(true);
  });

  it("a failed owner STAMP hands the task back to the daemon without wedging whenReconciled()", async () => {
    // The stamp does its own reload+write, so a filesystem failure there throws
    // INSIDE the reconcile's handlers rather than in the registrar. Two things
    // must hold: awaiting the tail still resolves (the CLI's `add` would otherwise
    // never return), and the confirmed-owner marker ends up CLEARED — an owner the
    // store could not persist must not leave the daemon suppressing its own run
    // for a slot nothing is provably holding.
    //
    // Setup note: the directory is made read-only from inside the SECOND
    // `register`, after the task is already persisted. Doing it earlier makes the
    // upsert's own write throw before any reconcile is queued, and the test would
    // assert nothing.
    const logs: string[] = [];
    let registerCalls = 0;
    const store = new TaskStore(storePath, {
      scheduledTasksRegistrar: {
        register: () => {
          registerCalls += 1;
          if (registerCalls > 1) {
            chmodSync(dir, 0o500);
          }
          return Promise.resolve({
            ok: true,
            ownerId: `owner-${registerCalls}`,
          });
        },
        deregister: () => Promise.resolve({ ok: true }),
      },
      log: (m) => logs.push(m),
    });

    const task = seedTask(store, { route: TaskRoute.ClaudeScheduledTasks });
    await store.whenReconciled();
    expect(
      new TaskStore(storePath).getTask(task.id)?.meta[NATIVE_OWNER_META_KEY]
    ).toBe("owner-1");

    // Second reconcile: the stamp write fails.
    store.upsertTask({ ...task, name: "renamed" });
    // Asserted from the test body, outside any try/catch, so a regression fails
    // the test rather than being swallowed.
    await expect(store.whenReconciled()).resolves.toBeUndefined();
    chmodSync(dir, 0o700);

    expect(logs.some((l) => l.includes("threw"))).toBe(true);
    // The unconfirmable owner is gone, so the daemon owns the task again.
    expect(
      new TaskStore(storePath).getTask(task.id)?.meta[NATIVE_OWNER_META_KEY]
    ).toBeUndefined();
  });
});

describe("TaskStore.reconcileNativeSchedulesOnStartup", () => {
  it("is a no-op when no native registrar is wired", () => {
    const store = new TaskStore(storePath);
    seedTask(store, { route: TaskRoute.ClaudeScheduledTasks });

    expect(() => store.reconcileNativeSchedulesOnStartup()).not.toThrow();
  });

  it("skips tasks that are not on the native route", async () => {
    // A local-cascade task has nothing to materialize; touching Claude's file for
    // it would register a schedule the daemon also runs.
    const seen: string[] = [];
    const store = new TaskStore(storePath, {
      scheduledTasksRegistrar: {
        register: (t) => {
          seen.push(t.id);
          return Promise.resolve({ ok: true, ownerId: t.id });
        },
        deregister: () => Promise.resolve({ ok: true }),
      },
    });
    const local = seedTask(store, {
      name: "local",
      route: TaskRoute.LocalCascade,
    });
    const native = seedTask(store, {
      name: "native",
      route: TaskRoute.ClaudeScheduledTasks,
    });
    await store.whenReconciled();
    seen.length = 0;

    store.reconcileNativeSchedulesOnStartup();
    await store.whenReconciled();

    expect(seen).toContain(native.id);
    expect(seen).not.toContain(local.id);
  });
});

describe("defaultStorePath", () => {
  let priorCrewHome: string | undefined;

  beforeEach(() => {
    priorCrewHome = process.env.CREW_HOME;
  });

  afterEach(() => {
    if (priorCrewHome === undefined) {
      Reflect.deleteProperty(process.env, "CREW_HOME");
    } else {
      process.env.CREW_HOME = priorCrewHome;
    }
  });

  it("honors CREW_HOME", () => {
    process.env.CREW_HOME = "/custom/crew";
    expect(defaultStorePath()).toBe("/custom/crew/scheduled_tasks.json");
  });

  it("falls back to ~/.config/crew when CREW_HOME is unset", () => {
    // Deleting the property matters: assigning `undefined` stores the literal
    // string "undefined" and the fallback would never be taken.
    Reflect.deleteProperty(process.env, "CREW_HOME");
    expect(defaultStorePath()).toBe(
      `${homedir()}/.config/crew/scheduled_tasks.json`
    );
  });
});
