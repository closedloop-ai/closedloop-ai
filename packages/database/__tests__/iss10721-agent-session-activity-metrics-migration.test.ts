import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME = "20260921220000_iss10721_agent_session_activity_metrics";
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
/** Any column given a server-side default. */
const COLUMN_DEFAULT_REGEX = /^\s+"(\w+)"[^,]*\bDEFAULT\b/gim;
/** A `NOT NULL` or a `DEFAULT` on a column definition — either states a value. */
const STATES_A_VALUE_REGEX = /NOT NULL|DEFAULT/;
const TRAILING_COMMA_REGEX = /,$/;

describe(`${MIGRATION_NAME} migration contract`, () => {
  it("creates the session activity-metrics rollup table with its PK and FK", async () => {
    const sql = await migrationSql();

    expect(sql).toContain('CREATE TABLE "agent_session_activity_metrics"');
    expect(sql).toContain('"agent_session_id" UUID NOT NULL');
    expect(sql).toContain('"spend_low_conf_usd" DECIMAL(14,6)');
    expect(sql).toContain('"spend_medium_conf_usd" DECIMAL(14,6)');
    expect(sql).toContain('"spend_high_conf_usd" DECIMAL(14,6)');
    expect(sql).toContain('"coverage" DOUBLE PRECISION');
    expect(sql).toContain(
      'CONSTRAINT "agent_session_activity_metrics_pkey" PRIMARY KEY ("agent_session_id")'
    );
    expect(sql).toContain(
      'ALTER TABLE "agent_session_activity_metrics" ADD CONSTRAINT "agent_session_activity_metrics_agent_session_id_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE'
    );
    expect(sql).not.toMatch(DESTRUCTIVE_DDL_REGEX);
  });

  it("gives NO measure a NOT NULL or a default, so unknown cannot read as zero", async () => {
    const sql = await migrationSql();

    // The whole point of the table: a session whose rollup never ran holds no
    // row, and a producer that computed only some measures leaves the rest
    // NULL. A `NOT NULL DEFAULT 0` on any of these would state a measurement
    // — 0% coverage, 0 segments — for every session that was never measured.
    for (const column of [
      "autonomy_band",
      "coverage",
      "spend_low_conf_usd",
      "spend_medium_conf_usd",
      "spend_high_conf_usd",
      "segment_count",
      "covered_segment_count",
      "classifier_version",
      "metric_version",
    ]) {
      expect(columnDefinition(sql, column)).not.toMatch(STATES_A_VALUE_REGEX);
    }
    // Only the bookkeeping timestamps may carry a default — asserted as an
    // exact set so a future measure column cannot quietly acquire one.
    expect(columnsWithDefaults(sql)).toEqual(["created_at"]);
  });
});

function migrationSql(): Promise<string> {
  return readFile(MIGRATION_PATH, "utf8");
}

/** The single DDL line declaring `column`, without its trailing comma. */
function columnDefinition(sql: string, column: string): string {
  const line = sql
    .split("\n")
    .find((candidate) => candidate.trim().startsWith(`"${column}"`));
  if (line === undefined) {
    throw new Error(
      `no column definition for "${column}" in ${MIGRATION_NAME}`
    );
  }
  return line.trim().replace(TRAILING_COMMA_REGEX, "");
}

/** Every column the migration gives a server-side default, in file order. */
function columnsWithDefaults(sql: string): string[] {
  return [...sql.matchAll(COLUMN_DEFAULT_REGEX)].map((match) => match[1]);
}
