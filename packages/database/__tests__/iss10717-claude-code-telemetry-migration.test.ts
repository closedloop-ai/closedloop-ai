/**
 * ISS-10717 — the DDL contract for the cloud Claude Code telemetry tables.
 *
 * The service doubles never execute this SQL, so without this file a change to
 * the migration could drop a cascade FK or an index and no assertion anywhere
 * would move. Three things are pinned because all three are load-bearing at
 * runtime rather than cosmetic:
 *
 * - the two UNIQUE indexes are the ingest upserts' `ON CONFLICT` targets, so
 *   losing either turns an idempotent delivery into duplicate rows;
 * - the three `ON DELETE CASCADE` FKs are what make a deleted session or
 *   compute target take its telemetry with it instead of stranding orphans;
 * - every count column is NULLABLE WITH NO DEFAULT, which is the whole
 *   "unknown is not zero" contract at the storage layer. A `DEFAULT 0` here
 *   would state a measured absence the machine never observed.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME = "20260927030000_iss10717_claude_code_telemetry";
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
/** Every count column the rollup carries, all of which must stay nullable. */
const NULLABLE_COUNT_COLUMNS = [
  "cost_event_count",
  "api_request_count",
  "error_event_count",
  "permission_event_count",
  "permission_mode_change_count",
  "mcp_server_connection_count",
  "tool_result_count",
  "llm_request_count",
] as const;

describe(`${MIGRATION_NAME} migration contract`, () => {
  it("creates the three telemetry tables", async () => {
    const sql = await migrationSql();

    expect(sql).toContain('CREATE TABLE "claude_code_session_telemetry"');
    expect(sql).toContain('CREATE TABLE "claude_code_component_telemetry"');
    expect(sql).toContain('CREATE TABLE "claude_code_signal_drop_counter"');
  });

  it("keeps every rollup count column nullable with no default", async () => {
    // Scoped to the SESSION table's own CREATE block. `cost_event_count` exists
    // on the component table too, where it is deliberately `NOT NULL DEFAULT 0`
    // — a component row only exists because it has cost events, so there a zero
    // is unreachable rather than an unrecorded family.
    const block = await createTableBlock("claude_code_session_telemetry");

    for (const column of NULLABLE_COUNT_COLUMNS) {
      expect(block).toContain(`"${column}" INTEGER,`);
      expect(block).not.toContain(`"${column}" INTEGER NOT NULL`);
      expect(block).not.toContain(`"${column}" INTEGER DEFAULT`);
    }
  });

  it("makes a component's own cost_event_count non-null", async () => {
    const block = await createTableBlock("claude_code_component_telemetry");

    expect(block).toContain('"cost_event_count" INTEGER NOT NULL DEFAULT 0');
  });

  it("carries both costs at the column precision the wire contract assumes", async () => {
    const sql = await migrationSql();

    // `Decimal(14,6)` is the domain the producer canonicalises against and the
    // wire schema refuses values outside; a widened or narrowed column here
    // silently changes what a valid payload is.
    expect(sql).toContain('"cost_event_usd" DECIMAL(14,6)');
    expect(sql).toContain('"cost_usd" DECIMAL(14,6)');
    expect(sql).toContain('"api_request_cost_usd_micros" BIGINT');
    expect(sql).toContain('"dropped_count" BIGINT NOT NULL');
  });

  it("creates the two ON CONFLICT targets and the cascade-support index", async () => {
    const sql = await migrationSql();

    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "claude_code_component_telemetry_artifact_key" ON "claude_code_component_telemetry"("artifact_id", "attribution_key")'
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "claude_code_signal_drop_counter_natural" ON "claude_code_signal_drop_counter"("compute_target_id", "harness", "reason")'
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "claude_code_component_telemetry_artifact_id_idx" ON "claude_code_component_telemetry"("artifact_id")'
    );
    expect(sql).toContain("index-lock-ok(claude_code_component_telemetry)");
    expect(sql).toContain("index-lock-ok(claude_code_signal_drop_counter)");
  });

  it("cascades all three foreign keys from their owning record", async () => {
    const sql = await migrationSql();

    expect(sql).toContain(
      'ALTER TABLE "claude_code_session_telemetry" ADD CONSTRAINT "claude_code_session_telemetry_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE'
    );
    expect(sql).toContain(
      'ALTER TABLE "claude_code_component_telemetry" ADD CONSTRAINT "claude_code_component_telemetry_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE'
    );
    expect(sql).toContain(
      'ALTER TABLE "claude_code_signal_drop_counter" ADD CONSTRAINT "claude_code_signal_drop_counter_compute_target_id_fkey" FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE'
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
