import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readModelBlock } from "./comment-schema-test-utils";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const migrationsDir = path.join(
  repoRoot,
  "packages/database/prisma/migrations"
);
const schemaPath = path.join(
  repoRoot,
  "packages/database/prisma/schema.prisma"
);
const finalDropMigrationName = "20260523213000_drop_github_pr_review_comments";
const legacyReviewCommentsCreationMigrationName =
  "20260216200744_add_pr_review_tracking";
const githubIdsStringMigrationName =
  "20260326234035_complete_github_ids_to_string";
const MIGRATION_DIRECTORY_REGEX = /^\d{14}_/;
const BLANKET_THREAD_KIND_DEFAULT_REGEX =
  /UPDATE\s+"github_comment_thread_projections"\s+SET\s+"thread_kind"\s*=\s*'REVIEW_THREAD'\s+WHERE\s+"thread_kind"\s+IS\s+NULL/i;
const LEGACY_DERIVED_THREAD_KIND_REGEX =
  /UPDATE\s+"github_comment_thread_projections"\s+projection\s+SET\s+"thread_kind"\s*=\s*\(\s*CASE[\s\S]+FROM\s+"github_pr_review_comments"\s+legacy/i;
const THREAD_KIND_SCHEMA_FIELD_REGEX =
  /\bthreadKind\s+GitHubCommentThreadKind\s+@map\("thread_kind"\)/;

describe("comment table final drop migration", () => {
  it("drops only the legacy review-comment table/type after verifying source-kind unified data", () => {
    const sql = readFinalDropMigrationSql();
    const schema = readFileSync(schemaPath, "utf8");

    expect(sql).toContain('DROP TABLE IF EXISTS "github_pr_review_comments"');
    expect(sql).toContain('DROP TYPE IF EXISTS "PRReviewCommentState"');
    expect(sql).toContain(
      "'github:' || thread_projection.\"thread_kind\"::text || ':comment:'"
    );
    expect(sql).toContain("missing_unified_count");
    expect(sql).toContain("without unified comment projections");
    expect(sql).toContain("with NULL thread_kind");
    expect(sql).toContain("RAISE EXCEPTION");
    expect(sql).not.toMatch(BLANKET_THREAD_KIND_DEFAULT_REGEX);
    expect(sql).toMatch(LEGACY_DERIVED_THREAD_KIND_REGEX);
    expect(sql).not.toContain('AND thread_projection."deleted_at" IS NULL');
    expect(sql).not.toContain(
      'AND comment_projection."github_deleted_at" IS NULL'
    );
    expect(sql).toContain("ISSUE_COMMENT");
    expect(sql).toContain('"github_comment_thread_projections"');
    expect(sql).toContain('"github_comment_projections"');
    expect(sql).toContain("github_pr_reviews");
    expect(sql).toContain('ALTER COLUMN "thread_kind" SET NOT NULL');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "github_comment_thread_projections_pr_root_comment_unique" ON "github_comment_thread_projections"("pull_request_detail_id", "thread_kind", "root_comment_id")'
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "github_comment_thread_projections_pr_review_thread_unique" ON "github_comment_thread_projections"("pull_request_detail_id", "thread_kind", "review_thread_id")'
    );
    expect(readModelBlock(schema, "GitHubCommentThreadProjection")).toMatch(
      THREAD_KIND_SCHEMA_FIELD_REGEX
    );
    expect(schema).not.toContain("model GitHubPRReviewComment");
    expect(schema).not.toContain('@@map("github_pr_review_comments")');
    expect(schema).not.toContain("enum PRReviewCommentState");
    expect(readModelBlock(schema, "GitHubPRReview")).toContain(
      '@@map("github_pr_reviews")'
    );
    expect(readModelBlock(schema, "GitHubCommentProjection")).toContain(
      '@@map("github_comment_projections")'
    );
  });

  it("runs after the additive convergence and identity migrations", () => {
    const migrationNames = readdirSync(migrationsDir).filter((entry) =>
      MIGRATION_DIRECTORY_REGEX.test(entry)
    );

    expect(
      finalDropMigrationName.localeCompare(
        "20260519140000_comment_table_split_1_shared_contracts"
      )
    ).toBeGreaterThan(0);
    expect(
      finalDropMigrationName.localeCompare(
        "20260520064305_add_github_comment_identity"
      )
    ).toBeGreaterThan(0);
    expect(migrationNames).toContain(finalDropMigrationName);
  });

  it("keeps legacy review-comment GitHub provider ids non-null before final drop", () => {
    const creationSql = readMigrationSql(
      legacyReviewCommentsCreationMigrationName
    );
    const stringMigrationSql = readMigrationSql(githubIdsStringMigrationName);

    expect(creationSql).toContain('"github_comment_id" BIGINT NOT NULL');
    expect(stringMigrationSql).toContain(
      'ALTER TABLE "github_pr_review_comments" ALTER COLUMN "github_comment_id" SET DATA TYPE TEXT'
    );
    expect(stringMigrationSql).not.toContain(
      'ALTER COLUMN "github_comment_id" DROP NOT NULL'
    );
  });
});

function readFinalDropMigrationSql(): string {
  return readMigrationSql(finalDropMigrationName);
}

function readMigrationSql(migrationName: string): string {
  return readFileSync(
    path.join(migrationsDir, migrationName, "migration.sql"),
    "utf8"
  );
}
