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
const commentTypesPath = path.join(
  repoRoot,
  "packages/api/src/types/comment.ts"
);
const pullRequestDetailDropIndexMigrationName =
  "20260519132500_drop_pull_request_detail_id_key";
const targetMigrationNamePattern = /comment_table_split_1_shared_contracts$/;
const destructiveLegacyTablePatterns = [
  /DROP\s+TABLE\s+"github_pr_review_comments"/i,
  /DROP\s+COLUMN/i,
  /DELETE\s+FROM\s+"github_pr_review_comments"/i,
  /ALTER\s+TABLE\s+"github_pr_review_comments"\s+DROP/i,
] as const;
const requiredSchemaLiterals = [
  "ThreadSource",
  "GITHUB",
  "GitHubCommentThreadKind",
  "GitHubDiffSide",
  "GitHubLegacyCommentState",
  "github_comment_thread_projections",
  "github_comment_projections",
  "branch_artifact_id",
  "pull_request_detail_id",
  "root_comment_id",
  "review_thread_id",
  "github_comment_id",
  "github_deleted_at",
  "last_synced_at",
] as const;
const requiredPartialUniqueIndexes = [
  {
    indexName: "github_comment_thread_projections_pr_root_comment_unique",
    whereClauses: ['"root_comment_id" IS NOT NULL', '"deleted_at" IS NULL'],
  },
  {
    indexName: "github_comment_thread_projections_pr_review_thread_unique",
    whereClauses: ['"review_thread_id" IS NOT NULL', '"deleted_at" IS NULL'],
  },
  {
    indexName: "github_comment_projections_thread_github_comment_unique",
    whereClauses: [
      '"github_comment_id" IS NOT NULL',
      '"github_deleted_at" IS NULL',
    ],
  },
] as const;
const genericCommentTypeForbiddenPattern = /github|projection/i;
const commentThreadsGithubColumnAddPattern =
  /ALTER\s+TABLE\s+"comment_threads"\s+ADD\s+COLUMN\s+[^;]*"github_/i;
const commentsGithubColumnAddPattern =
  /ALTER\s+TABLE\s+"comments"\s+ADD\s+COLUMN\s+[^;]*"github_/i;

