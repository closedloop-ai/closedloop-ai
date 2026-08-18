/**
 * @file scheduler-fire-cursor-durability.test.ts
 * @description ISS-4814 — the two properties that make the one-time fire cursor
 * an actual crash barrier rather than an in-memory hint:
 *
 *  1. `SqliteTaskStore.whenRunDurable(runId)` does not resolve until the launch
 *     record AND the `fired_at` stamp have reached SQLite. `SqliteTaskStore`
 *     serves the synchronous `StorePort` contract from an in-memory mirror and
 *     mirrors to SQLite through an unawaited write-behind, so `startRun`
 *     returning proves nothing about what survives a kill. `Daemon.launch` awaits
 *     this before it dispatches; if it resolved early, a process killed after the
 *     harness launched would restart with no cursor and re-fire the task.
 *  2. Migration 0047 BACKFILLS the cursor for one-time tasks that already fired
 *     under an older build. That population — `recurring = 0`, still
 *     `enabled = 1`, `last_run_at` set — is the crash survivor this issue exists
 *     to protect, and a blanket-NULL column would tell the upgraded daemon it had
 *     never fired.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BASELINE_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "../src/main/database/migration/baseline-schema.js";
import {
  openMigrationDatabase,
  type SqliteClient,
} from "../src/main/database/migration/migration-executor.js";
import { runDesktopMigrations } from "../src/main/database/migration/migration-runner.js";
import { MIGRATIONS } from "../src/main/database/migration/migrations-manifest.js";
import { SqliteTaskStore } from "../src/main/scheduler/sqlite-task-store.js";
import {
  openTestPrisma,
  SCHEDULER_TEST_NOW,
  schedulerStoreDeps as storeDeps,
} from "./prisma-test-utils.js";

const FIRE_CURSOR_MIGRATION = "0047_iss4814_scheduled_task_fire_cursor";

type ScheduledTaskCursorRow = {
  id: string;
  fired_at: string | null;
};

const tempDirs: string[] = [];

test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function openMigrationTestDb(): Promise<SqliteClient> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fire-cursor-migration-"));
  tempDirs.push(dir);
  const { db } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  return db;
}

async function readCursors(
  db: SqliteClient
): Promise<ScheduledTaskCursorRow[]> {
  const rows = await db.query<ScheduledTaskCursorRow>(
    "SELECT id, fired_at FROM scheduled_tasks ORDER BY id"
  );
  return rows.rows;
}

test("ISS-4814: whenRunDurable waits for the fire cursor to reach SQLite", async () => {
  const { prisma, close } = await openTestPrisma();
  const deps = storeDeps(prisma);
  // A gate the test opens by hand, wrapped around the SAME production write
  // seam the store uses. While it is closed no write-behind can reach SQLite, so
  // "the cursor is not committed yet" is a fact about the database rather than a
  // race the test has to win.
  let gate: Promise<void> | null = null;
  const store = await SqliteTaskStore.create({
    ...deps,
    write: async (fn) => {
      if (gate) {
        await gate;
      }
      return await deps.write(fn);
    },
  });
  try {
    const task = store.upsertTask({
      id: "one-shot",
      name: "fires exactly once",
      cron: "* * * * *",
      recurring: false,
      lastRunAt: new Date(SCHEDULER_TEST_NOW.getTime() - 60_000).toISOString(),
    });
    await store.whenIdle();

    let openGate: (() => void) | undefined;
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const rec = store.startRun(task);
    // The in-memory mirror already reads as fired — that is exactly the state
    // that must NOT be trusted as durable.
    assert.equal(store.getTask("one-shot")?.firedAt, rec.startedAt);

    // Nothing has been committed: a restart right here would find no cursor.
    // Safe, because the daemon has not dispatched — it is still awaiting
    // `whenRunDurable`.
    const beforeRelease = await SqliteTaskStore.create(deps);
    assert.equal(
      beforeRelease.getTask("one-shot")?.firedAt,
      null,
      "the cursor must not be readable from SQLite before the write lands"
    );

    openGate?.();
    await store.whenRunDurable(rec.id);

    // Once it resolves the cursor IS committed — read through a fresh store so
    // this is the durable row, not the writer's mirror.
    const afterRelease = await SqliteTaskStore.create(deps);
    assert.equal(
      afterRelease.getTask("one-shot")?.firedAt,
      rec.startedAt,
      "whenRunDurable must not resolve until the fire cursor is durable"
    );
    assert.equal(afterRelease.listRuns("one-shot").length, 1);
    // Spending the fire also retires the schedule: no next run is advertised.
    assert.equal(afterRelease.getTask("one-shot")?.nextRunAt, null);
    // `enabled` stays the operator's flag, untouched by retirement.
    assert.equal(afterRelease.getTask("one-shot")?.enabled, true);

    // An unknown or already-settled run id resolves rather than hanging.
    await store.whenRunDurable("no-such-run");
  } finally {
    gate = null;
    await store.whenIdle();
    await close();
  }
});

test("ISS-4814: migration 0047 backfills the cursor for one-time tasks that already fired", async () => {
  const db = await openMigrationTestDb();
  // Slice at the fire-cursor migration rather than FILTERING it out: filtering
  // keeps every LATER migration, which would record a newer migration as applied
  // while 0047 is not — a history gap the runner (correctly) refuses to boot on.
  // Slicing keeps this test pinned to its own upgrade step as the manifest grows.
  const cursorIndex = MIGRATIONS.findIndex(
    (m) => m.name === FIRE_CURSOR_MIGRATION
  );
  assert.ok(
    cursorIndex >= 0,
    "the fire-cursor migration must be present in the manifest"
  );
  const upTo = MIGRATIONS.slice(0, cursorIndex);
  const throughCursor = MIGRATIONS.slice(0, cursorIndex + 1);

  // Bring the database to the state an installed build sits at BEFORE this
  // upgrade, then seed the rows that build could have left behind.
  await runDesktopMigrations(db, {
    migrations: upTo,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });

  const firedAt = "2026-07-22T11:00:00.000Z";
  const seed = async (
    id: string,
    recurring: number,
    enabled: number,
    lastRunAt: string | null
  ): Promise<void> => {
    await db.query(
      `INSERT INTO scheduled_tasks
         (id, name, cron, prompt, recurring, durable, crew, kind, route,
          harness_cascade, timezone, enabled, catch_up, meta,
          last_run_at, created_at, updated_at)
       VALUES ($1, $2, '* * * * *', '', $3, 1, '', 'custom', 'local-cascade',
               '[]', '', $4, 1, '{}', $5, $6, $6)`,
      [id, id, recurring, enabled, lastRunAt, firedAt]
    );
  };

  // The crash survivor: one-time, STILL enabled (the old build died before its
  // retire-by-disable), and carrying the launch stamp of the fire that happened.
  await seed("crash-survivor", 0, 1, firedAt);
  // A one-time task the old build did retire the legacy way.
  await seed("legacy-retired", 0, 0, firedAt);
  // A one-time task that has genuinely never fired — it still owes its one run.
  await seed("never-fired", 0, 1, null);
  // A recurring task tracks cadence through last_run_at and must never be
  // stamped, or it would be read as spent and stop firing forever.
  await seed("recurring", 1, 1, firedAt);

  const outcome = await runDesktopMigrations(db, {
    migrations: throughCursor,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  assert.deepEqual(
    outcome.applied,
    [FIRE_CURSOR_MIGRATION],
    "only the fire-cursor migration should apply on this upgrade"
  );

  assert.deepEqual(await readCursors(db), [
    // Backfilled to the instant of its fire, so the upgraded daemon's fire-once
    // guard refuses it instead of re-launching it.
    { id: "crash-survivor", fired_at: firedAt },
    { id: "legacy-retired", fired_at: firedAt },
    { id: "never-fired", fired_at: null },
    { id: "recurring", fired_at: null },
  ]);

  await db.close();
});
