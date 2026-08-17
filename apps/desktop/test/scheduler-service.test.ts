/**
 * @file scheduler-service.test.ts
 * @description FEA-3813 (PRD-553 M1) acceptance coverage for the desktop crewd
 * scheduler host, against a REAL libSQL database created by the production
 * migration runner (via `openTestPrisma`). Proves the M1 acceptance criterion:
 * with the scheduler running, a due task FIRES and its run row PERSISTS to
 * SQLite. Also covers the SqliteTaskStore StorePort mirror (task + run round-trip
 * to SQLite) and the flag-off boot-gating property (no daemon started ⇒ no rows).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOUD_ROUTINE_ID_META_KEY,
  createStubRoutineRegistrar,
  nextRun,
  type RoutineRegistrar,
  type RoutineRegistrationResult,
  RunStatus,
  type ScheduledTask,
  TaskRoute,
} from "@repo/crewd";
import { SchedulerService } from "../src/main/scheduler/scheduler-service.js";
import { SqliteTaskStore } from "../src/main/scheduler/sqlite-task-store.js";
import {
  openTestPrisma,
  SCHEDULER_TEST_NOW,
  schedulerStoreDeps as storeDeps,
} from "./prisma-test-utils.js";

// Top-level regex (Ultracite useTopLevelRegex): the run summary must mention the
// task fired.
const FIRED_SUMMARY_RE = /fired/;

// Fixed clock the store/service tests pin against; shared with the native-schedule
// suite so the "due now" window and cron math cannot drift between them.
const NOW = SCHEDULER_TEST_NOW;

test("SqliteTaskStore mirrors an upserted task to SQLite and re-hydrates it", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = await SqliteTaskStore.create(storeDeps(prisma));
    const task = store.upsertTask({
      id: "task-1",
      name: "nightly review",
      cron: "0 3 * * *",
      harnessCascade: ["codex", "claude"],
    });
    assert.equal(task.id, "task-1");
    assert.equal(task.enabled, true);
    await store.whenIdle();

    // Durable row is present with the JSON-encoded cascade preserved. FEA-3855
    // normalizes bare harness-name inputs to `(harness, model)` steps, so the
    // persisted shape is the step objects, not the legacy bare strings.
    const row = await prisma.client.scheduledTask.findUnique({
      where: { id: "task-1" },
    });
    assert.ok(row, "expected the task row to persist to SQLite");
    assert.equal(row?.name, "nightly review");
    assert.equal(
      row?.harnessCascade,
      JSON.stringify([{ harness: "codex" }, { harness: "claude" }])
    );

    // A fresh store hydrates from SQLite and sees the same normalized cascade.
    const rehydrated = await SqliteTaskStore.create(storeDeps(prisma));
    const seen = rehydrated.getTask("task-1");
    assert.ok(seen);
    assert.deepEqual(seen?.harnessCascade, [
      { harness: "codex" },
      { harness: "claude" },
    ]);
  } finally {
    await close();
  }
});

test("AC: with the scheduler running, a due task fires and its run persists to SQLite", async () => {
  const { prisma, close } = await openTestPrisma();
  const service = new SchedulerService({
    store: storeDeps(prisma),
    now: () => NOW,
    // Long interval — the test drives the tick explicitly via tickOnce().
    intervalMs: 60_000,
  });
  try {
    await service.start();
    assert.equal(service.isRunning(), true);
    // `start()` fires one immediate tick over the (empty) store; drain it so the
    // rest of the test is deterministic and only our explicit tick can fire.
    await service.drain();

    const store = service.getStore();
    assert.ok(store, "scheduler must expose its hydrated store");

    // A task on a "* * * * *" (every-minute) cron with a lastRunAt in the past is
    // due on the next tick. Seed it directly through the store the daemon ticks.
    store?.upsertTask({
      id: "due-task",
      name: "fires now",
      cron: "* * * * *",
      lastRunAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    await store?.whenIdle();

    // Fire one scheduler pass, then drain the in-flight run + write-behinds.
    await service.tickOnce();
    await service.drain();

    // The task FIRED: the store's authoritative in-memory run finished. With no
    // review runner wired (and a default `custom`-kind task carrying no
    // night-crew config), the FEA-4143 dispatch degrades to a recorded skip, so
    // status is `skipped` and the run is finished (not left `running`).
    const memRuns = store?.listRuns("due-task") ?? [];
    assert.equal(memRuns.length, 1, "expected exactly one run to have fired");
    const memRun = memRuns[0];
    assert.ok(memRun);
    assert.equal(memRun?.status, RunStatus.Skipped);
    assert.ok(memRun?.finishedAt, "run must be finished, not left running");
    assert.match(memRun?.summary ?? "", FIRED_SUMMARY_RE);

    // AC — the run PERSISTED to SQLite: a fresh store hydrated from the DB (via
    // the reader pool, after `drain()` committed every write-behind) sees the
    // same finished run. This is the durable proof, independent of the writer
    // connection's read-your-writes timing.
    const rehydrated = await SqliteTaskStore.create(storeDeps(prisma));
    const dbRuns = rehydrated.listRuns("due-task");
    assert.equal(dbRuns.length, 1, "the run must persist to SQLite");
    assert.equal(dbRuns[0]?.id, memRun?.id);
    assert.equal(dbRuns[0]?.status, RunStatus.Skipped);
    assert.ok(dbRuns[0]?.finishedAt, "the persisted run must be finished");

    // The persisted task row records its last-run pointer + recomputed next-run.
    const dbTask = rehydrated.getTask("due-task");
    assert.equal(dbTask?.lastRunId, memRun?.id);
    assert.equal(dbTask?.lastStatus, RunStatus.Skipped);
    assert.equal(dbTask?.nextRunAt, nextRun("* * * * *", NOW).toISOString());
  } finally {
    await service.dispose();
    await close();
  }
});

test("a disabled task never fires (no run row persists) even when it would be due", async () => {
  const { prisma, close } = await openTestPrisma();
  const service = new SchedulerService({
    store: storeDeps(prisma),
    now: () => NOW,
    intervalMs: 60_000,
  });
  try {
    await service.start();
    const store = service.getStore();
    store?.upsertTask({
      id: "off-task",
      name: "disabled",
      cron: "* * * * *",
      enabled: false,
      lastRunAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    await store?.whenIdle();

    await service.tickOnce();
    await service.drain();

    const runs = await prisma.client.scheduledTaskRun.findMany({
      where: { taskId: "off-task" },
    });
    assert.equal(runs.length, 0, "disabled tasks must not fire");
  } finally {
    await service.dispose();
    await close();
  }
});

test("flag-off gating: a scheduler that is never started writes no run rows", async () => {
  // Mirrors the boot() gate: when the `scheduledTasks` flag is off, main never
  // calls start(), so no daemon runs and nothing is written — proven here by
  // constructing the service, seeding a would-be-due task via a standalone store,
  // and asserting the daemon path never persisted a run because it never ticked.
  const { prisma, close } = await openTestPrisma();
  const service = new SchedulerService({
    store: storeDeps(prisma),
    now: () => NOW,
    intervalMs: 60_000,
  });
  try {
    // Never started. tickOnce() is a no-op before start().
    assert.equal(service.isRunning(), false);
    await service.tickOnce();
    await service.drain();
    assert.equal(service.getStore(), null);

    const runs = await prisma.client.scheduledTaskRun.findMany();
    assert.equal(runs.length, 0, "an unstarted scheduler must write nothing");
  } finally {
    await service.dispose();
    await close();
  }
});

test("FEA-3853 M3: create / update / toggle / delete round-trip through the running service", async () => {
  const { prisma, close } = await openTestPrisma();
  const service = new SchedulerService({
    store: storeDeps(prisma),
    now: () => NOW,
    intervalMs: 60_000,
  });
  try {
    await service.start();
    await service.drain();

    // Create.
    const created = service.upsertTask({
      name: "Nightly review",
      cron: "0 9 * * *",
      harnessCascade: [{ harness: "codex" }, { harness: "claude" }],
    });
    assert.equal(created.name, "Nightly review");
    assert.equal(created.enabled, true);
    // An enabled task gets a computed nextRunAt.
    assert.ok(created.nextRunAt, "an enabled task must have a next run");

    // Update in place (by id) changes the schedule.
    const updated = service.upsertTask({
      id: created.id,
      name: "Nightly review",
      cron: "0 18 * * *",
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.cron, "0 18 * * *");

    // Toggle disables the task and clears its next run.
    const toggled = service.setEnabled(created.id, false);
    assert.equal(toggled?.enabled, false);
    assert.equal(toggled?.nextRunAt, null, "a disabled task has no next run");

    // Delete removes it, and a fresh hydrate confirms the durable row is gone.
    assert.equal(service.removeTask(created.id), true);
    await service.drain();
    const rehydrated = await SqliteTaskStore.create(storeDeps(prisma));
    assert.equal(rehydrated.getTask(created.id), undefined);
  } finally {
    await service.dispose();
    await close();
  }
});

test("FEA-3853 M3: runNow fires a task off-schedule and records the run", async () => {
  const { prisma, close } = await openTestPrisma();
  const service = new SchedulerService({
    store: storeDeps(prisma),
    now: () => NOW,
    intervalMs: 60_000,
  });
  try {
    await service.start();
    await service.drain();

    // A task whose cron would NOT be due now (yearly). runNow must fire it anyway.
    const task = service.upsertTask({
      name: "manual only",
      cron: "0 9 1 1 *",
    });
    await service.drain();

    assert.equal(service.runNow(task.id), true);
    await service.drain();

    const runs = service.listRuns(task.id);
    assert.equal(runs.length, 1, "run-now must record exactly one run");
    assert.ok(runs[0]?.finishedAt, "the run-now run must be finished");

    // An unknown id is a no-op, not a throw.
    assert.equal(service.runNow("nope"), false);
  } finally {
    await service.dispose();
    await close();
  }
});

test("FEA-3853 M3: previewSchedule validates a cron and returns its next fire times", () => {
  const preview = SchedulerService.previewSchedule("0 9 * * 1-5", "", 3);
  assert.equal(preview.valid, true);
  assert.equal(preview.error, null);
  assert.equal(preview.nextRuns.length, 3);
  // Each preview entry is a strictly-increasing ISO timestamp.
  const times = preview.nextRuns.map((iso) => new Date(iso).getTime());
  assert.ok(times[0] < times[1] && times[1] < times[2]);

  // An invalid cron returns valid:false with no fire times, never a throw.
  const invalid = SchedulerService.previewSchedule("not a cron", "", 3);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.error);
  assert.equal(invalid.nextRuns.length, 0);

  // The count is clamped to the 1..10 ceiling.
  const clamped = SchedulerService.previewSchedule("0 * * * *", "", 999);
  assert.equal(clamped.nextRuns.length, 10);
});

test("FEA-3853 M3: mutations before start() throw rather than silently no-op", async () => {
  const { prisma, close } = await openTestPrisma();
  const service = new SchedulerService({
    store: storeDeps(prisma),
    now: () => NOW,
    intervalMs: 60_000,
  });
  try {
    // Not started: a write must throw (the disabled-store IPC responder maps that
    // to a rejected promise the UI surfaces, never a silent success).
    assert.throws(() => service.upsertTask({ name: "x", cron: "0 9 * * *" }));
    assert.throws(() => service.removeTask("x"));
    assert.throws(() => service.runNow("x"));
  } finally {
    await service.dispose();
    await close();
  }
});

/**
 * FEA-3816 (PRD-553 M4): a recording mock of the cloud-routine registration
 * seam. Best-effort by contract (resolves, never rejects); records each
 * register/deregister call so a test can assert the seam fired on a broker-route
 * flip. `register` hands back a synthetic routine id so the persisted-route
 * assertions can also cover the id round-trip if needed.
 */
