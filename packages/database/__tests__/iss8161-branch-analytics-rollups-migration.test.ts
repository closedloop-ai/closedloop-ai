import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME = "20260902191912_iss8161_branch_analytics_rollups";
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
  it("creates the Branch analytics rollup tables and read-path indexes", async () => {
    const sql = await migrationSql();

    expect(sql).toContain('CREATE TABLE "branch_analytics_session_rollups"');
    expect(sql).toContain('"branch_artifact_id" UUID NOT NULL');
    expect(sql).toContain('"session_artifact_id" UUID NOT NULL');
    expect(sql).toContain('"source" VARCHAR(64) NOT NULL');
    expect(sql).toContain('"bucket_start" TIMESTAMP(3) NOT NULL');
    expect(sql).toContain(
      '"source_max_event_created_at" TIMESTAMP(3) NOT NULL'
    );
    expect(sql).toContain('CREATE TABLE "branch_analytics_rollup_states"');
    expect(sql).toContain('"lag_seconds" INTEGER');
    expect(sql).toContain('"backfill_cursor_event_id" UUID');
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "branch_analytics_session_rollups_session_bucket_idx" ON "branch_analytics_session_rollups"("organization_id", "session_artifact_id", "source", "bucket_start")'
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "branch_analytics_session_rollups_branch_bucket_idx" ON "branch_analytics_session_rollups"("organization_id", "branch_artifact_id", "bucket_start")'
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "branch_analytics_session_rollups_session_artifact_id_idx" ON "branch_analytics_session_rollups"("session_artifact_id")'
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "branch_analytics_session_rollups_source_watermark_idx" ON "branch_analytics_session_rollups"("organization_id", "source_max_event_created_at")'
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "branch_analytics_session_rollups_org_source_as_of_idx" ON "branch_analytics_session_rollups"("organization_id", "source", "as_of")'
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "branch_analytics_session_rollups_identity_key" ON "branch_analytics_session_rollups"("organization_id", "branch_artifact_id", "session_artifact_id", "branch_participation", "source", "bucket_start")'
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "branch_analytics_rollup_states_due_idx" ON "branch_analytics_rollup_states"("state", "materialized_through_event_created_at")'
    );
    expect(sql).toContain("index-lock-ok(branch_analytics_session_rollups)");
    expect(sql).toContain("index-lock-ok(branch_analytics_rollup_states)");
  });

  it("cascades rollup owners without destructive migration DDL", async () => {
    const sql = await migrationSql();

    expect(sql).toContain(
      'ALTER TABLE "branch_analytics_session_rollups" ADD CONSTRAINT "branch_analytics_session_rollups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE'
    );
    expect(sql).toContain(
      'ALTER TABLE "branch_analytics_session_rollups" ADD CONSTRAINT "branch_analytics_session_rollups_branch_fkey" FOREIGN KEY ("organization_id", "branch_artifact_id") REFERENCES "branch_detail"("organization_id", "artifact_id") ON DELETE CASCADE ON UPDATE CASCADE'
    );
    expect(sql).toContain(
      'ALTER TABLE "branch_analytics_session_rollups" ADD CONSTRAINT "branch_analytics_session_rollups_session_artifact_id_fkey" FOREIGN KEY ("session_artifact_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE'
    );
    expect(sql).toContain(
      'ALTER TABLE "branch_analytics_rollup_states" ADD CONSTRAINT "branch_analytics_rollup_states_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE'
    );
    expect(sql).not.toMatch(DESTRUCTIVE_DDL_REGEX);
  });
});

function migrationSql(): Promise<string> {
  return readFile(MIGRATION_PATH, "utf8");
}
