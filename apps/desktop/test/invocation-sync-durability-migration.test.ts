import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { compareMigrationDirNames } from "../scripts/migration-order.mjs";
import { openMigrationDatabase } from "../src/main/database/migration/migration-executor.js";

const APP_DIR = path.join(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(APP_DIR, "prisma", "migrations");
const OUTBOX_TABLE = "agent_component_invocation_sync_outbox";
const DURABILITY_COLUMNS = [
  "permanent_attempt_count",
  "lane_stalled_since",
  "dead_letter_recovery_count",
] as const;

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

test("PRD-699 adds nullable invocation outbox durability columns", async () => {
  const { db } = await openTestDatabase("schema");
  try {
    await db.exec(readAllMigrationSql());

    const columns = await readColumns(db, OUTBOX_TABLE);
    const byName = new Map(columns.map((column) => [column.name, column]));

    for (const columnName of DURABILITY_COLUMNS) {
      const column = byName.get(columnName);
      assert.ok(column, `expected column ${columnName} to exist`);
      assert.equal(column.notnull, 0, `column ${columnName} must be nullable`);
      assert.equal(
        column.dflt_value,
        null,
        `column ${columnName} must have no default`
      );
    }

    assert.equal(byName.get("permanent_attempt_count")?.type, "INTEGER");
    assert.equal(byName.get("dead_letter_recovery_count")?.type, "INTEGER");
    assert.equal(byName.get("lane_stalled_since")?.type, "TEXT");
  } finally {
    await db.close();
  }
});

test("omitting invocation durability columns leaves them NULL", async () => {
  const { db } = await openTestDatabase("null-default");
  try {
    await db.exec(readAllMigrationSql());
    await db.query(
      `INSERT INTO ${OUTBOX_TABLE} (
         source_key, external_session_id, external_generation_id,
         part_index, part_count, part_hash, source_updated_at, data_revision,
         source_sequence, payload, created_at, updated_at
       )
       VALUES ($1, $2, $3, 0, 1, $4, $5, 35, 1, $6, $5, $5)`,
      [
        "target:compute-1",
        "session-1",
        "generation-1",
        "hash-1",
        "2026-09-10T12:00:00.000Z",
        JSON.stringify({ ok: true }),
      ]
    );

    const stored = await db.query<Record<string, unknown>>(
      `SELECT permanent_attempt_count, lane_stalled_since,
              dead_letter_recovery_count
       FROM ${OUTBOX_TABLE}
       WHERE source_key = $1`,
      ["target:compute-1"]
    );

    assert.equal(stored.rows.length, 1);
    for (const columnName of DURABILITY_COLUMNS) {
      assert.equal(
        stored.rows[0]?.[columnName],
        null,
        `column ${columnName} must default to NULL when omitted`
      );
    }
  } finally {
    await db.close();
  }
});

type SqliteDb = Awaited<ReturnType<typeof openMigrationDatabase>>["db"];
type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
};

async function openTestDatabase(label: string): Promise<{ db: SqliteDb }> {
  const databasePath = await createDatabasePath(label);
  const { db } = await openMigrationDatabase(databasePath);
  return { db };
}

async function createDatabasePath(label: string): Promise<string> {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), `invocation-durability-${label}-`)
  );
  tempDirs.push(dir);
  return path.join(dir, "agent-dashboard.sqlite");
}

function readAllMigrationSql(): string {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareMigrationDirNames)
    .map((dirName) =>
      readFileSync(path.join(MIGRATIONS_DIR, dirName, "migration.sql"), "utf8")
    )
    .join("\n");
}

async function readColumns(
  db: SqliteDb,
  tableName: string
): Promise<ColumnInfo[]> {
  const columns = await db.query<ColumnInfo>(
    'SELECT name, type, "notnull", dflt_value FROM pragma_table_info($1)',
    [tableName]
  );
  return columns.rows;
}
