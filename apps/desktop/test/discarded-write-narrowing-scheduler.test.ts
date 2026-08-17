/**
 * @file discarded-write-narrowing-scheduler.test.ts
 * @description ISS-6321 (batch 5/6) — the NINE discarded wide writes in
 * `scheduler/sqlite-task-store.ts`, run against a real libSQL store.
 *
 * The ticket scoped four. The other five are chained
 * `client.scheduledTask.update({...}).then(() => undefined)` — the `.then` only
 * adapts `Promise<Row>` to the `Promise<void>` that `enqueue` takes, so the row
 * is discarded exactly like a statement-position write. That shape is a THIRD
 * blind spot in `no-discarded-wide-prisma-write` (after batch 3's
 * `withDb((db) => …)` and batch 4's `Promise.all([...])` element), which is why
 * the ticket under-counted this directory.
 *
 * Every site here is narrowed with `select: { id: true }` — `ScheduledTask` and
 * `ScheduledTaskRun` are two of the only three models in the desktop schema
 * that HAVE an `id` column (22 and 12 columns respectively, so one cell
 * replaces up to 22).
 *
 * NONE is converted to `updateMany`, and the P2025 tests below are why: the
 * write-behind chain is `enqueue`, which catches and LOGS a rejection rather
 * than propagating it. That makes the throw's observable effects (a) the
 * operator-facing log line, and (b) abandoning the REST of the callback — in
 * `startRun` the task stamp, in `finishRun` the whole task-stamp loop.
 * `updateMany` would erase both: the divergence between the in-memory file and
 * the durable row would become silent, and statements the throw currently
 * skips would start running against a store that is already inconsistent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NATIVE_OWNER_META_KEY, RunStatus, TaskRoute } from "@repo/crewd";
import { SqliteTaskStore } from "../src/main/scheduler/sqlite-task-store.js";
import {
  assertNarrowedTo,
  recordDesktopWrites,
} from "./discarded-write-narrowing-utils.js";
import { openTestPrisma, schedulerStoreDeps } from "./prisma-test-utils.js";

const TASK_ID = "iss6321-task";
const CRON = "0 9 * * *";
/** `ScheduledTask` / `ScheduledTaskRun` both carry a real `id` primary key. */
const BY_ID = { id: true } as const;

type TaskRow = { id: string; last_run_at: string | null; meta: string | null };
type RunRow = { id: string; status: string; finished_at: string | null };

/** `SqliteClient.query` resolves `{ rows }`, and its placeholders are `$n`. */
async function rowsOf<T extends Record<string, unknown>>(
  db: Awaited<ReturnType<typeof openTestPrisma>>["db"],
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await db.query<T>(sql, params);
  return result.rows;
}

async function openStore() {
  const opened = await openTestPrisma();
  const recorded = recordDesktopWrites(opened.prisma);
  const logs: string[] = [];
  const store = await SqliteTaskStore.create({
    ...schedulerStoreDeps(recorded.prisma),
    log: (message) => logs.push(message),
  });
  return { ...opened, recorded, store, logs };
}

const seedTask = (store: SqliteTaskStore) =>
  store.upsertTask({ id: TASK_ID, name: "nightly sweep", cron: CRON });

// ───────────────────────── upsertTask (444) ─────────────────────────

test("PARITY: upsertTask persists the task row to SQLite", async () => {
  const { db, store, close } = await openStore();
  try {
    seedTask(store);
    await store.whenIdle();

    const rows = await rowsOf<TaskRow>(
      db,
      "SELECT id, last_run_at, meta FROM scheduled_tasks"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, TASK_ID);
  } finally {
    await close();
  }
});

test("NARROWING: upsertTask RETURNINGs only the task id", async () => {
  const { store, recorded, close } = await openStore();
  try {
    seedTask(store);
    await store.whenIdle();

    assertNarrowedTo(
      recorded.only("scheduledTask", "upsert"),
      BY_ID,
      "upsertTask"
    );
  } finally {
    await close();
  }
});

// ──────────────────── advanceLastRun (736) ────────────────────

test("PARITY: advanceLastRun stamps last_run_at on the durable row", async () => {
  const { db, store, close } = await openStore();
  try {
    seedTask(store);
    store.advanceLastRun(TASK_ID, "2026-07-22T13:00:00.000Z");
    await store.whenIdle();

    const rows = await rowsOf<TaskRow>(
      db,
      "SELECT id, last_run_at, meta FROM scheduled_tasks"
    );
    assert.equal(rows[0].last_run_at, "2026-07-22T13:00:00.000Z");
  } finally {
    await close();
  }
});