function recordingRegistrar(): {
  registrar: RoutineRegistrar;
  registered: ScheduledTask[];
  deregistered: ScheduledTask[];
} {
  const registered: ScheduledTask[] = [];
  const deregistered: ScheduledTask[] = [];
  const registrar: RoutineRegistrar = {
    register(task) {
      registered.push(task);
      return Promise.resolve<RoutineRegistrationResult>({
        ok: true,
        routineId: `routine-${task.id}`,
        note: "test registrar",
      });
    },
    deregister(task) {
      deregistered.push(task);
      return Promise.resolve<RoutineRegistrationResult>({
        ok: true,
        routineId: null,
        note: "test registrar",
      });
    },
  };
  return { registrar, registered, deregistered };
}

test("FEA-3816 M4: flipping a task to a Claude routine persists the route and fires the registrar", async () => {
  const { prisma, close } = await openTestPrisma();
  const { registrar, registered, deregistered } = recordingRegistrar();
  const service = new SchedulerService({
    store: { ...storeDeps(prisma), routineRegistrar: registrar },
    now: () => NOW,
    intervalMs: 60_000,
  });
  try {
    await service.start();
    await service.drain();

    // Create a plain local-cascade task (the default). The registrar must NOT
    // fire on a create straight into local-cascade — no routine ever existed.
    const created = service.upsertTask({
      name: "nightly review",
      cron: "0 9 * * *",
    });
    assert.equal(created.route, TaskRoute.LocalCascade);
    await service.drain();
    assert.equal(
      registered.length,
      0,
      "a create into local-cascade must not register a routine"
    );
    assert.equal(
      deregistered.length,
      0,
      "a create into local-cascade must not deregister a routine"
    );

    // Flip the task to a Claude cloud routine. The route persists AND the
    // registration seam fires exactly once with this task.
    const flipped = service.upsertTask({
      id: created.id,
      name: created.name,
      cron: created.cron,
      route: TaskRoute.ClaudeRoutine,
    });
    assert.equal(flipped.route, TaskRoute.ClaudeRoutine);
    await service.drain();
    assert.equal(registered.length, 1, "the flip must register the routine");
    assert.equal(registered[0]?.id, created.id);
    assert.equal(deregistered.length, 0);

    // The claude-routine route is durable: a fresh store hydrated from SQLite
    // reads it back (proving the `route` column persisted).
    const rehydrated = await SqliteTaskStore.create(storeDeps(prisma));
    assert.equal(
      rehydrated.getTask(created.id)?.route,
      TaskRoute.ClaudeRoutine
    );

    // A same-route edit (a rename) does NOT re-fire the registrar.
    service.upsertTask({
      id: created.id,
      name: "renamed",
      cron: created.cron,
      route: TaskRoute.ClaudeRoutine,
    });
    await service.drain();
    assert.equal(
      registered.length,
      1,
      "a same-route edit must not re-register the routine"
    );

    // Flipping back to local-cascade deregisters the routine.
    service.upsertTask({
      id: created.id,
      name: "renamed",
      cron: created.cron,
      route: TaskRoute.LocalCascade,
    });
    await service.drain();
    assert.equal(
      deregistered.length,
      1,
      "flipping back to local-cascade must deregister the routine"
    );
    assert.equal(deregistered[0]?.id, created.id);
  } finally {
    await service.dispose();
    await close();
  }
});

