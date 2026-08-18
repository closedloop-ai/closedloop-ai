/**
 * @file scheduler-native-schedule.test.ts
 * @description FEA-3958 (PLN-1492) Slice A + FEA-4054 — coverage for the NATIVE
 * local-scheduler (`claude-scheduled-tasks`) registration path through
 * `SqliteTaskStore`: a broker-route flip into/out of the native route
 * materializes/removes the entry in Claude Code's `scheduled_tasks.json`, an
 * enable/disable/delete reconciles it, and the confirmed native-owner marker
 * round-trips through SQLite. Also covers the FEA-4054 STARTUP reconciliation
 * pass that re-materializes enabled native tasks on boot (and clears ownership
 * when the rewrite fails). Runs against a REAL libSQL database created by the
 * production migration runner (via `openTestPrisma`). Split out of
 * `scheduler-service.test.ts` to keep both files under the line ceiling.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NATIVE_OWNER_META_KEY,
  type ScheduledTask,
  type ScheduledTasksRegistrar,
  type ScheduledTasksRegistrationResult,
  TaskRoute,
} from "@repo/crewd";
import { SqliteTaskStore } from "../src/main/scheduler/sqlite-task-store.js";
import { openTestPrisma, schedulerStoreDeps } from "./prisma-test-utils.js";

/**
 * FEA-3958 (PLN-1492) Slice A: a recording mock of the NATIVE local-scheduler
 * registration seam. Best-effort by contract (resolves, never rejects); records
 * each register/deregister so a test can assert the seam fired on a flip into or
 * out of the `claude-scheduled-tasks` route. `register` hands back a synthetic
 * owner id so the confirmed-owner marker round-trip is covered.
 */
function recordingScheduledTasksRegistrar(): {
  registrar: ScheduledTasksRegistrar;
  registered: ScheduledTask[];
  deregistered: ScheduledTask[];
} {
  const registered: ScheduledTask[] = [];
  const deregistered: ScheduledTask[] = [];
  const registrar: ScheduledTasksRegistrar = {
    register(task) {
      registered.push(task);
      return Promise.resolve<ScheduledTasksRegistrationResult>({
        ok: true,
        ownerId: `native-${task.id}`,
        note: "test writer",
      });
    },
    deregister(task) {
      deregistered.push(task);
      return Promise.resolve<ScheduledTasksRegistrationResult>({ ok: true });
    },
  };
  return { registrar, registered, deregistered };
}

test("FEA-3958 Slice A: flipping a task to claude-scheduled-tasks fires the native writer and stamps the owner marker", async () => {
  const { prisma, close } = await openTestPrisma();
  const { registrar, registered, deregistered } =
    recordingScheduledTasksRegistrar();
  const store = await SqliteTaskStore.create({
    ...schedulerStoreDeps(prisma),
    scheduledTasksRegistrar: registrar,
  });
  try {
    // A create straight into local-cascade must NOT touch the native writer.
    const created = store.upsertTask({
      id: "native-task",
      name: "nightly sweep",
      cron: "0 9 * * *",
    });
    assert.equal(created.route, TaskRoute.LocalCascade);
    await store.whenIdle();
    assert.equal(registered.length, 0);
    assert.equal(deregistered.length, 0);

    // Flip to claude-scheduled-tasks: the writer registers exactly once and the
    // confirmed native-owner marker is stamped from the returned owner id.
    const flipped = store.upsertTask({
      id: "native-task",
      name: "nightly sweep",
      cron: "0 9 * * *",
      route: TaskRoute.ClaudeScheduledTasks,
    });
    assert.equal(flipped.route, TaskRoute.ClaudeScheduledTasks);
    await store.whenIdle();
    assert.equal(
      registered.length,
      1,
      "the flip must register the native task"
    );
    assert.equal(registered[0]?.id, "native-task");
    assert.equal(
      store.getTask("native-task")?.meta[NATIVE_OWNER_META_KEY],
      "native-native-task",
      "a confirmed native register must stamp the owner marker"
    );

    // The route + marker are durable across a fresh hydrate from SQLite.
    const rehydrated = await SqliteTaskStore.create(schedulerStoreDeps(prisma));
    const seen = rehydrated.getTask("native-task");
    assert.equal(seen?.route, TaskRoute.ClaudeScheduledTasks);
    assert.equal(seen?.meta[NATIVE_OWNER_META_KEY], "native-native-task");

    // A same-route edit of an ENABLED native task RE-registers (the native file
    // is a full materialization with no `enabled`/cron delta tracking, so a
    // cron/prompt edit must refresh the native entry, or Claude keeps firing the
    // stale schedule). Register is an id-keyed upsert, so this is idempotent.
    store.upsertTask({
      id: "native-task",
      name: "renamed",
      cron: "30 9 * * *",
      route: TaskRoute.ClaudeScheduledTasks,
    });
    await store.whenIdle();
    assert.equal(
      registered.length,
      2,
      "a same-route edit of an enabled native task must re-register to refresh the native entry"
    );
    assert.equal(registered[1]?.cron, "30 9 * * *");

    // Flipping back to local-cascade deregisters and clears the owner marker.
    store.upsertTask({
      id: "native-task",
      name: "renamed",
      cron: "0 9 * * *",
      route: TaskRoute.LocalCascade,
    });
    await store.whenIdle();
    assert.equal(deregistered.length, 1, "the reverse flip must deregister");
    assert.equal(deregistered[0]?.id, "native-task");
    assert.equal(
      store.getTask("native-task")?.meta[NATIVE_OWNER_META_KEY],
      undefined,
      "the reverse flip must clear the owner marker"
    );
  } finally {
    await close();
  }
});

