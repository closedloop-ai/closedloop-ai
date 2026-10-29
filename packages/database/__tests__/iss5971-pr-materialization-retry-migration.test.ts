import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME = "20260818200348_iss5971_loop_pr_materialization_retry";
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

describe(`${MIGRATION_NAME} migration contract`, () => {
  it("creates the internal fenced retry resource and due-order indexes", async () => {
    const sql = await migrationSql();
    const positivePrConstraint = statementContaining(
      sql,
      'CONSTRAINT "pr_materialization_retries_pull_request_number_positive_check"'
    );
    const stateConstraint = statementContaining(
      sql,
      'CONSTRAINT "pr_materialization_retries_state_check"'
    );
    const countersConstraint = statementContaining(
      sql,
      'CONSTRAINT "pr_materialization_retries_counters_nonnegative_check"'
    );
    const reasonConstraint = statementContaining(
      sql,
      'CONSTRAINT "pr_materialization_retries_reason_check"'
    );

    expect(sql).toContain('CREATE TABLE "pr_materialization_retries"');
    expect(sql).toContain('"claim_generation" INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('"next_attempt_at" TIMESTAMP(3) NOT NULL');
    expect(positivePrConstraint).toContain('CHECK ("pull_request_number" > 0)');
    expect(stateConstraint).toContain(
      "CHECK (\"state\" IN ('pending', 'claimed', 'terminal', 'dead_letter'))"
    );
    expect(countersConstraint).toContain(
      'CHECK ("attempts" >= 0 AND "claim_generation" >= 0)'
    );
    expect(reasonConstraint).toContain("'provider_unavailable'");
    expect(reasonConstraint).toContain("'permission_denied'");
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "pr_materialization_retries_due_idx" ON "pr_materialization_retries"("state", "next_attempt_at", "created_at")'
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "pr_materialization_retries_identity_key" ON "pr_materialization_retries"("organization_id", "loop_id", "base_repository_id", "pull_request_number")'
    );
  });

  it("cascades every retry owner without destructive migration DDL", async () => {
    const sql = await migrationSql();
    const expectedForeignKeys = [
      ["organization_id", "organizations"],
      ["loop_id", "loops"],
      ["source_artifact_id", "artifacts"],
      ["base_repository_id", "github_installation_repositories"],
    ] as const;

    for (const [column, table] of expectedForeignKeys) {
      expect(sql).toContain(
        `FOREIGN KEY ("${column}") REFERENCES "${table}"("id") ON DELETE CASCADE ON UPDATE CASCADE`
      );
    }
    expect(sql).not.toMatch(DESTRUCTIVE_DDL_REGEX);
  });
});

function migrationSql(): Promise<string> {
  return readFile(MIGRATION_PATH, "utf8");
}

function statementContaining(sql: string, marker: string): string {
  const markerIndex = sql.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Missing migration statement marker: ${marker}`);
  }
  const statementStart = sql.lastIndexOf("ALTER TABLE", markerIndex);
  const statementEnd = sql.indexOf(";", markerIndex);
  if (statementStart < 0 || statementEnd < 0) {
    throw new Error(`Incomplete migration statement marker: ${marker}`);
  }
  return sql.slice(statementStart, statementEnd + 1);
}
