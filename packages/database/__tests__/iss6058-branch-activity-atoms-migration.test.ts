import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS } from "../scripts/preview-heavy-migrations";
import { parsePlainIndexBuilds } from "../scripts/preview-plain-index";

const MIGRATION_NAME = "20260812160000_iss6058_branch_activity_atoms";
const FK_INDEX_MIGRATION_NAME =
  "20260812150000_iss6058_branch_activity_fk_indexes";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(
  TEST_DIR,
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);
const FK_INDEX_MIGRATION_PATH = path.join(
  TEST_DIR,
  "..",
  "prisma",
  "migrations",
  FK_INDEX_MIGRATION_NAME,
  "migration.sql"
);
const CREATE_TABLE_RE = /CREATE TABLE "branch_activity_atoms" \(([\s\S]*?)\);/;
const BACKFILL_RE =
  /INSERT INTO "branch_activity_atoms" \([\s\S]*?ON CONFLICT \("organization_id", "branch_artifact_id", "source", "source_event_id"\) DO NOTHING;/g;
const DESTRUCTIVE_RE = /^\s*(?:DELETE|DROP|TRUNCATE|UPDATE)\b/im;
const CONCURRENT_IF_NOT_EXISTS_RE =
  /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS/;
const FORBIDDEN_BACKFILL_COLUMNS = [
  '"last_activity_at"',
  '"github_updated_at"',
  '"updated_at"',
  '"created_at"',
  '"last_sync_completed_at"',
  '"last_sync_started_at"',
] as const;

describe(`${MIGRATION_NAME} migration contract`, () => {
  it("creates the exact immutable organization-scoped atom constraints", async () => {
    const sql = await migrationSql();
    const table = CREATE_TABLE_RE.exec(sql)?.[0];

    expect(table).toBeDefined();
    expect(table).toContain('"version" INTEGER NOT NULL');
    expect(table).toContain('"organization_id" UUID NOT NULL');
    expect(table).toContain('"branch_artifact_id" UUID NOT NULL');
    expect(table).toContain('"source" VARCHAR(128) NOT NULL');
    expect(table).toContain('"source_event_id" VARCHAR(512) NOT NULL');
    expect(table).toContain('"occurred_at" TIMESTAMP(3) NOT NULL');
    expect(table).toContain('"pull_request_detail_id" UUID');
    expect(table).toContain(
      'CONSTRAINT "branch_activity_atoms_dedupe_key" UNIQUE ("organization_id", "branch_artifact_id", "source", "source_event_id")'
    );
    expect(table).toContain(
      'CONSTRAINT "branch_activity_atoms_version_check" CHECK ("version" >= 1)'
    );
    expect(table).toContain(
      'CHECK ("source" = btrim("source") AND length("source") > 0)'
    );
    expect(table).toContain(
      'CHECK ("source_event_id" = btrim("source_event_id") AND length("source_event_id") > 0)'
    );
    expect(table).toContain(
      "CHECK (\"completeness\" IN ('complete', 'partial'))"
    );
    expect(table).toContain(
      '("attribution_kind" = \'branch\' AND "pull_request_detail_id" IS NULL)'
    );
    expect(table).toContain(
      '("attribution_kind" = \'pull_request\' AND "pull_request_detail_id" IS NOT NULL)'
    );
  });

  it("binds atom ownership to the organization, Branch, and associated PR", async () => {
    const [sql, fkIndexSql] = await Promise.all([
      migrationSql(),
      fkIndexMigrationSql(),
    ]);

    expect(fkIndexSql).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY "branch_detail_org_artifact_key"\nON "branch_detail"("organization_id", "artifact_id");'
    );
    expect(fkIndexSql).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY "pull_request_detail_org_id_key"\nON "pull_request_detail"("organization_id", "id");'
    );
    expect(fkIndexSql).not.toMatch(CONCURRENT_IF_NOT_EXISTS_RE);
    expect(PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS).toContain(
      FK_INDEX_MIGRATION_NAME
    );
    const previewBuilds = parsePlainIndexBuilds(fkIndexSql);
    expect(previewBuilds.map((build) => build.name)).toEqual([
      "branch_detail_org_artifact_key",
      "pull_request_detail_org_id_key",
    ]);
    expect(previewBuilds.every((build) => build.unique)).toBe(true);
    expect(
      previewBuilds.every((build) => build.sql.includes("IF NOT EXISTS"))
    ).toBe(true);
    expect(sql).toContain(
      'ALTER TABLE "branch_activity_atoms" ADD CONSTRAINT "branch_activity_atoms_organization_fkey"\nFOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;'
    );
    expect(sql).toContain(
      'FOREIGN KEY ("organization_id", "branch_artifact_id")\nREFERENCES "branch_detail"("organization_id", "artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;'
    );
    expect(sql).toContain(
      'FOREIGN KEY ("organization_id", "pull_request_detail_id")\nREFERENCES "pull_request_detail"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;'
    );
  });

  it("creates only the access-path-backed latest-evidence index", async () => {
    const sql = await migrationSql();
    const atomIndexes = sql.match(
      /CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "[^"]+"\s+ON "branch_activity_atoms"\([^;]+;/g
    );

    expect(atomIndexes).toEqual([
      'CREATE INDEX IF NOT EXISTS "branch_activity_atoms_latest_idx"\nON "branch_activity_atoms"("organization_id", "branch_artifact_id", "occurred_at" DESC, "source", "source_event_id");',
    ]);
  });

  it("backfills only current-head, PR lifecycle, and PR review authority", async () => {
    const sql = await migrationSql();
    const backfills = sql.match(BACKFILL_RE) ?? [];

    expect(backfills).toHaveLength(3);
    expect(backfills[0]).toContain("'git_head'");
    expect(backfills[0]).toContain('branch."head_sha"');
    expect(backfills[0]).toContain('branch."head_sha_observed_at"');
    expect(backfills[0]).toContain(
      "branch.\"head_sha_source\" = 'push_webhook'"
    );
    expect(backfills[0]).toContain(
      'length(branch."head_sha") BETWEEN 1 AND 512'
    );
    expect(backfills[1]).toContain("'pull_request_lifecycle'");
    expect(backfills[1]).toContain(
      'branch."organization_id" = pr."organization_id"'
    );
    expect(backfills[1]).toContain('pr."github_created_at"');
    expect(backfills[1]).toContain('pr."merged_at"');
    expect(backfills[1]).toContain('pr."closed_at"');
    expect(backfills[2]).toContain("'pull_request_review'");
    expect(backfills[2]).toContain('review."github_review_id"');
    expect(backfills[2]).toContain('review."submitted_at"');
    expect(backfills[2]).toContain(
      'length(review."github_review_id") BETWEEN 1 AND 512'
    );
    expect(backfills[2]).toContain(
      'branch."organization_id" = pr."organization_id"'
    );
    for (const backfill of backfills) {
      for (const forbidden of FORBIDDEN_BACKFILL_COLUMNS) {
        expect(backfill).not.toContain(forbidden);
      }
    }
  });

  it("keeps rollback compatibility and avoids destructive mutation", async () => {
    const sql = await migrationSql();

    expect(sql).not.toMatch(DESTRUCTIVE_RE);
    expect(sql).not.toContain(
      'ALTER TABLE "branch_detail" ALTER COLUMN "last_activity_at"'
    );
    expect(sql).not.toContain(
      'ALTER TABLE "branch_detail" DROP COLUMN "last_activity_at"'
    );
  });
});

function migrationSql(): Promise<string> {
  return readFile(MIGRATION_PATH, "utf8");
}

function fkIndexMigrationSql(): Promise<string> {
  return readFile(FK_INDEX_MIGRATION_PATH, "utf8");
}
