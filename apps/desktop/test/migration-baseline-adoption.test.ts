/**
 * @file migration-baseline-adoption.test.ts
 * @description Regression guard for an untracked, possibly-PARTIAL pre-existing
 * SQLite store, wired with the PRODUCTION manifest + baseline constants.
 *
 * Two boot crashes motivated this: (1) an interim store with the sentinel
 * `sessions` table but empty `_desktop_migrations` re-ran `CREATE TABLE
 * "sessions"` → `table "sessions" already exists`; (2) recording `0001_init` as
 * applied-without-executing for such a store left missing tables uncreated →
 * `no such table: model_pricing`. Both are fixed by writing `0001_init`
 * idempotently and applying it normally, so it reconciles complete and partial
 * stores alike.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BASELINE_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "../src/main/database/baseline-schema.js";
import {
  openLibsqlDatabase,
  type SqliteClient,
} from "../src/main/database/libsql-executor.js";
import { runDesktopMigrations } from "../src/main/database/migration-runner.js";
import { MIGRATIONS } from "../src/main/database/migrations-manifest.js";

const tempDirs: string[] = [];

test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function openDb(): Promise<SqliteClient> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-adopt-"));
  tempDirs.push(dir);
  const { db } = await openLibsqlDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  return db;
}

function runRealMigrations(db: SqliteClient) {
  return runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
}

async function tableExists(db: SqliteClient, name: string): Promise<boolean> {
  const r = await db.query<{ present: number }>(
    `SELECT EXISTS (
       SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $1
     ) AS present`,
    [name]
  );
  return r.rows[0]?.present === 1;
}

async function columnExists(
  db: SqliteClient,
  table: string,
  column: string
): Promise<boolean> {
  // `table` is a test literal, so inlining it into the pragma function is safe.
  const r = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = $1`,
    [column]
  );
  return Number(r.rows[0]?.n) > 0;
}

test("a clean install applies 0001_init once and is a no-op thereafter", async () => {
  const db = await openDb();
  try {
    const first = await runRealMigrations(db);
    assert.deepEqual(
      first.applied,
      MIGRATIONS.map((m) => m.name)
    );
    assert.ok(await tableExists(db, "sessions"));
    assert.ok(await tableExists(db, "model_pricing"));

    const second = await runRealMigrations(db);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.baselined, []);
  } finally {
    await db.close();
  }
});

test("an untracked PARTIAL store heals: missing tables are created, present ones survive", async () => {
  const db = await openDb();
  try {
    // First boot creates the full schema, then seed a row we expect to survive.
    await runRealMigrations(db);
    await db.query(
      `INSERT INTO sessions (id, status, harness)
       VALUES ('keep-me', 'completed', 'claude')`
    );

    // Simulate the broken interim store: a table is missing AND tracking is
    // wiped (so the runner sees an untracked, partial store).
    await db.exec('DROP TABLE "model_pricing";');
    await db.exec('DELETE FROM "_desktop_migrations";');
    assert.equal(await tableExists(db, "model_pricing"), false);
    assert.ok(await tableExists(db, "sessions"));

    // Re-running must NOT throw (idempotent CREATEs skip `sessions`), must
    // recreate `model_pricing`, and must preserve existing rows.
    const outcome = await runRealMigrations(db);
    assert.deepEqual(
      outcome.applied,
      MIGRATIONS.map((m) => m.name)
    );
    assert.ok(await tableExists(db, "model_pricing"));

    const kept = await db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sessions WHERE id = 'keep-me'"
    );
    assert.equal(Number(kept.rows[0]?.n), 1);
  } finally {
    await db.close();
  }
});

test("multi-ADD-COLUMN heal re-applies a MISSING column even when an earlier ADD is a duplicate", async () => {
  // Regression: the idempotent-heal must run a migration statement-by-statement
  // so a `duplicate column` on one ALTER cannot skip a later ALTER. Otherwise a
  // partially-applied migration (one column present, one missing) gets recorded
  // as applied with the schema permanently out of sync — a corruption path.
  const db = await openDb();
  try {
    await runRealMigrations(db);
    assert.ok(await columnExists(db, "artifacts", "committed_at"));
    assert.ok(await columnExists(db, "pull_requests", "opened_at"));

    // Simulate a partial 0005: committed_at present, opened_at dropped, tracking
    // wiped (untracked store). Re-running 0005's first ALTER throws `duplicate
    // column name: committed_at`.
    await db.exec('ALTER TABLE "pull_requests" DROP COLUMN "opened_at";');
    await db.exec('DELETE FROM "_desktop_migrations";');
    assert.ok(await columnExists(db, "artifacts", "committed_at"));
    assert.equal(await columnExists(db, "pull_requests", "opened_at"), false);

    const outcome = await runRealMigrations(db);
    assert.deepEqual(
      outcome.applied,
      MIGRATIONS.map((m) => m.name)
    );
    // The heal skipped the duplicate committed_at ADD but STILL applied the
    // missing opened_at ADD — schema is fully back in sync.
    assert.ok(await columnExists(db, "pull_requests", "opened_at"));
    assert.ok(await columnExists(db, "artifacts", "committed_at"));
  } finally {
    await db.close();
  }
});