test("NARROWING: advanceLastRun RETURNINGs only the task id", async () => {
  const { store, recorded, close } = await openStore();
  try {
    seedTask(store);
    await store.whenIdle();
    recorded.reset();

    store.advanceLastRun(TASK_ID, "2026-07-22T13:00:00.000Z");
    await store.whenIdle();

    assertNarrowedTo(
      recorded.only("scheduledTask", "update"),
      BY_ID,
      "advanceLastRun"
    );
  } finally {
    await close();
  }
});

/**
 * The parity case that forbids `updateMany` here. The durable row is deleted
 * out from under the in-memory file, so the write-behind's `update` hits no
 * row. `enqueue` swallows the rejection, so `whenIdle()` still resolves — the
 * ONLY surviving evidence is the log line. An `updateMany` would report
 * `{count: 0}` and log nothing, leaving the in-memory/durable divergence
 * completely invisible.
 */
test("PARITY: a missing durable row still raises P2025, surfaced as the write-behind log", async () => {
  const { db, store, logs, close } = await openStore();
  try {
    seedTask(store);
    await store.whenIdle();
    await db.query("DELETE FROM scheduled_tasks WHERE id = $1", [TASK_ID]);

    store.advanceLastRun(TASK_ID, "2026-07-22T13:00:00.000Z");
    await store.whenIdle();

    const failures = logs.filter((l) =>
      l.includes("SqliteTaskStore write-behind failed")
    );
    assert.equal(
      failures.length,
      1,
      `expected one swallowed write-behind failure, saw ${JSON.stringify(logs)}`
    );
  } finally {
    await close();
  }
});

// ──────────────────────── removeTask (683) ────────────────────────

test("PARITY: removeTask deletes the durable row", async () => {
  const { db, store, close } = await openStore();
  try {
    seedTask(store);
    await store.whenIdle();

    assert.equal(store.removeTask(TASK_ID), true);
    await store.whenIdle();

    const rows = await rowsOf<TaskRow>(db, "SELECT id FROM scheduled_tasks");
    assert.equal(rows.length, 0);
  } finally {
    await close();
  }
});

test("NARROWING: removeTask RETURNINGs only the deleted task id", async () => {
  const { store, recorded, close } = await openStore();
  try {
    seedTask(store);
    await store.whenIdle();
    recorded.reset();

    store.removeTask(TASK_ID);
    await store.whenIdle();

    assertNarrowedTo(
      recorded.only("scheduledTask", "delete"),
      BY_ID,
      "removeTask"
    );
  } finally {
    await close();
  }
});

// ─────────────────── startRun (831 create, 832 update) ───────────────────

test("PARITY: startRun persists the run row and stamps the task", async () => {
  const { db, store, close } = await openStore();
  try {
    const task = seedTask(store);
    const rec = store.startRun(task);
    await store.whenRunDurable(rec.id);
    await store.whenIdle();

    const runs = await rowsOf<RunRow>(
      db,
      "SELECT id, status, finished_at FROM scheduled_task_runs"
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, rec.id);

    const tasks = await rowsOf<{ last_run_id: string | null }>(
      db,
      "SELECT last_run_id FROM scheduled_tasks"
    );
    assert.equal(tasks[0].last_run_id, rec.id);
  } finally {
    await close();
  }
});

test("NARROWING: startRun RETURNINGs only the run id and the task id", async () => {
  const { store, recorded, close } = await openStore();
  try {
    const task = seedTask(store);
    await store.whenIdle();
    recorded.reset();

    store.startRun(task);
    await store.whenIdle();

    assertNarrowedTo(
      recorded.only("scheduledTaskRun", "create"),
      BY_ID,
      "startRun run insert"
    );
    assertNarrowedTo(
      recorded.only("scheduledTask", "update"),
      BY_ID,
      "startRun task stamp"
    );
  } finally {
    await close();
  }
});

// ─────────────── finishRun (899 run update, 914 task stamp) ───────────────

test("PARITY: finishRun updates the run row and mirrors lastStatus to the task", async () => {
  const { db, store, close } = await openStore();
  try {
    const task = seedTask(store);
    const rec = store.startRun(task);
    await store.whenIdle();

    store.finishRun(rec.id, {
      status: RunStatus.Success,
      finishedAt: "2026-07-22T13:00:00.000Z",
    });
    await store.whenIdle();

    const runs = await rowsOf<RunRow>(
      db,
      "SELECT id, status, finished_at FROM scheduled_task_runs"
    );
    assert.equal(runs[0].status, RunStatus.Success);
    assert.equal(runs[0].finished_at, "2026-07-22T13:00:00.000Z");

    const tasks = await rowsOf<{ last_status: string | null }>(
      db,
      "SELECT last_status FROM scheduled_tasks"
    );
    assert.equal(tasks[0].last_status, RunStatus.Success);
  } finally {
    await close();
  }
});