test("FEA-3958 Slice A: deleting a claude-scheduled-tasks task deregisters it; deleting a local task does not", async () => {
  const { prisma, close } = await openTestPrisma();
  const { registrar, deregistered } = recordingScheduledTasksRegistrar();
  const store = await SqliteTaskStore.create({
    ...schedulerStoreDeps(prisma),
    scheduledTasksRegistrar: registrar,
  });
  try {
    store.upsertTask({
      id: "native-task",
      name: "native",
      cron: "0 9 * * *",
      route: TaskRoute.ClaudeScheduledTasks,
    });
    store.upsertTask({
      id: "local-task",
      name: "local",
      cron: "0 9 * * *",
    });
    await store.whenIdle();

    store.removeTask("local-task");
    await store.whenIdle();
    assert.equal(
      deregistered.length,
      0,
      "deleting a local-cascade task must not deregister a native entry"
    );

    store.removeTask("native-task");
    await store.whenIdle();
    assert.equal(
      deregistered.length,
      1,
      "deleting a native task must deregister its scheduled_tasks.json entry"
    );
    assert.equal(deregistered[0]?.id, "native-task");
  } finally {
    await close();
  }
});

test("FEA-3958 Slice A: disabling a native task deregisters it; re-enabling re-registers it", async () => {
  const { prisma, close } = await openTestPrisma();
  const { registrar, registered, deregistered } =
    recordingScheduledTasksRegistrar();
  const store = await SqliteTaskStore.create({
    ...schedulerStoreDeps(prisma),
    scheduledTasksRegistrar: registrar,
  });
  try {
    store.upsertTask({
      id: "native-task",
      name: "native",
      cron: "0 9 * * *",
      route: TaskRoute.ClaudeScheduledTasks,
    });
    await store.whenIdle();
    assert.equal(registered.length, 1);
    assert.equal(deregistered.length, 0);

    // Disabling a native task must REMOVE its native entry — Claude Code's
    // scheduled_tasks.json has no `enabled` flag, so a disabled Desktop task would
    // otherwise keep firing natively. The owner marker is cleared so the daemon
    // does not suppress a (now disabled) local run either.
    store.setEnabled("native-task", false);
    await store.whenIdle();
    assert.equal(
      deregistered.length,
      1,
      "disabling a native task must deregister its native entry"
    );
    assert.equal(
      store.getTask("native-task")?.meta[NATIVE_OWNER_META_KEY],
      undefined,
      "disabling must clear the confirmed-owner marker"
    );

    // Re-enabling re-materializes it and re-stamps the confirmed owner.
    store.setEnabled("native-task", true);
    await store.whenIdle();
    assert.equal(
      registered.length,
      2,
      "re-enabling a native task must re-register its native entry"
    );
    assert.equal(
      store.getTask("native-task")?.meta[NATIVE_OWNER_META_KEY],
      "native-native-task"
    );
  } finally {
    await close();
  }
});