describe("comment table convergence migration SQL", () => {
  it("is additive, retains legacy GitHub PR comments, and adds scoped partial uniqueness", () => {
    const sql = readTargetMigrationSql();
    const schema = readFileSync(schemaPath, "utf8");
    const commentTypes = readFileSync(commentTypesPath, "utf8");

    for (const pattern of destructiveLegacyTablePatterns) {
      expect(sql).not.toMatch(pattern);
    }
    for (const literal of requiredSchemaLiterals) {
      expect(sql).toContain(literal);
    }
    for (const { indexName, whereClauses } of requiredPartialUniqueIndexes) {
      const indexStatement = readCreateUniqueIndexStatement(sql, indexName);

      expect(indexStatement).toContain(`CREATE UNIQUE INDEX "${indexName}"`);
      expect(indexStatement).toContain("WHERE");
      for (const whereClause of whereClauses) {
        expect(indexStatement).toContain(whereClause);
      }
    }
    expect(sql).toContain('"github_pr_review_comments"');
    expect(sql).toContain("Preflight");
    expect(sql).toContain("Prisma cannot express the active-row predicates");
    const parentThreadFunction = readCreateFunctionStatement(
      sql,
      "ensure_comments_parent_same_thread"
    );
    expect(parentThreadFunction).toContain("FOR SHARE");
    expect(parentThreadFunction).toContain(
      "comments with replies cannot move to a different thread"
    );
    expect(
      readCreateTriggerStatement(sql, "comments_parent_same_thread_check")
    ).toContain('ON "comments"');
    expect(
      readAddForeignKeyStatement(
        sql,
        "github_comment_thread_projections_thread_branch_fkey"
      )
    ).toContain(
      'FOREIGN KEY ("thread_id", "branch_artifact_id") REFERENCES "comment_threads"("id", "artifact_id")'
    );
    expect(
      readAddForeignKeyStatement(
        sql,
        "github_comment_thread_projections_branch_detail_fkey"
      )
    ).toContain(
      'FOREIGN KEY ("branch_artifact_id") REFERENCES "branch_detail"("artifact_id")'
    );
    expect(
      readAddForeignKeyStatement(
        sql,
        "github_comment_thread_projections_pr_branch_fkey"
      )
    ).toContain(
      'FOREIGN KEY ("pull_request_detail_id", "branch_artifact_id") REFERENCES "pull_request_detail"("id", "branch_artifact_id")'
    );
    const projectionOwnerFunction = readCreateFunctionStatement(
      sql,
      "ensure_github_comment_thread_projection_owner"
    );
    expect(projectionOwnerFunction).toContain("thread.\"source\" = 'GITHUB'");
    expect(projectionOwnerFunction).toContain("artifact.\"type\" = 'BRANCH'");
    expect(projectionOwnerFunction).toContain(
      'artifact."organization_id" = thread."organization_id"'
    );
    expect(projectionOwnerFunction).toContain(
      'pr."branch_artifact_id" = NEW."branch_artifact_id"'
    );
    expect(
      readCreateTriggerStatement(
        sql,
        "github_comment_thread_projection_owner_check"
      )
    ).toContain('ON "github_comment_thread_projections"');
    const threadDriftFunction = readCreateFunctionStatement(
      sql,
      "prevent_github_comment_thread_projection_thread_drift"
    );
    expect(threadDriftFunction).toContain('projection."thread_id" = OLD."id"');
    expect(threadDriftFunction).toContain('projection."deleted_at" IS NULL');
    expect(threadDriftFunction).toContain(
      'NEW."source" IS DISTINCT FROM OLD."source"'
    );
    expect(threadDriftFunction).toContain(
      'NEW."organization_id" IS DISTINCT FROM OLD."organization_id"'
    );
    expect(threadDriftFunction).toContain(
      'NEW."artifact_id" IS DISTINCT FROM OLD."artifact_id"'
    );
    expect(
      readCreateTriggerStatement(
        sql,
        "comment_threads_github_projection_owner_drift_check"
      )
    ).toContain('ON "comment_threads"');
    const artifactDriftFunction = readCreateFunctionStatement(
      sql,
      "prevent_github_comment_thread_projection_artifact_drift"
    );
    expect(artifactDriftFunction).toContain(
      'projection."branch_artifact_id" = OLD."id"'
    );
    expect(artifactDriftFunction).toContain('projection."deleted_at" IS NULL');
    expect(artifactDriftFunction).toContain(
      'NEW."type" IS DISTINCT FROM OLD."type"'
    );
    expect(artifactDriftFunction).toContain(
      'NEW."organization_id" IS DISTINCT FROM OLD."organization_id"'
    );
    expect(
      readCreateTriggerStatement(
        sql,
        "artifacts_github_projection_owner_drift_check"
      )
    ).toContain('ON "artifacts"');
    const projectionCleanupFunction = readCreateFunctionStatement(
      sql,
      "delete_github_comment_thread_projection_base_row"
    );
    expect(projectionCleanupFunction).toContain(
      'DELETE FROM "comment_threads"'
    );
    expect(projectionCleanupFunction).toContain('"id" = OLD."thread_id"');
    expect(projectionCleanupFunction).toContain("\"source\" = 'GITHUB'");
    expect(
      readCreateTriggerStatement(
        sql,
        "github_comment_thread_projection_base_row_cleanup"
      )
    ).toContain('ON "github_comment_thread_projections"');
    expect(readModelBlock(schema, "GitHubCommentThreadProjection")).toContain(
      "@relation(fields: [threadId, branchArtifactId], references: [id, artifactId], onDelete: Cascade)"
    );
    expect(readModelBlock(schema, "GitHubCommentThreadProjection")).toContain(
      "@relation(fields: [branchArtifactId], references: [artifactId], onDelete: Cascade)"
    );
    expect(readModelBlock(schema, "GitHubCommentThreadProjection")).toContain(
      "@relation(fields: [pullRequestDetailId, branchArtifactId], references: [id, branchArtifactId], onDelete: Cascade)"
    );
    expect(readModelBlock(schema, "BranchDetail")).toContain(
      "githubCommentProjections GitHubCommentThreadProjection[]"
    );
    expect(readExportedTypeBlock(commentTypes, "CommentThread")).not.toMatch(
      genericCommentTypeForbiddenPattern
    );
    expect(readExportedTypeBlock(commentTypes, "Comment")).not.toMatch(
      genericCommentTypeForbiddenPattern
    );
    expect(sql).not.toMatch(commentThreadsGithubColumnAddPattern);
    expect(sql).not.toMatch(commentsGithubColumnAddPattern);
    expect(readModelBlock(schema, "CommentThread")).not.toContain(
      '@map("github_'
    );
    expect(readModelBlock(schema, "Comment")).not.toContain('@map("github_');
  });

  it("runs after the migration that removes the redundant pull request detail id index", () => {
    const migrationName = readTargetMigrationName();

    expect(
      migrationName.localeCompare(pullRequestDetailDropIndexMigrationName)
    ).toBeGreaterThan(0);
  });
});

