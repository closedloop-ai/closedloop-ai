import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME = "20260818170000_iss6980_branch_activity_integrity";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(
  TEST_DIR,
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);
const DESTRUCTIVE_DDL_RE = /^\s*(?:DELETE|DROP|TRUNCATE)\b/im;

describe(`${MIGRATION_NAME} migration contract`, () => {
  it("adds nullable typed activity kind and durable quarantine identity", async () => {
    const sql = await migrationSql();

    expect(sql).toContain(
      'ALTER TABLE "branch_activity_atoms" ADD COLUMN "activity_kind" VARCHAR(32);'
    );
    expect(sql).toContain(
      'ALTER TABLE "branch_activity_atoms" ADD COLUMN "compatibility_alias_for_source_event_id" VARCHAR(512);'
    );
    expect(sql).toContain(
      "\"activity_kind\" IN ('user_reference', 'agent_read', 'agent_action')"
    );
    expect(sql).toContain(
      'CREATE TABLE "monitored_session_activity_quarantine"'
    );
    expect(sql).toContain('"event_identity_hash" CHAR(64) NOT NULL');
    expect(sql).toContain('"received_at" TIMESTAMPTZ NOT NULL');
    expect(sql).toContain(
      'ON "monitored_session_activity_quarantine"("organization_id", "session_artifact_id", "event_identity_hash")'
    );
    expect(sql).toContain(
      'CREATE TRIGGER "monitored_activity_quarantine_session_owner_check"'
    );
    expect(sql).toContain("artifact.\"type\" = 'SESSION'");
    expect(sql).not.toContain('"target_identity"');
    expect(sql).not.toContain('"source_event_id" VARCHAR(512) NOT NULL');
    expect(sql).not.toContain("monitored_activity_quarantine_session_idx");
  });

  it("repairs only a scalar exactly proven to equal a future-poisoned atom", async () => {
    const sql = await migrationSql();

    expect(sql).toContain('poisoned."occurred_at" = branch."last_activity_at"');
    expect(sql).toContain(
      'poisoned."occurred_at" > poisoned."created_at" + INTERVAL \'24 hours\''
    );
    expect(sql).toContain(
      'trusted."occurred_at" <= trusted."created_at" + INTERVAL \'24 hours\''
    );
    expect(sql).toContain(
      'branch."last_activity_at" IS DISTINCT FROM recomputed."last_activity_at"'
    );
    expect(sql).toContain('ORDER BY branch."artifact_id"');
    expect(sql).toContain("FOR UPDATE OF branch");
    expect(sql).toContain(
      'trusted."compatibility_alias_for_source_event_id" IS NULL'
    );
  });

  it("is additive apart from the bounded compatibility repair", async () => {
    const sql = await migrationSql();

    expect(sql).not.toMatch(DESTRUCTIVE_DDL_RE);
    expect(sql).not.toContain('ALTER COLUMN "activity_kind" SET NOT NULL');
    expect(sql.match(/^UPDATE\s+/gim)).toHaveLength(1);
  });
});

function migrationSql(): Promise<string> {
  return readFile(MIGRATION_PATH, "utf8");
}
