/**
 * @file migration-0002-idx-token-events-session-created.test.ts
 * @description Focused guard for the 0002 composite index migration. Applies
 * the committed migration chain to a fresh libSQL database and asserts the
 * `idx_token_events_session_created` index exists in sqlite_master and covers
 * (session_id, created_at) in that order — the column order the append-path
 * HWM query (`SELECT MAX(created_at) ... WHERE session_id = ?`) and the byDay
 * analytics grouping rely on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openMigrationDatabase } from "../src/main/database/migration-executor.js";

const APP_DIR = path.join(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(APP_DIR, "prisma", "migrations");
const MIGRATION_NAMES = ["0001_init", "0002_idx_token_events_session_created"];

const tempDirs: string[] = [];

test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function applyMigrationChain(): Promise<
  Awaited<ReturnType<typeof openMigrationDatabase>>["db"]
> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-0002-"));
  tempDirs.push(dir);
  const { db } = await openMigrationDatabase(path.join(dir, "store.sqlite"));
  for (const name of MIGRATION_NAMES) {
    const sql = readFileSync(
      path.join(MIGRATIONS_DIR, name, "migration.sql"),
      "utf8"
    );
    await db.exec(sql);
  }
  return db;
}

test("0002 creates idx_token_events_session_created on token_events", async () => {
  const db = await applyMigrationChain();
  try {
    const result = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = $1`,
      ["idx_token_events_session_created"]
    );
    assert.equal(
      result.rows[0]?.name,
      "idx_token_events_session_created",
      "expected idx_token_events_session_created to exist after the migration chain"
    );
  } finally {
    await db.close();
  }
});

test("idx_token_events_session_created covers (session_id, created_at) in order", async () => {
  const db = await applyMigrationChain();
  try {
    // pragma_index_info lists the indexed columns by ordinal (seqno).
    const result = await db.query<{ seqno: number; name: string }>(
      "SELECT seqno, name FROM pragma_index_info($1) ORDER BY seqno",
      ["idx_token_events_session_created"]
    );
    assert.deepEqual(
      result.rows.map((row) => row.name),
      ["session_id", "created_at"],
      "composite index must lead with session_id then created_at"
    );
  } finally {
    await db.close();
  }
});

test("re-applying the 0002 migration is idempotent (IF NOT EXISTS)", async () => {
  const db = await applyMigrationChain();
  try {
    const sql = readFileSync(
      path.join(
        MIGRATIONS_DIR,
        "0002_idx_token_events_session_created",
        "migration.sql"
      ),
      "utf8"
    );
    // The migration guards with IF NOT EXISTS, so a second apply must not throw.
    await db.exec(sql);
    const result = await db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'index' AND name = $1`,
      ["idx_token_events_session_created"]
    );
    assert.equal(Number(result.rows[0]?.count), 1);
  } finally {
    await db.close();
  }
});