test("FEA-3816 M4: deleting a Claude-routine task deregisters its cloud routine; deleting a local task does not", async () => {
  const { prisma, close } = await openTestPrisma();
  const { registrar, deregistered } = recordingRegistrar();
  const service = new SchedulerService({
    store: { ...storeDeps(prisma), routineRegistrar: registrar },
    now: () => NOW,
    intervalMs: 60_000,
  });
  try {
    await service.start();
    await service.drain();

    // A task handed to a Claude routine.
    const cloud = service.upsertTask({
      name: "cloud task",
      cron: "0 9 * * *",
      route: TaskRoute.ClaudeRoutine,
    });
    await service.drain();
    const deregBeforeDelete = deregistered.length;

    // Deleting it must deregister the cloud routine (else it orphans in cloud).
    assert.equal(service.removeTask(cloud.id), true);
    await service.drain();
    assert.equal(
      deregistered.length,
      deregBeforeDelete + 1,
      "deleting a claude-routine task must deregister its routine"
    );
    assert.equal(deregistered.at(-1)?.id, cloud.id);

    // Deleting a plain local-cascade task must NOT touch the registrar.
    const local = service.upsertTask({ name: "local task", cron: "0 9 * * *" });
    await service.drain();
    const deregBeforeLocalDelete = deregistered.length;
    assert.equal(service.removeTask(local.id), true);
    await service.drain();
    assert.equal(
      deregistered.length,
      deregBeforeLocalDelete,
      "deleting a local-cascade task must not deregister anything"
    );

    // Deleting an unknown id is a no-op (no registrar call, returns false).
    assert.equal(service.removeTask("nope"), false);
  } finally {
    await service.dispose();
    await close();
  }
});

