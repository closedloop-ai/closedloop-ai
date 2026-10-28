/**
 * @file iss7820-session-analytics-est-cost-nullable-migration.test.ts
 * @description ISS-7820 review (davetho): behavioural coverage for desktop
 * migration `0072_iss7820_session_analytics_est_cost_nullable`, applied to a
 * POPULATED 0071 store.
 *
 * The migration-agreement and baseline-equivalence checks both start from an
 * empty schema, so they compare DDL and would stay green through a copied-column
 * regression that silently reordered the INSERT ... SELECT column lists, dropped
 * a column, coerced a real legacy `0` into `NULL`, or lost
 * `idx_session_analytics_started_day` with the dropped table. This applies every
 * predecessor, seeds rows the migration must carry across VERBATIM, then applies
 * 0072 and asserts the data — which is the half no DDL comparison can see.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { compareMigrationDirNames } from "../scripts/migration-order.mjs";
import { openMigrationDatabase } from "../src/main/database/migration/migration-executor.js";

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

test("0072 carries every seeded session_analytics row across verbatim", async () => {
  const { db } = await openTestDatabase("verbatim");
  try {
    await applyPredecessors(db);
    await seedFixture(db);
    const before = await readAnalyticsRows(db);

    await db.exec(readMigrationSql());

    assert.deepEqual(await readAnalyticsRows(db), before);
    // Named explicitly so a silent row loss cannot pass as "both sides equal".
    assert.equal(before.length, 3);
    assert.deepEqual(
      before.map((row) => [row.session_id, row.est_cost]),
      [
        ["sess-priced", 4.475],
        ["sess-real-zero", 0],
        ["sess-web-search-only", 0.03],
      ]
    );
  } finally {
    await db.close();
  }
});

test("0072 keeps the started_day index", async () => {
  const { db } = await openTestDatabase("index");
  try {
    await applyPredecessors(db);
    await seedFixture(db);
    assert.equal(await hasStartedDayIndex(db), true);

    await db.exec(readMigrationSql());

    assert.equal(await hasStartedDayIndex(db), true);
  } finally {
    await db.close();
  }
});

test("0072 is what makes est_cost able to say unknown", async () => {
  const { db } = await openTestDatabase("nullable");
  try {
    await applyPredecessors(db);
    await seedFixture(db);

    await assert.rejects(
      () => insertUnknownCostRow(db, "sess-before"),
      "0071 must still reject a NULL est_cost, or this migration proves nothing"
    );

    await db.exec(readMigrationSql());

    await insertUnknownCostRow(db, "sess-after");
    assert.deepEqual(
      (await readAnalyticsRows(db))
        .filter((row) => row.session_id === "sess-after")
        .map((row) => row.est_cost),
      [null]
    );
  } finally {
    await db.close();
  }
});

type SqliteDb = Awaited<ReturnType<typeof openMigrationDatabase>>["db"];

const APP_DIR = path.join(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(APP_DIR, "prisma", "migrations");
const MIGRATION_DIR = "0072_iss7820_session_analytics_est_cost_nullable";
const SEED_TIMESTAMP = "2026-08-01T12:00:00.000Z";
const tempDirs: string[] = [];

async function openTestDatabase(label: string): Promise<{ db: SqliteDb }> {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), `iss7820-est-cost-${label}-`)
  );
  tempDirs.push(dir);
  const { db } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  return { db };
}

/** Everything that sorts strictly BEFORE 0072, so 0072's effect is isolated. */
async function applyPredecessors(db: SqliteDb): Promise<void> {
  const sql = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        compareMigrationDirNames(entry.name, MIGRATION_DIR) < 0
    )
    .map((entry) => entry.name)
    .sort(compareMigrationDirNames)
    .map((dirName) =>
      readFileSync(path.join(MIGRATIONS_DIR, dirName, "migration.sql"), "utf8")
    )
    .join("\n");
  await db.exec(sql);
}

function readMigrationSql(): string {
  return readFileSync(
    path.join(MIGRATIONS_DIR, MIGRATION_DIR, "migration.sql"),
    "utf8"
  );
}

/**
 * Three legacy rows spanning the values the migration must not reinterpret: a
 * genuine `0`, the web-search-line-item-alone `0.03` the ticket measured, and an
 * ordinary total. Every other column carries a distinct value so a reordered
 * INSERT ... SELECT column list cannot land back on itself.
 */
async function seedFixture(db: SqliteDb): Promise<void> {
  await db.query(
    `INSERT INTO session_analytics (
       session_id, started_at, started_day, status, harness, is_human,
       human_turns, agent_turns, event_count, tool_invocations, error_events,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       est_cost, runtime_ms, updated_at
     ) VALUES
       ($1, $4, '2026-08-01', 'inactive', 'claude', 0, 1, 2, 3, 4, 5, 11, 12, 13, 14, 0, 1000, $4),
       ($2, $4, '2026-08-02', 'active', 'codex', 1, 6, 7, 8, 9, 10, 21, 22, 23, 24, 0.03, 2000, $4),
       ($3, $4, '2026-08-03', 'error', 'opencode', 0, 15, 16, 17, 18, 19, 31, 32, 33, 34, 4.475, 3000, $4)`,
    ["sess-real-zero", "sess-web-search-only", "sess-priced", SEED_TIMESTAMP]
  );
}

async function insertUnknownCostRow(
  db: SqliteDb,
  sessionId: string
): Promise<void> {
  await db.query(
    `INSERT INTO session_analytics (session_id, started_day, est_cost)
     VALUES ($1, '2026-08-04', NULL)`,
    [sessionId]
  );
}

type AnalyticsRowSnapshot = {
  session_id: string;
  est_cost: number | null;
  columns: string;
};

/**
 * Every column, stringified in one deterministic order, so an assertion over the
 * snapshot fails on a reordered or dropped column rather than only on the one
 * value the test happens to name. BigInt counts are normalized so the comparison
 * is by value and not by storage class.
 */
async function readAnalyticsRows(
  db: SqliteDb
): Promise<AnalyticsRowSnapshot[]> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT session_id, started_at, started_day, status, harness, is_human,
            human_turns, agent_turns, event_count, tool_invocations, error_events,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            est_cost, runtime_ms, updated_at
     FROM session_analytics
     ORDER BY session_id ASC`
  );
  return result.rows.map((row) => ({
    columns: Object.entries(row)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("|"),
    est_cost: row.est_cost === null ? null : Number(row.est_cost),
    session_id: String(row.session_id),
  }));
}

async function hasStartedDayIndex(db: SqliteDb): Promise<boolean> {
  const result = await db.query<{ name: string }>(
    `SELECT name FROM sqlite_master
     WHERE type = 'index' AND name = 'idx_session_analytics_started_day'`
  );
  return result.rows.length === 1;
}