test("NARROWING: finishRun RETURNINGs only the run id and the task id", async () => {
  const { store, recorded, close } = await openStore();
  try {
    const task = seedTask(store);
    const rec = store.startRun(task);
    await store.whenIdle();
    recorded.reset();

    store.finishRun(rec.id, {
      status: RunStatus.Success,
      finishedAt: "2026-07-22T13:00:00.000Z",
    });
    await store.whenIdle();

    assertNarrowedTo(
      recorded.only("scheduledTaskRun", "update"),
      BY_ID,
      "finishRun run update"
    );
    assertNarrowedTo(
      recorded.only("scheduledTask", "update"),
      BY_ID,
      "finishRun task stamp"
    );
  } finally {
    await close();
  }
});

/**
 * The second `updateMany` refusal, and the sharper one: the throw does not just
 * log, it ABANDONS the rest of the write turn. With the run row missing,
 * `scheduledTaskRun.update` rejects and the `scheduledTask.update` loop that
 * follows it in the SAME callback never runs. Under `updateMany` that update
 * WOULD run, stamping a task from a run whose durable record does not exist.
 */
test("PARITY: a missing run row aborts the rest of the finishRun write turn", async () => {
  const { db, store, recorded, logs, close } = await openStore();
  try {
    const task = seedTask(store);
    const rec = store.startRun(task);
    await store.whenIdle();
    await db.query("DELETE FROM scheduled_task_runs WHERE id = $1", [rec.id]);
    recorded.reset();

    store.finishRun(rec.id, {
      status: RunStatus.Success,
      finishedAt: "2026-07-22T13:00:00.000Z",
    });
    await store.whenIdle();

    assert.equal(
      recorded.callsFor("scheduledTaskRun", "update").length,
      1,
      "the run update is attempted"
    );
    assert.equal(
      recorded.callsFor("scheduledTask", "update").length,
      0,
      "the P2025 must abort the turn BEFORE the task stamp — this is what updateMany would break"
    );
    assert.equal(
      logs.filter((l) => l.includes("SqliteTaskStore write-behind failed"))
        .length,
      1
    );
  } finally {
    await close();
  }
});

// ─────────────────── refreshNextRuns (773) ───────────────────

test("PARITY + NARROWING: refreshNextRuns stamps next_run_at and RETURNINGs only the id", async () => {
  const { db, store, recorded, close } = await openStore();
  try {
    seedTask(store);
    await store.whenIdle();
    // Clear the stamp the create computed, then REHYDRATE so the in-memory task
    // also carries a null slot — otherwise `refreshNextRuns` sees no change and
    // correctly enqueues nothing.
    await db.query("UPDATE scheduled_tasks SET next_run_at = NULL", []);
    const rehydrated = await SqliteTaskStore.create(
      schedulerStoreDeps(recorded.prisma)
    );
    assert.equal(rehydrated.getTask(TASK_ID)?.nextRunAt, null);
    recorded.reset();

    rehydrated.refreshNextRuns();
    await rehydrated.whenIdle();

    const rows = await rowsOf<{ next_run_at: string | null }>(
      db,
      "SELECT next_run_at FROM scheduled_tasks"
    );
    assert.notEqual(
      rows[0].next_run_at,
      null,
      "refreshNextRuns must persist the recomputed slot"
    );
    assertNarrowedTo(
      recorded.only("scheduledTask", "update"),
      BY_ID,
      "refreshNextRuns"
    );
  } finally {
    await close();
  }
});

// ─────────────────── stampOwnership (667) ───────────────────

test("PARITY + NARROWING: a confirmed native owner is mirrored to meta and RETURNINGs only the id", async () => {
  const opened = await openTestPrisma();
  const recorded = recordDesktopWrites(opened.prisma);
  const store = await SqliteTaskStore.create({
    ...schedulerStoreDeps(recorded.prisma),
    scheduledTasksRegistrar: {
      register: (task) =>
        Promise.resolve({ ok: true as const, ownerId: `native-${task.id}` }),
      deregister: () => Promise.resolve({ ok: true as const }),
    },
  });
  try {
    store.upsertTask({
      id: TASK_ID,
      name: "nightly sweep",
      cron: CRON,
      route: TaskRoute.ClaudeScheduledTasks,
    });
    await store.whenIdle();

    assert.equal(
      store.getTask(TASK_ID)?.meta[NATIVE_OWNER_META_KEY],
      `native-${TASK_ID}`,
      "the confirmed owner marker must be stamped in memory"
    );
    const rows = await rowsOf<TaskRow>(
      opened.db,
      "SELECT id, last_run_at, meta FROM scheduled_tasks"
    );
    assert.equal(
      JSON.parse(rows[0].meta ?? "{}")[NATIVE_OWNER_META_KEY],
      `native-${TASK_ID}`,
      "and mirrored to the durable row"
    );
    assertNarrowedTo(
      recorded.only("scheduledTask", "update"),
      BY_ID,
      "stampOwnership"
    );
  } finally {
    await opened.close();
  }
});
