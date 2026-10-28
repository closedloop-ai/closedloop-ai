import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME = "20261002145520_iss10992_branch_push_contributions";
const MIGRATION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);
const CREATE_TABLE_RE =
  /CREATE TABLE "branch_push_contributions" \(([\s\S]*?)\);/;
const DEDUPE_CONSTRAINT_RE =
  /CONSTRAINT "branch_push_contributions_dedupe_key" UNIQUE \([^)]*\)/;
const ADD_FOREIGN_KEY_RE =
  /ALTER TABLE "branch_push_contributions" ADD CONSTRAINT "branch_push_contributions_branch_fkey"[^;]+;/;
const COVERAGE_INDEX_RE =
  /CREATE INDEX CONCURRENTLY "branch_detail_push_coverage_round_robin_idx"[^;]+;/;
const PUSH_HISTORY_INDEX_RE =
  /CREATE INDEX CONCURRENTLY "branch_push_contributions_current_ref_history_idx"[^;]+;/;

describe("ISS-10992 push contribution migration", () => {
  it("bounds current-ref push reads through an ordered covering scope", async () => {
    const sql = await readFile(
      path.join(
        path.dirname(MIGRATION_PATH),
        "..",
        "20261002145523_iss10992_push_history_index",
        "migration.sql"
      ),
      "utf8"
    );
    expect(PUSH_HISTORY_INDEX_RE.exec(sql)?.[0]).toBe(
      'CREATE INDEX CONCURRENTLY "branch_push_contributions_current_ref_history_idx" ON "branch_push_contributions"("organization_id", "branch_artifact_id", "repository_full_name", "ref_name", "observed_at", "id");'
    );
  });
  it("pins the round-robin coverage index and its ordered retry keys", async () => {
    const sql = await readFile(
      path.join(
        path.dirname(MIGRATION_PATH),
        "..",
        "20261002145523_iss10992_push_history_index",
        "migration.sql"
      ),
      "utf8"
    );
    expect(COVERAGE_INDEX_RE.exec(sql)?.[0]).toBe(
      'CREATE INDEX CONCURRENTLY "branch_detail_push_coverage_round_robin_idx" ON "branch_detail"("push_coverage_last_attempt_at", "artifact_id");'
    );
  });
  it("stores exact Branch/ref/SHA and GitHub account evidence", async () => {
    const sql = await readFile(MIGRATION_PATH, "utf8");
    const table = CREATE_TABLE_RE.exec(sql)?.[0];

    expect(table).toContain('"organization_id" UUID NOT NULL');
    expect(table).toContain('"branch_artifact_id" UUID NOT NULL');
    expect(table).toContain('"repository_full_name" TEXT NOT NULL');
    expect(table).toContain('"ref_name" TEXT NOT NULL');
    expect(table).toContain('"before_sha" VARCHAR(64) NOT NULL');
    expect(table).toContain('"after_sha" VARCHAR(64) NOT NULL');
    expect(table).toContain('"provider_user_id" TEXT NOT NULL');
    expect(table).toContain('"actor_type" VARCHAR(32) NOT NULL');
  });

  it("deduplicates one provider event and binds it to the same-organization Branch", async () => {
    const sql = await readFile(MIGRATION_PATH, "utf8");
    const table = CREATE_TABLE_RE.exec(sql)?.[0] ?? "";
    const index = DEDUPE_CONSTRAINT_RE.exec(table)?.[0];
    const foreignKey = ADD_FOREIGN_KEY_RE.exec(sql)?.[0];

    expect(index).toContain(
      '("organization_id", "branch_artifact_id", "source", "source_event_id")'
    );
    expect(foreignKey).toContain(
      'FOREIGN KEY ("organization_id", "branch_artifact_id") REFERENCES "branch_detail"("organization_id", "artifact_id")'
    );
    expect(foreignKey).toContain("ON DELETE CASCADE");
  });
});
