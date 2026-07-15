import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CHECK_RUN_RETRY_MIGRATION_PATH = join(
  process.cwd(),
  "prisma/migrations/20260703010000_add_check_run_retry_metadata/migration.sql"
);

const CHECK_RUN_RETRY_UNIQUE_INDEX_PATTERN =
  /CREATE UNIQUE INDEX "branch_detail_check_run_retry_resource_key_idx"[\s\S]*?;/;
const CHECK_RUN_RETRY_ATTEMPTS_CONSTRAINT_PATTERN =
  /ADD CONSTRAINT "branch_detail_check_run_retry_attempts_nonnegative"[\s\S]*?;/;
const CHECK_RUN_RETRY_STATE_CONSTRAINT_PATTERN =
  /ADD CONSTRAINT "branch_detail_check_run_retry_state_valid"[\s\S]*?;/;
const CHECK_RUN_RETRY_IDENTITY_CONSTRAINT_PATTERN =
  /ADD CONSTRAINT "branch_detail_check_run_retry_identity_present"[\s\S]*?;/;
const CHECK_RUN_RETRY_DUE_INDEX_PATTERN =
  /CREATE INDEX "branch_detail_check_run_retry_due_idx"[\s\S]*?;/;
const CHECK_RUN_RETRY_REPO_HEAD_INDEX_PATTERN =
  /CREATE INDEX "branch_detail_check_run_retry_repo_head_idx"[\s\S]*?;/;

describe("check_run retry migration", () => {
  it("defines retry CHECK constraints against the specific statements", () => {
    const sql = readFileSync(CHECK_RUN_RETRY_MIGRATION_PATH, "utf8");
    const attempts = sql.match(
      CHECK_RUN_RETRY_ATTEMPTS_CONSTRAINT_PATTERN
    )?.[0];
    const state = sql.match(CHECK_RUN_RETRY_STATE_CONSTRAINT_PATTERN)?.[0];
    const identity = sql.match(
      CHECK_RUN_RETRY_IDENTITY_CONSTRAINT_PATTERN
    )?.[0];

    expect(attempts).toContain('"check_run_retry_attempts" >= 0');
    expect(state).toContain("'pending'");
    expect(state).toContain("'claimed'");
    expect(state).toContain("'dead_letter'");
    expect(identity).toContain('"check_run_retry_state" IS NULL');
    expect(identity).toContain('"check_run_retry_head_sha" IS NOT NULL');
    expect(identity).toContain('"check_run_retry_resource_id" IS NOT NULL');
    expect(identity).toContain('"check_run_retry_idempotency_key" IS NOT NULL');
  });

  it("defines retry indexes against the specific statements", () => {
    const sql = readFileSync(CHECK_RUN_RETRY_MIGRATION_PATH, "utf8");
    const dueIndex = sql.match(CHECK_RUN_RETRY_DUE_INDEX_PATTERN)?.[0];
    const repoHeadIndex = sql.match(
      CHECK_RUN_RETRY_REPO_HEAD_INDEX_PATTERN
    )?.[0];
    const uniqueIndex = sql.match(CHECK_RUN_RETRY_UNIQUE_INDEX_PATTERN)?.[0];

    expect(dueIndex).toContain(
      'ON "branch_detail"("check_run_retry_state", "check_run_retry_next_at")'
    );
    expect(repoHeadIndex).toContain(
      'ON "branch_detail"("repository_id", "check_run_retry_head_sha")'
    );
    expect(uniqueIndex).toContain('"artifact_id"');
    expect(uniqueIndex).toContain('"repository_id"');
    expect(uniqueIndex).toContain('"check_run_retry_head_sha"');
    expect(uniqueIndex).toContain('"check_run_retry_resource_id"');
    expect(uniqueIndex).toContain('"check_run_retry_idempotency_key"');
    expect(uniqueIndex).toContain('"check_run_retry_state" IS NOT NULL');
    expect(uniqueIndex).toContain('"check_run_retry_head_sha" IS NOT NULL');
    expect(uniqueIndex).toContain('"check_run_retry_resource_id" IS NOT NULL');
    expect(uniqueIndex).toContain(
      '"check_run_retry_idempotency_key" IS NOT NULL'
    );
  });
});