test("FEA-3816 M4: a local-cascade task still fires through the daemon cascade (route does not gate the local run)", async () => {
  const { prisma, close } = await openTestPrisma();
  const { registrar, registered } = recordingRegistrar();
  const service = new SchedulerService({
    store: { ...storeDeps(prisma), routineRegistrar: registrar },
    now: () => NOW,
    intervalMs: 60_000,
  });
  try {
    await service.start();
    await service.drain();

    // A due local-cascade task fires locally exactly as before M4.
    const store = service.getStore();
    store?.upsertTask({
      id: "local-task",
      name: "runs locally",
      cron: "* * * * *",
      route: TaskRoute.LocalCascade,
      lastRunAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    await store?.whenIdle();

    await service.tickOnce();
    await service.drain();

    const runs = store?.listRuns("local-task") ?? [];
    assert.equal(runs.length, 1, "a local-cascade task must fire locally");
    assert.ok(runs[0]?.finishedAt, "the local run must be finished");
    // The registrar is never touched for a local-cascade task.
    assert.equal(
      registered.length,
      0,
      "a local-cascade task must not register a cloud routine"
    );
  } finally {
    await service.dispose();
    await close();
  }
});

test("FEA-3912: a claude-routine task is NOT fired by the daemon tick, while a local-cascade task on the same slot still is", async () => {
  const { prisma, close } = await openTestPrisma();
  const { registrar, registered } = recordingRegistrar();
  const service = new SchedulerService({
    store: { ...storeDeps(prisma), routineRegistrar: registrar },
    now: () => NOW,
    intervalMs: 60_000,
  });
  try {
    await service.start();
    await service.drain();

    const store = service.getStore();
    // A claude-routine task, due on this slot. The cloud routine owns it, so the
    // local daemon must NOT fire it (double-execution). Creating it straight
    // into claude-routine registers the cloud routine via the store flip path.
    store?.upsertTask({
      id: "cloud-task",
      name: "runs in cloud",
      cron: "* * * * *",
      route: TaskRoute.ClaudeRoutine,
      lastRunAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    // A local-cascade task on the exact same due slot, to prove the guard is
    // route-scoped and does not suppress local tasks.
    store?.upsertTask({
      id: "local-task",
      name: "runs locally",
      cron: "* * * * *",
      route: TaskRoute.LocalCascade,
      lastRunAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    await store?.whenIdle();
    // The create-into-claude-routine registered the cloud routine (store flip),
    // independent of the daemon tick.
    assert.equal(
      registered.length,
      1,
      "creating a claude-routine task must register its cloud routine"
    );
    assert.equal(registered[0]?.id, "cloud-task");
    // FEA-3912: the recording registrar confirmed ownership (ok:true + routineId),
    // so the store stamped the confirmed-ownership marker the daemon keys off.
    assert.equal(
      store?.getTask("cloud-task")?.meta[CLOUD_ROUTINE_ID_META_KEY],
      "routine-cloud-task",
      "a confirmed registration must stamp the cloud-ownership marker"
    );

    await service.tickOnce();
    await service.drain();

    // The cloud-routed task never fired locally: no run row, no lastStatus.
    assert.equal(
      (store?.listRuns("cloud-task") ?? []).length,
      0,
      "a confirmed claude-routine task must not fire through the local daemon"
    );
    assert.equal(store?.getTask("cloud-task")?.lastStatus, null);
    // The local-cascade task on the same slot still fired exactly once.
    const localRuns = store?.listRuns("local-task") ?? [];
    assert.equal(localRuns.length, 1, "the local-cascade task must still fire");
    assert.ok(localRuns[0]?.finishedAt, "the local run must be finished");
    // The tick did not add any further registrar activity (the guard is a pure
    // skip; the registrar stays the store's flip-path concern).
    assert.equal(
      registered.length,
      1,
      "the tick guard must not re-register the cloud routine"
    );
  } finally {
    await service.dispose();
    await close();
  }
});

test("FEA-3912: a claude-routine task whose registration is UNWIRED (stub ok:false) still fires locally — never runs nowhere", async () => {
  // The exact regression wongk flagged: production injects the stub registrar,
  // whose register reports ok:false (cloud API not wired). The store must NOT
  // stamp the confirmed-ownership marker, and the daemon must therefore KEEP
  // running the task locally — otherwise an opt-in task gets neither a local run
  // nor a cloud routine (it runs nowhere).
  const { prisma, close } = await openTestPrisma();
  const service = new SchedulerService({
    // The honest production default: the stub registrar (ok:false, no routine id).
    store: {
      ...storeDeps(prisma),
      routineRegistrar: createStubRoutineRegistrar(),
    },
    now: () => NOW,
    intervalMs: 60_000,
  });
  try {
    await service.start();
    await service.drain();

    const store = service.getStore();
    store?.upsertTask({
      id: "opt-in-task",
      name: "opted in but unwired",
      cron: "* * * * *",
      route: TaskRoute.ClaudeRoutine,
      lastRunAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    await store?.whenIdle();

    // The route persisted (operator intent), but ownership was NOT confirmed —
    // no marker, because the stub reported ok:false.
    assert.equal(store?.getTask("opt-in-task")?.route, TaskRoute.ClaudeRoutine);
    assert.equal(
      store?.getTask("opt-in-task")?.meta[CLOUD_ROUTINE_ID_META_KEY],
      undefined,
      "an unwired registration must NOT stamp the cloud-ownership marker"
    );

    await service.tickOnce();
    await service.drain();

    // Because ownership is unconfirmed, the local daemon still fired it — the
    // task runs SOMEWHERE instead of vanishing.
    const runs = store?.listRuns("opt-in-task") ?? [];
    assert.equal(
      runs.length,
      1,
      "an unconfirmed claude-routine task must still fire locally"
    );
    assert.ok(runs[0]?.finishedAt, "the local run must be finished");

    // runNow is also allowed while ownership is unconfirmed.
    assert.equal(
      service.runNow("opt-in-task"),
      true,
      "runNow must fire an unconfirmed claude-routine task locally"
    );
    await service.drain();
    assert.equal((store?.listRuns("opt-in-task") ?? []).length, 2);
  } finally {
    await service.dispose();
    await close();
  }
});

test("FEA-3958 Slice A: a persisted UNKNOWN route hydrates as local-cascade (skew safety)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Seed the durable row directly with a route literal THIS build does not know
    // (as a newer desktop build might persist), bypassing the store so no schema
    // validation runs on the write.
    const nowIso = NOW.toISOString();
    await prisma.write((client) =>
      client.scheduledTask.create({
        data: {
          id: "future-task",
          name: "from the future",
          cron: "0 9 * * *",
          prompt: "",
          recurring: true,
          durable: true,
          crew: "",
          kind: "custom",
          route: "some-future-native-route",
          pass: null,
          harnessCascade: "[]",
          timezone: "",
          enabled: true,
          catchUp: true,
          meta: "{}",
          nextRunAt: null,
          lastRunAt: null,
          lastRunId: null,
          lastStatus: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      })
    );

    // Hydration must NOT throw on the unknown route; it normalizes to the daemon
    // route so an older build runs the task locally instead of crashing.
    const store = await SqliteTaskStore.create(storeDeps(prisma));
    assert.equal(store.getTask("future-task")?.route, TaskRoute.LocalCascade);
  } finally {
    await close();
  }
});

test("ISS-4814: a one-time task's fire cursor persists to SQLite, so a restarted scheduler never re-fires it", async () => {
  const { prisma, close } = await openTestPrisma();
  // A later wall clock for the "restarted daemon" pass: five minutes on, so the
  // every-minute cron has a NEW matching slot that `lastRunAt` alone would not
  // suppress. This is exactly the window the old retire-on-completion path left
  // open when a kill landed between the launch and the terminal bookkeeping.
  const later = new Date(NOW.getTime() + 5 * 60_000);
  const firstPass = new SchedulerService({
    store: storeDeps(prisma),
    now: () => NOW,
    intervalMs: 60_000,
  });
  let firedAt: string | null | undefined;
  try {
    await firstPass.start();
    await firstPass.drain();
    const store = firstPass.getStore();
    assert.ok(store, "scheduler must expose its hydrated store");

    // A one-time task due now, plus a RECURRING control on the same cron. The
    // control is what makes the assertion below meaningful: it proves the
    // restarted daemon really did tick a due slot, so the one-time task's
    // silence is the fire-once guard and not an inert tick.
    store?.upsertTask({
      id: "one-shot",
      name: "fires exactly once",
      cron: "* * * * *",
      recurring: false,
      lastRunAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    store?.upsertTask({
      id: "every-slot",
      name: "recurring control",
      cron: "* * * * *",
      recurring: true,
      lastRunAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    await store?.whenIdle();

    await firstPass.tickOnce();
    await firstPass.drain();
    assert.equal(store?.listRuns("one-shot").length, 1, "one-time task fires");

    // The durable cursor landed in SQLite, stamped with the run's START instant
    // — the fix's whole point, since a crash after this write must still find the
    // fire spent. Read through a FRESH store so this is the committed row, not
    // the writer's in-memory copy.
    const afterFire = await SqliteTaskStore.create(storeDeps(prisma));
    const fired = afterFire.getTask("one-shot");
    firedAt = fired?.firedAt;
    assert.ok(
      firedAt,
      "the one-time task's fire cursor must persist to SQLite"
    );
    assert.equal(firedAt, afterFire.listRuns("one-shot")[0]?.startedAt);
    // `enabled` stays TRUE: the cursor is the fire-once authority, and `enabled`
    // remains a pure operator pause. A regression back to retire-by-disable
    // would fail here even though the re-fire assertion below still passed.
    assert.equal(fired?.enabled, true, "retirement must not touch `enabled`");
    // The recurring control was NOT stamped — the cursor is one-time-only.
    assert.equal(afterFire.getTask("every-slot")?.firedAt, null);
  } finally {
    await firstPass.dispose();
  }

  // Restart against the SAME database at a later slot, as a relaunched desktop
  // app would. `start()` runs one immediate tick over the already-hydrated
  // tasks — that tick IS the re-fire attempt, so the pass deliberately does not
  // add an explicit `tickOnce()`: the control's fire count below is only exact
  // for a single tick.
  const secondPass = new SchedulerService({
    store: storeDeps(prisma),
    now: () => later,
    intervalMs: 60_000,
  });
  try {
    await secondPass.start();
    await secondPass.drain();

    const rehydrated = await SqliteTaskStore.create(storeDeps(prisma));
    assert.equal(
      rehydrated.listRuns("one-shot").length,
      1,
      "the one-time task must NOT re-fire after a restart at a later slot"
    );
    // Its cursor is untouched by the restart (first fire wins, no re-stamp).
    assert.equal(rehydrated.getTask("one-shot")?.firedAt, firedAt);
    // Control: the recurring task DID fire again on that same tick.
    assert.equal(
      rehydrated.listRuns("every-slot").length,
      2,
      "the recurring control must fire again, proving the tick was live"
    );
  } finally {
    await secondPass.dispose();
    await close();
  }
});
