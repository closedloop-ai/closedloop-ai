import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compareMigrationDirNames } from "../scripts/migration-order.mjs";
import { openMigrationDatabase } from "../src/main/database/migration/migration-executor.js";

// FEA-3981 (PLN-1488) Slice A: per-migration DDL contract guard for the
// additive per-component telemetry columns on agent_component_invocations — the
// per-INVOCATION grain, so a subagent that ran under multiple models yields one
// row per model turn and "mixed-model" is naturally representable (see the
// migration header). The migration only ADDs columns — nullable, no default —
// so legacy rows stay NULL ("not computed"). This test applies the full
// migration chain to a fresh SQLite database and asserts the resulting table
// shape and the null-on-omit behavior, rather than substring-matching the
// migration source.

const APP_DIR = path.join(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(APP_DIR, "prisma", "migrations");
const INVOCATION_TABLE = "agent_component_invocations";
const TELEMETRY_COLUMNS = [
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "estimated_cost",
  "footprint_tokens",
] as const;

const tempDirs: string[] = [];

test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

test("Slice A adds the telemetry columns as nullable, no-default", async () => {
  const { db } = await openTestDatabase("schema");
  try {
    await db.exec(readAllMigrationSql());

    const columns = await readColumns(db, INVOCATION_TABLE);
    const byName = new Map(columns.map((column) => [column.name, column]));

    for (const columnName of TELEMETRY_COLUMNS) {
      const column = byName.get(columnName);
      assert.ok(column, `expected column ${columnName} to exist`);
      assert.equal(
        column.notnull,
        0,
        `column ${columnName} must be nullable (NOT NULL = 0)`
      );
      assert.equal(
        column.dflt_value,
        null,
        `column ${columnName} must have no default`
      );
    }

    // BIGINT matches the token_usage BigInt convention (migration 0001);
    // SQLite gives it INTEGER affinity but records the declared type name.
    assert.equal(
      byName.get("input_tokens")?.type.toUpperCase(),
      "BIGINT",
      "token counts must be stored as BIGINT"
    );
    assert.equal(
      byName.get("footprint_tokens")?.type.toUpperCase(),
      "BIGINT",
      "footprint tokens must be stored as BIGINT"
    );
    assert.equal(
      byName.get("estimated_cost")?.type.toUpperCase(),
      "REAL",
      "estimated cost must be stored as REAL"
    );
    assert.equal(
      byName.get("model")?.type.toUpperCase(),
      "TEXT",
      "model must be stored as TEXT"
    );
  } finally {
    await db.close();
  }
});

test("omitting the telemetry columns leaves them NULL", async () => {
  const { db } = await openTestDatabase("null-default");
  try {
    await db.exec(readAllMigrationSql());

    // agent_component_invocations FKs sessions(id); insert the parent first.
    await db.query(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, 'telemetry session', 'completed',
               '2026-06-25T19:24:00.000Z', '2026-06-25T19:24:00.000Z', 'claude')`,
      ["session-1"]
    );
    // Insert a row without any telemetry columns — they must land NULL.
    await db.query(
      `INSERT INTO ${INVOCATION_TABLE} (
         id, session_id, external_invocation_id, component_kind, component_key,
         relationship, sequence, anchor_kind, anchor_value, attribution_status,
         evidence_class, created_at, updated_at
       )
       VALUES ($1, $2, 'ext-1', 'subagent', 'code-reviewer', 'child', 0,
               'tool_use_id', 'anchor-1', 'attributed', 'strong',
               '2026-06-25T19:24:00.000Z', '2026-06-25T19:24:00.000Z')`,
      ["invocation-1", "session-1"]
    );

    const stored = await db.query<Record<string, unknown>>(
      `SELECT model, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, estimated_cost, footprint_tokens
       FROM ${INVOCATION_TABLE}
       WHERE id = $1`,
      ["invocation-1"]
    );

    assert.equal(stored.rows.length, 1);
    const row = stored.rows[0];
    for (const columnName of TELEMETRY_COLUMNS) {
      assert.equal(
        row[columnName],
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
    path.join(os.tmpdir(), `component-telemetry-${label}-`)
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
