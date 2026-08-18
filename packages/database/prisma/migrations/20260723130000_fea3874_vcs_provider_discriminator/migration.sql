-- FEA-3874 (parent FEA-3801, PLN-1457 Slice 2): git-provider neutrality — add a
-- `provider` discriminator + typed `provider_detail` JSON to the VCS-derived
-- records (change requests, deployments, comment authors, installations).
--
-- ADDITIVE + DUAL-READ ONLY. No existing GitHub-specific column is changed or
-- dropped; GitHub's read/write lifecycle is byte-unchanged by this migration.
-- The NOT NULL `provider` columns carry DEFAULT 'github', so Postgres backfills
-- every pre-existing row to 'github' during ADD COLUMN (all current rows are
-- GitHub-produced). The explicit UPDATEs below are belt-and-suspenders: they are
-- no-ops on a fresh apply but make the 'github' backfill intent unambiguous and
-- keep this migration correct if replayed against a table where the column was
-- added without the default. `external_comment_authors` already carries a
-- `provider` discriminator (the ExternalCommentProvider enum), so it gains only
-- the neutral `provider_detail` JSON here.
--
-- Generated additively via `prisma migrate diff` (schema HEAD -> edited schema);
-- the backfill UPDATEs are the only hand-added SQL.

-- AlterTable
ALTER TABLE "pull_request_detail" ADD COLUMN     "provider" VARCHAR(32) NOT NULL DEFAULT 'github',
ADD COLUMN     "provider_detail" JSONB;

-- AlterTable
ALTER TABLE "deployment_detail" ADD COLUMN     "provider" VARCHAR(32) NOT NULL DEFAULT 'github',
ADD COLUMN     "provider_detail" JSONB;

-- AlterTable
ALTER TABLE "external_comment_authors" ADD COLUMN     "provider_detail" JSONB;

-- AlterTable
ALTER TABLE "github_installations" ADD COLUMN     "provider" VARCHAR(32) NOT NULL DEFAULT 'github',
ADD COLUMN     "provider_detail" JSONB;

-- Backfill existing rows to the GitHub provider (idempotent; no-op after the
-- DEFAULT-backed ADD COLUMN above).
UPDATE "pull_request_detail" SET "provider" = 'github' WHERE "provider" IS NULL;
UPDATE "deployment_detail" SET "provider" = 'github' WHERE "provider" IS NULL;
UPDATE "github_installations" SET "provider" = 'github' WHERE "provider" IS NULL;
