/**
 * @file migration-0011-session-activity-segments.test.ts
 * @description FEA-2267 guard for the 0011 migration. Applies the committed
 * migration chain to a fresh libSQL database and asserts the
 * `session_activity_segments` + `activity_segment_backfill_seen` tables, their
 * indexes, and the backfill-seen → sessions foreign key exist; that an existing
 * install (chain minus 0011) upgrades cleanly and round-trips rows; and that the
 * migration is idempotent (IF NOT EXISTS).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compareMigrationDirNames } from "../scripts/migration-order.mjs";
import { openMigrationDatabase } from "../src/main/database/migration-executor.js";

const APP_DIR = path.join(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(APP_DIR, "prisma", "migrations");
const TARGET = "0011_session_activity_segments";

const tempDirs: string[] = [];

test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

function migrationDirNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareMigrationDirNames);
}

function migrationSql(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

async function openDb(): Promise<
  Awaited<ReturnType<typeof openMigrationDatabase>>["db"]
> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-0011-"));
  tempDirs.push(dir);
  const { db } = await openMigrationDatabase(path.join(dir, "store.sqlite"));
  return db;
}

async function applyChain(
  names: string[]
): Promise<Awaited<ReturnType<typeof openMigrationDatabase>>["db"]> {
  const db = await openDb();
  for (const name of names) {
    await db.exec(migrationSql(name));
  }
  return db;
}

test("0011 creates both tables with their indexes", async () => {
  const db = await applyChain(migrationDirNames());
  try {
    const tables = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name IN ('session_activity_segments', 'activity_segment_backfill_seen')
       ORDER BY name`
    );
    assert.deepEqual(
      tables.rows.map((r) => r.name),
      ["activity_segment_backfill_seen", "session_activity_segments"]
    );

    // Only the composite (session_id, start_ms) index exists: a standalone
    // (session_id) index would be redundant (the composite serves it as a
    // leftmost prefix), so it is intentionally absent.
    const indexes = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index'
         AND tbl_name = 'session_activity_segments'
         AND name LIKE 'idx_%'
       ORDER BY name`
    );
    assert.deepEqual(
      indexes.rows.map((r) => r.name),
      ["idx_session_activity_segments_session_start"]
    );

    const composite = await db.query<{ seqno: number; name: string }>(
      "SELECT seqno, name FROM pragma_index_info($1) ORDER BY seqno",
      ["idx_session_activity_segments_session_start"]
    );
    assert.deepEqual(
      composite.rows.map((r) => r.name),
      ["session_id", "start_ms"],
      "composite index leads with session_id then start_ms"
    );
  } finally {
    await db.close();
  }
});

test("activity_segment_backfill_seen has a cascading FK to sessions", async () => {
  const db = await applyChain(migrationDirNames());
  try {
    const fks = await db.query<{
      table: string;
      to: string;
      on_delete: string;
    }>('SELECT "table", "to", on_delete FROM pragma_foreign_key_list($1)', [
      "activity_segment_backfill_seen",
    ]);
    assert.equal(fks.rows.length, 1);
    assert.equal(fks.rows[0].table, "sessions");
    assert.equal(fks.rows[0].to, "id");
    assert.equal(fks.rows[0].on_delete, "CASCADE");
  } finally {
    await db.close();
  }
});

test("existing install (chain minus 0011) upgrades cleanly and round-trips rows", async () => {
  const without0011 = migrationDirNames().filter((name) => name !== TARGET);
  const db = await applyChain(without0011);
  try {
    // Pre-existing install already has sessions but not the new tables.
    await db.query(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ('s1', 'S1', 'completed', '2026-06-07T10:00:00.000Z', '2026-06-07T10:01:00.000Z', 'claude')`
    );
    // Apply only the new migration, mirroring an upgrade.
    await db.exec(migrationSql(TARGET));

    await db.query(
      `INSERT INTO session_activity_segments
         (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, observed_at)
       VALUES ('seg1', 's1', 'other', 1000, 2000, 1, '[]', 1, NULL, '2026-06-07T10:01:00.000Z')`
    );
    await db.query(
      `INSERT INTO activity_segment_backfill_seen
         (session_id, file_path, file_mtime_ms, classifier_version, scanned_at)
       VALUES ('s1', '/tmp/s1.jsonl', 123, 1, '2026-06-07T10:01:00.000Z')`
    );

    const seg = await db.query<{
      phase: string;
      start_ms: number;
      end_ms: number;
    }>(
      "SELECT phase, start_ms, end_ms FROM session_activity_segments WHERE id = 'seg1'"
    );
    assert.deepEqual(seg.rows, [
      { phase: "other", start_ms: 1000, end_ms: 2000 },
    ]);

    const seen = await db.query<{ classifier_version: number }>(
      "SELECT classifier_version FROM activity_segment_backfill_seen WHERE session_id = 's1'"
    );
    assert.equal(Number(seen.rows[0]?.classifier_version), 1);
  } finally {
    await db.close();
  }
});

test("re-applying 0011 is idempotent (IF NOT EXISTS)", async () => {
  const db = await applyChain(migrationDirNames());
  try {
    await db.exec(migrationSql(TARGET));
    const count = await db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name = 'session_activity_segments'`
    );
    assert.equal(Number(count.rows[0]?.count), 1);
  } finally {
    await db.close();
  }
});