function readTargetMigrationSql(): string {
  return readFileSync(
    path.join(migrationsDir, readTargetMigrationName(), "migration.sql"),
    "utf8"
  );
}

function readTargetMigrationName(): string {
  const migrationName = readdirSync(migrationsDir).find((entry) =>
    targetMigrationNamePattern.test(entry)
  );
  if (!migrationName) {
    throw new Error("comment_table_split_1_shared_contracts migration missing");
  }

  return migrationName;
}

/**
 * Isolate one DDL statement so assertions prove each partial index carries its
 * own predicate instead of passing because another statement contains it.
 */
function readCreateUniqueIndexStatement(
  sql: string,
  indexName: string
): string {
  const statementStart = sql.indexOf(`CREATE UNIQUE INDEX "${indexName}"`);
  const statementEnd = sql.indexOf(";", statementStart);

  if (statementStart === -1 || statementEnd === -1) {
    throw new Error(`CREATE UNIQUE INDEX statement missing for ${indexName}`);
  }

  return sql.slice(statementStart, statementEnd + 1);
}

function readAddForeignKeyStatement(
  sql: string,
  constraintName: string
): string {
  const statementStart = sql.indexOf(`CONSTRAINT "${constraintName}"`);
  if (statementStart === -1) {
    throw new Error(`FOREIGN KEY constraint missing for ${constraintName}`);
  }

  const alterTableStart = sql.lastIndexOf("ALTER TABLE", statementStart);
  const statementEnd = sql.indexOf(";", statementStart);
  if (alterTableStart === -1 || statementEnd === -1) {
    throw new Error(`FOREIGN KEY statement malformed for ${constraintName}`);
  }

  return sql.slice(alterTableStart, statementEnd + 1);
}

function readCreateFunctionStatement(
  sql: string,
  functionName: string
): string {
  const statementStart = sql.indexOf(`CREATE FUNCTION "${functionName}"()`);
  const languageClause = "$$ LANGUAGE plpgsql;";
  const statementEnd = sql.indexOf(languageClause, statementStart);

  if (statementStart === -1 || statementEnd === -1) {
    throw new Error(`CREATE FUNCTION statement missing for ${functionName}`);
  }

  return sql.slice(statementStart, statementEnd + languageClause.length);
}

function readCreateTriggerStatement(sql: string, triggerName: string): string {
  const statementStart = sql.indexOf(`CREATE TRIGGER "${triggerName}"`);
  const statementEnd = sql.indexOf(";", statementStart);

  if (statementStart === -1 || statementEnd === -1) {
    throw new Error(`CREATE TRIGGER statement missing for ${triggerName}`);
  }

  return sql.slice(statementStart, statementEnd + 1);
}

function readExportedTypeBlock(source: string, typeName: string): string {
  const typeStart = source.indexOf(`export type ${typeName} = {`);
  const typeEnd = source.indexOf("\n};", typeStart);

  if (typeStart === -1 || typeEnd === -1) {
    throw new Error(`exported type block missing for ${typeName}`);
  }

  return source.slice(typeStart, typeEnd + 3);
}
