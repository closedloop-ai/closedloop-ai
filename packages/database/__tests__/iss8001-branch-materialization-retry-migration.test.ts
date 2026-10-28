import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME = "20260825170000_iss8001_branch_materialization_retry";
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
const BRANCH_MATERIALIZATION_RETRY_INDEX_DDL_REGEX =
  /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "branch_materialization_retries/;

describe(`${MIGRATION_NAME} migration contract`, () => {
  it("creates the fenced Branch retry resource and due-order indexes", async () => {
    const sql = await migrationSql();
    const stateConstraint = statementContaining(
      sql,
      'CONSTRAINT "branch_materialization_retries_state_check"'
    );
    const countersConstraint = statementContaining(
      sql,
      'CONSTRAINT "branch_materialization_retries_counters_nonnegative_check"'
    );
    const reasonConstraint = statementContaining(
      sql,
      'CONSTRAINT "branch_materialization_retries_reason_check"'
    );

    expect(sql).toContain('CREATE TABLE "branch_materialization_retries"');
    expect(sql).toContain('"repository_full_name" TEXT NOT NULL');
    expect(sql).toContain('"branch_name" TEXT NOT NULL');
    expect(sql).toContain('"branch_ref" JSONB NOT NULL');
    expect(sql).toContain('"claim_generation" INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('"next_attempt_at" TIMESTAMP(3) NOT NULL');
    expect(stateConstraint).toContain(
      "CHECK (\"state\" IN ('pending', 'claimed', 'terminal', 'dead_letter'))"
    );
    expect(countersConstraint).toContain(
      'CHECK ("attempts" >= 0 AND "claim_generation" >= 0)'
    );
    expect(reasonConstraint).toContain("'authority_unavailable'");
    expect(reasonConstraint).toContain("'attempts_exhausted'");
    expect(reasonConstraint).toContain("'conflicting_authority'");
    expect(reasonConstraint).toContain("'corrupt_state'");
    expect(reasonConstraint).toContain("'cross_organization'");
    expect(reasonConstraint).toContain("'default_branch'");
    expect(reasonConstraint).toContain("'identity_mismatch'");
    expect(reasonConstraint).toContain("'source_missing'");
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "branch_materialization_retries_identity_key" ON "branch_materialization_retries"("organization_id", "source_artifact_id", "repository_full_name", "branch_name")'
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "branch_materialization_retries_due_idx" ON "branch_materialization_retries"("state", "next_attempt_at", "created_at")'
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "branch_materialization_retries_source_artifact_id_idx" ON "branch_materialization_retries"("source_artifact_id")'
    );
  });

  it("cascades retry owners without destructive migration DDL", async () => {
    const sql = await migrationSql();
    const expectedForeignKeys = [
      ["organization_id", "organizations"],
      ["source_artifact_id", "artifacts"],
    ] as const;

    for (const [column, table] of expectedForeignKeys) {
      expect(sql).toContain(
        `FOREIGN KEY ("${column}") REFERENCES "${table}"("id") ON DELETE CASCADE ON UPDATE CASCADE`
      );
    }
    expect(sql).not.toMatch(DESTRUCTIVE_DDL_REGEX);
  });

  it("documents every non-concurrent index as safe over the newly created empty table", async () => {
    const sql = await migrationSql();
    const indexStatements = sql
      .split("\n\n")
      .filter((statement) =>
        BRANCH_MATERIALIZATION_RETRY_INDEX_DDL_REGEX.test(statement)
      );

    expect(indexStatements).toHaveLength(3);
    for (const statement of indexStatements) {
      expect(statement).toContain(
        "index-lock-ok(branch_materialization_retries)"
      );
      expect(statement).toContain(
        "table is created empty in this same migration"
      );
    }

    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "branch_materialization_retries_identity_key"'
    );
    expect(sql).toContain(
      "CONCURRENTLY cannot be mixed with the table-creation DDL"
    );
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