test("FEA-4054: startup reconciliation re-registers enabled native tasks and re-stamps ownership after a fresh hydrate", async () => {
  const { prisma, close } = await openTestPrisma();
  const { registrar, registered, deregistered } =
    recordingScheduledTasksRegistrar();
  // Persist an enabled native task and a disabled native task via a store that
  // has NO native registrar wired, then drop the confirmed-owner marker — this
  // models an install upgraded to FEA-4054 whose scheduled_tasks.json was written
  // by the old bare-array writer and never re-materialized (no owner stamped).
  const seedStore = await SqliteTaskStore.create(schedulerStoreDeps(prisma));
  try {
    seedStore.upsertTask({
      id: "enabled-native",
      name: "enabled native",
      cron: "0 9 * * *",
      route: TaskRoute.ClaudeScheduledTasks,
    });
    seedStore.upsertTask({
      id: "disabled-native",
      name: "disabled native",
      cron: "0 9 * * *",
      route: TaskRoute.ClaudeScheduledTasks,
    });
    seedStore.setEnabled("disabled-native", false);
    seedStore.upsertTask({
      id: "local-task",
      name: "local",
      cron: "0 9 * * *",
    });
    await seedStore.whenIdle();
    // No registrar was wired on the seed store ⇒ no owner marker was ever stamped.
    assert.equal(
      seedStore.getTask("enabled-native")?.meta[NATIVE_OWNER_META_KEY],
      undefined
    );

    // A fresh boot: hydrate a NEW store WITH the native registrar and run the
    // startup reconciliation pass.
    const store = await SqliteTaskStore.create({
      ...schedulerStoreDeps(prisma),
      scheduledTasksRegistrar: registrar,
    });
    store.reconcileNativeSchedulesOnStartup();
    await store.whenIdle();

    // The enabled native task is (re)materialized and its owner marker stamped, so
    // Claude Code actually loads it and the daemon knows to suppress the local run.
    // Only the enabled native task registers — not the disabled one, not the local.
    assert.deepEqual(
      registered.map((t) => t.id),
      ["enabled-native"],
      "startup pass must register only the enabled native task"
    );
    assert.equal(
      store.getTask("enabled-native")?.meta[NATIVE_OWNER_META_KEY],
      "native-enabled-native",
      "startup reconciliation must re-confirm native ownership"
    );
    // The disabled native task is deregistered (removed from the native file); the
    // plain local task is never touched.
    assert.deepEqual(
      deregistered.map((t) => t.id),
      ["disabled-native"]
    );
  } finally {
    await close();
  }
});

test("FEA-4054: startup reconciliation clears native ownership when the rewrite FAILS", async () => {
  const { prisma, close } = await openTestPrisma();
  const registered: ScheduledTask[] = [];
  // A registrar whose register FAILS (e.g. an unreadable/corrupt native file):
  // ok:false and no owner id, exactly what the writer returns on a rewrite error.
  const failingRegistrar: ScheduledTasksRegistrar = {
    register(task) {
      registered.push(task);
      return Promise.resolve<ScheduledTasksRegistrationResult>({
        ok: false,
        note: "native file unreadable",
      });
    },
    deregister() {
      return Promise.resolve<ScheduledTasksRegistrationResult>({ ok: true });
    },
  };
  // Seed a native task that ALREADY carries a confirmed owner marker (a prior
  // successful register), so we can prove startup CLEARS it on a rewrite failure.
  const seedStore = await SqliteTaskStore.create({
    ...schedulerStoreDeps(prisma),
    scheduledTasksRegistrar: {
      register: (task) =>
        Promise.resolve<ScheduledTasksRegistrationResult>({
          ok: true,
          ownerId: `native-${task.id}`,
        }),
      deregister: () =>
        Promise.resolve<ScheduledTasksRegistrationResult>({ ok: true }),
    },
  });
  try {
    seedStore.upsertTask({
      id: "native-task",
      name: "native",
      cron: "0 9 * * *",
      route: TaskRoute.ClaudeScheduledTasks,
    });
    await seedStore.whenIdle();
    assert.equal(
      seedStore.getTask("native-task")?.meta[NATIVE_OWNER_META_KEY],
      "native-native-task"
    );

    // Fresh boot with the FAILING registrar: the marker must be cleared so the
    // daemon takes the task back rather than leaving it running in NEITHER
    // scheduler (Claude never loaded it, and the daemon was suppressing it).
    const store = await SqliteTaskStore.create({
      ...schedulerStoreDeps(prisma),
      scheduledTasksRegistrar: failingRegistrar,
    });
    store.reconcileNativeSchedulesOnStartup();
    await store.whenIdle();

    assert.deepEqual(
      registered.map((t) => t.id),
      ["native-task"]
    );
    assert.equal(
      store.getTask("native-task")?.meta[NATIVE_OWNER_META_KEY],
      undefined,
      "a failed startup rewrite must clear native ownership"
    );
  } finally {
    await close();
  }
});
