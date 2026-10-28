/**
 * ISS-11322 — the DDL contract for the six folded `claude_code_*` families.
 *
 * The service doubles never execute this SQL, so without this file a change to
 * the migration could drop a cascade FK or weaken an index and no assertion
 * anywhere would move. The sibling `iss10717-…-migration.test.ts` pins the three
 * tables that lane created; this one pins what ISS-11322 added on top, and the
 * four things it pins are each load-bearing at runtime:
 *
 * - the two UNIQUE indexes are the breakdown upserts' `ON CONFLICT` targets, so
 *   losing either turns an idempotent redelivery into duplicate rows;
 * - the two `ON DELETE CASCADE` FKs are what make a deleted session take its
 *   breakdowns with it instead of stranding orphans;
 * - the three new count columns are NULLABLE WITH NO DEFAULT, which is the whole
 *   "unknown is not zero" contract at the storage layer;
 * - the three `*_recorded` booleans are NOT NULL DEFAULT false, which is what
 *   makes a row written by a pre-ISS-11322 build read as never-recorded rather
 *   than as a measured empty.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME = "20260929210000_iss11322_claude_code_telemetry_families";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(
  TEST_DIR,
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);
const DESTRUCTIVE_DDL_REGEX = /^\s*(?:DELETE|DROP|TRUNCATE)\b/im;

/** The three count families ISS-11322 folded in, all of which must stay nullable. */
const NULLABLE_COUNT_COLUMNS = [
  "auth_event_count",
  "plugin_event_count",
  "session_start_count",
] as const;

/**
 * The three omission-gated flags. FALSE is the truthful reading for a row a
 * pre-ISS-11322 build wrote, so the default is part of the contract rather than
 * a convenience.
 */
const RECORDED_FLAG_COLUMNS = [
  "active_time_recorded",
  "lines_of_code_recorded",
  "identity_recorded",
] as const;

describe(`${MIGRATION_NAME} migration contract`, () => {
  it("creates the two value-bearing breakdown tables", async () => {
    const sql = await migrationSql();

    expect(sql).toContain('CREATE TABLE "claude_code_active_time_telemetry"');
    expect(sql).toContain('CREATE TABLE "claude_code_lines_of_code_telemetry"');
  });

  it("keeps every added count column nullable with no default", async () => {
    const sql = await migrationSql();

    for (const column of NULLABLE_COUNT_COLUMNS) {
      expect(sql).toContain(`ADD COLUMN "${column}" INTEGER,`);
      expect(sql).not.toContain(`ADD COLUMN "${column}" INTEGER NOT NULL`);
      expect(sql).not.toContain(`ADD COLUMN "${column}" INTEGER DEFAULT`);
    }
  });

  it("defaults every recorded and truncated flag to false", async () => {
    const sql = await migrationSql();

    for (const column of [
      ...RECORDED_FLAG_COLUMNS,
      "active_time_truncated",
      "lines_of_code_truncated",
    ]) {
      expect(sql).toContain(
        `ADD COLUMN "${column}" BOOLEAN NOT NULL DEFAULT false`
      );
    }
  });

  it("carries each measurement at the precision the wire contract assumes", async () => {
    const activeTime = await createTableBlock(
      "claude_code_active_time_telemetry"
    );
    const linesOfCode = await createTableBlock(
      "claude_code_lines_of_code_telemetry"
    );

    // `Decimal(14,3)` is the domain the producer canonicalises against and the
    // wire schema refuses values outside; widening or narrowing it here silently
    // changes what a valid payload is. `line_count` is a BIGINT because a
    // long-lived machine exceeds the safe-integer range.
    expect(activeTime).toContain('"seconds" DECIMAL(14,3) NOT NULL');
    expect(linesOfCode).toContain('"line_count" BIGINT NOT NULL');
  });

  it("carries no user-account column on the rollup", async () => {
    const sql = await migrationSql();

    // The two columns of `claude_code_session_identity` that identify a PERSON
    // rather than describe the run are deliberately not synced. Moving one
    // across this boundary is a privacy decision for a human, not a side effect
    // of widening a telemetry rollup.
    expect(sql).not.toContain("user_account_uuid");
    expect(sql).not.toContain("user_account_id");
  });

  it("creates both ON CONFLICT targets and both cascade-support indexes", async () => {
    const sql = await migrationSql();

    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "claude_code_active_time_telemetry_artifact_type" ON "claude_code_active_time_telemetry"("artifact_id", "activity_type")'
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "claude_code_lines_of_code_telemetry_artifact_key" ON "claude_code_lines_of_code_telemetry"("artifact_id", "model", "change_type")'
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "claude_code_active_time_telemetry_artifact_id_idx" ON "claude_code_active_time_telemetry"("artifact_id")'
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "claude_code_lines_of_code_telemetry_artifact_id_idx" ON "claude_code_lines_of_code_telemetry"("artifact_id")'
    );
    expect(sql).toContain("index-lock-ok(claude_code_active_time_telemetry)");
    expect(sql).toContain("index-lock-ok(claude_code_lines_of_code_telemetry)");
  });

  it("cascades both foreign keys from the owning session", async () => {
    const sql = await migrationSql();

    expect(sql).toContain(
      'ALTER TABLE "claude_code_active_time_telemetry" ADD CONSTRAINT "claude_code_active_time_telemetry_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE'
    );
    expect(sql).toContain(
      'ALTER TABLE "claude_code_lines_of_code_telemetry" ADD CONSTRAINT "claude_code_lines_of_code_telemetry_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE'
    );
  });

  it("is additive — it destroys nothing", async () => {
    const sql = await migrationSql();

    expect(DESTRUCTIVE_DDL_REGEX.test(sql)).toBe(false);
  });
});

async function migrationSql(): Promise<string> {
  return await readFile(MIGRATION_PATH, "utf8");
}

/** One table's `CREATE TABLE ( ... )` body, so a column assertion cannot match a sibling table's column of the same name. */
async function createTableBlock(table: string): Promise<string> {
  const sql = await migrationSql();
  const start = sql.indexOf(`CREATE TABLE "${table}" (`);
  const end = sql.indexOf(");", start);
  if (start < 0 || end < start) {
    throw new Error(`no CREATE TABLE block for ${table} in ${MIGRATION_NAME}`);
  }
  return sql.slice(start, end);
}
