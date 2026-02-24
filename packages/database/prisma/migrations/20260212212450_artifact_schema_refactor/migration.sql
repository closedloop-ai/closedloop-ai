/*
  Warnings:

  - The values [DOCUMENT,WORKFLOW,BRANCH] on the enum `ArtifactType` will be removed. If these variants are still used in the database, this will fail.
  - The values [REMOVED] on the enum `GitHubInstallationStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `content` on the `artifacts` table. All the data in the column will be lost.
  - You are about to drop the column `document_slug` on the `artifacts` table. All the data in the column will be lost.
  - You are about to drop the column `external_url` on the `artifacts` table. All the data in the column will be lost.
  - You are about to drop the column `is_latest` on the `artifacts` table. All the data in the column will be lost.
  - You are about to drop the column `parent_id` on the `artifacts` table. All the data in the column will be lost.
  - You are about to drop the column `subtype` on the `artifacts` table. All the data in the column will be lost.
  - You are about to drop the column `template_for_subtype` on the `artifacts` table. All the data in the column will be lost.
  - You are about to drop the column `version` on the `artifacts` table. All the data in the column will be lost.
  - You are about to drop the `approvals` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `file_uploads` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `preview_deployments` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[slug]` on the table `artifacts` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[organization_id,template_for_type]` on the table `artifacts` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `slug` to the `artifacts` table without a default value. This is not possible if the table is not empty.
*/
-- NOTE: Do NOT wrap in BEGIN/COMMIT — Prisma migrate deploy manages transactions.

-- ============================================================================
-- PHASE 1: Create new enums and tables (DDL that data migration depends on)
-- ============================================================================

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'IN_REVIEW', 'CLOSED');

-- CreateEnum
CREATE TYPE "IssuePriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ExternalLinkType" AS ENUM ('PULL_REQUEST', 'FIGMA_DESIGN', 'PREVIEW_DEPLOYMENT');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('ARTIFACT', 'ISSUE', 'EXTERNAL_LINK');

-- CreateEnum
CREATE TYPE "LinkType" AS ENUM ('PRODUCES', 'BLOCKS', 'RELATES_TO');

-- NOTE: ArtifactType enum swap is DEFERRED to Phase 3 (after data migration).
-- Existing rows have type values DOCUMENT/WORKFLOW/BRANCH which don't exist in the
-- new enum (PRD/IMPLEMENTATION_PLAN/TEMPLATE). We must migrate/delete those rows first.

-- AlterEnum (GitHubInstallationStatus — independent, safe to do now)
-- First, migrate any REMOVED rows to UNINSTALLED before swapping the enum
UPDATE "github_installations" SET "status" = 'UNINSTALLED' WHERE "status" = 'REMOVED';
CREATE TYPE "GitHubInstallationStatus_new" AS ENUM ('PENDING_CLAIM', 'ACTIVE', 'SUSPENDED', 'UNINSTALLED');
ALTER TABLE "github_installations" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "github_installations" ALTER COLUMN "status" TYPE "GitHubInstallationStatus_new" USING ("status"::text::"GitHubInstallationStatus_new");
ALTER TYPE "GitHubInstallationStatus" RENAME TO "GitHubInstallationStatus_old";
ALTER TYPE "GitHubInstallationStatus_new" RENAME TO "GitHubInstallationStatus";
DROP TYPE "GitHubInstallationStatus_old";
ALTER TABLE "github_installations" ALTER COLUMN "status" SET DEFAULT 'PENDING_CLAIM';

-- CreateTable
CREATE TABLE "artifact_versions" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issues" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workstream_id" UUID,
    "project_id" UUID,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" "IssueStatus" NOT NULL DEFAULT 'TODO',
    "priority" "IssuePriority" NOT NULL DEFAULT 'MEDIUM',
    "assignee_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workstream_id" UUID,
    "project_id" UUID,
    "type" "ExternalLinkType" NOT NULL,
    "title" TEXT NOT NULL,
    "external_url" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_links" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "source_type" "EntityType" NOT NULL,
    "source_version" INTEGER,
    "target_id" UUID NOT NULL,
    "target_type" "EntityType" NOT NULL,
    "target_version" INTEGER,
    "link_type" "LinkType" NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_links_pkey" PRIMARY KEY ("id")
);

-- Add new columns to artifacts BEFORE data migration (slug is nullable for now)
ALTER TABLE "artifacts" ADD COLUMN "slug" TEXT;
ALTER TABLE "artifacts" ADD COLUMN "latest_version" INTEGER NOT NULL DEFAULT 1;
-- template_for_type is added as TEXT for now — the old ArtifactType enum doesn't contain
-- the new values (PRD/IMPLEMENTATION_PLAN/TEMPLATE). It will be cast to the new enum in Phase 3.
ALTER TABLE "artifacts" ADD COLUMN "template_for_type" TEXT;

-- ============================================================================
-- PHASE 2: Data migration (reads old columns, writes to new tables)
-- ============================================================================

-- Step 1: Populate slug on artifacts (document types that will survive)

-- 1a. Copy existing document_slug where available
UPDATE "artifacts"
SET "slug" = "document_slug"
WHERE "document_slug" IS NOT NULL;

-- 1b. Generate slugs for document artifacts that lack one
UPDATE "artifacts"
SET "slug" = left(replace(gen_random_uuid()::text, '-', ''), 14)
WHERE "slug" IS NULL
  AND "subtype" NOT IN ('ISSUE', 'BUG', 'PULL_REQUEST', 'FIGMA_DESIGN');

-- 1c. Deduplicate slugs: append random suffix to all but the oldest occurrence
UPDATE "artifacts" a
SET "slug" = a."slug" || '-' || left(replace(gen_random_uuid()::text, '-', ''), 6)
FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "slug" ORDER BY "created_at" ASC) AS rn
    FROM "artifacts"
    WHERE "slug" IS NOT NULL
) dupes
WHERE a."id" = dupes."id"
  AND dupes.rn > 1;

-- Step 2: Populate latest_version on artifacts

-- For versioned documents (sharing a document_slug), set latest_version = MAX(version) in the group
UPDATE "artifacts" a
SET "latest_version" = sub.max_version
FROM (
    SELECT "document_slug", MAX("version") AS max_version
    FROM "artifacts"
    WHERE "document_slug" IS NOT NULL
      AND "subtype" NOT IN ('ISSUE', 'BUG', 'PULL_REQUEST', 'FIGMA_DESIGN')
    GROUP BY "document_slug"
) sub
WHERE a."document_slug" = sub."document_slug"
  AND a."is_latest" = true
  AND a."subtype" NOT IN ('ISSUE', 'BUG', 'PULL_REQUEST', 'FIGMA_DESIGN');

-- Non-versioned documents (no document_slug) keep the DEFAULT 1 — no action needed.

-- Step 2b: Populate template_for_type from template_for_subtype (only valid new enum values)
-- ISSUE and BUG templates are dropped since issues are moving to their own table.
UPDATE "artifacts"
SET "template_for_type" = "template_for_subtype"::text
WHERE "template_for_subtype" IS NOT NULL
  AND "template_for_subtype"::text IN ('PRD', 'IMPLEMENTATION_PLAN', 'TEMPLATE');

-- Step 3: Migrate document content → artifact_versions

-- 3a. Versions for is_latest=true rows (artifact_id = own id)
INSERT INTO "artifact_versions" ("id", "artifact_id", "version", "content", "created_by_id", "created_at")
SELECT
    gen_random_uuid(),
    a."id",
    a."version",
    a."content",
    COALESCE(a."generated_by", a."owner_id"),
    a."created_at"
FROM "artifacts" a
WHERE a."is_latest" = true
  AND a."subtype" NOT IN ('ISSUE', 'BUG', 'PULL_REQUEST', 'FIGMA_DESIGN')
  AND NOT (a."subtype" = 'TEMPLATE' AND a."template_for_subtype"::text IN ('ISSUE', 'BUG'));

-- 3b. Versions for is_latest=false rows (artifact_id points to the latest row in the same document_slug group)
INSERT INTO "artifact_versions" ("id", "artifact_id", "version", "content", "created_by_id", "created_at")
SELECT
    gen_random_uuid(),
    latest."id",
    old."version",
    old."content",
    COALESCE(old."generated_by", old."owner_id"),
    old."created_at"
FROM "artifacts" old
JOIN "artifacts" latest
    ON old."document_slug" = latest."document_slug"
    AND latest."is_latest" = true
WHERE old."is_latest" = false
  AND old."document_slug" IS NOT NULL
  AND old."subtype" NOT IN ('ISSUE', 'BUG', 'PULL_REQUEST', 'FIGMA_DESIGN');

-- Step 4: Migrate ISSUE/BUG artifacts → issues
INSERT INTO "issues" ("id", "organization_id", "workstream_id", "project_id", "title", "slug",
    "description", "status", "priority", "assignee_id", "created_by_id", "created_at", "updated_at")
SELECT
    a."id",
    a."organization_id",
    a."workstream_id",
    a."project_id",
    a."title",
    COALESCE(a."document_slug", left(replace(gen_random_uuid()::text, '-', ''), 14)),
    a."content",
    CASE a."status"
        WHEN 'DRAFT' THEN 'TODO'::"IssueStatus"
        WHEN 'REVIEW' THEN 'IN_REVIEW'::"IssueStatus"
        WHEN 'APPROVED' THEN 'CLOSED'::"IssueStatus"
        WHEN 'ARCHIVED' THEN 'CLOSED'::"IssueStatus"
    END,
    'MEDIUM'::"IssuePriority",
    NULL,
    COALESCE(
        a."generated_by",
        a."owner_id",
        (SELECT u."id" FROM "users" u WHERE u."organization_id" = a."organization_id" ORDER BY u."created_at" ASC LIMIT 1)
    ),
    a."created_at",
    a."updated_at"
FROM "artifacts" a
WHERE a."subtype" IN ('ISSUE', 'BUG')
  AND a."is_latest" = true;

-- Step 5: Migrate PULL_REQUEST/FIGMA_DESIGN artifacts → external_links
INSERT INTO "external_links" ("id", "organization_id", "workstream_id", "project_id", "type",
    "title", "external_url", "metadata", "created_at", "updated_at")
SELECT
    a."id",
    a."organization_id",
    a."workstream_id",
    a."project_id",
    CASE a."subtype"
        WHEN 'PULL_REQUEST' THEN 'PULL_REQUEST'::"ExternalLinkType"
        WHEN 'FIGMA_DESIGN' THEN 'FIGMA_DESIGN'::"ExternalLinkType"
    END,
    a."title",
    COALESCE(a."external_url", ''),
    NULL,
    a."created_at",
    a."updated_at"
FROM "artifacts" a
WHERE a."subtype" IN ('PULL_REQUEST', 'FIGMA_DESIGN')
  AND a."is_latest" = true;

-- Step 6: Migrate preview_deployments → external_links
INSERT INTO "external_links" ("id", "organization_id", "workstream_id", "project_id", "type",
    "title", "external_url", "metadata", "created_at", "updated_at")
SELECT
    pd."id",
    a."organization_id",
    a."workstream_id",
    a."project_id",
    'PREVIEW_DEPLOYMENT'::"ExternalLinkType",
    CONCAT('Preview: ', a."title"),
    COALESCE(pd."url", ''),
    jsonb_build_object(
        'state', pd."state",
        'environment', pd."environment",
        'ref', pd."ref",
        'sha', pd."sha"
    ),
    pd."created_at",
    COALESCE(pd."updated_at", pd."created_at")
FROM "preview_deployments" pd
JOIN "artifacts" a ON pd."artifact_id" = a."id";

-- Step 7: Migrate relationships → entity_links

-- 7a. Artifact parent_id → PRODUCES entity links (parent produced child)
INSERT INTO "entity_links" ("id", "source_id", "source_type", "target_id", "target_type", "link_type", "created_at")
SELECT
    gen_random_uuid(),
    parent."id",
    CASE
        WHEN parent."subtype" IN ('ISSUE', 'BUG') THEN 'ISSUE'::"EntityType"
        WHEN parent."subtype" IN ('PULL_REQUEST', 'FIGMA_DESIGN') THEN 'EXTERNAL_LINK'::"EntityType"
        ELSE 'ARTIFACT'::"EntityType"
    END,
    child."id",
    CASE
        WHEN child."subtype" IN ('ISSUE', 'BUG') THEN 'ISSUE'::"EntityType"
        WHEN child."subtype" IN ('PULL_REQUEST', 'FIGMA_DESIGN') THEN 'EXTERNAL_LINK'::"EntityType"
        ELSE 'ARTIFACT'::"EntityType"
    END,
    'PRODUCES'::"LinkType",
    child."created_at"
FROM "artifacts" child
JOIN "artifacts" parent ON child."parent_id" = parent."id"
WHERE child."parent_id" IS NOT NULL
  AND child."is_latest" = true;

-- 7b. Preview deployment ← parent PR (PR produced Preview)
INSERT INTO "entity_links" ("id", "source_id", "source_type", "target_id", "target_type", "link_type", "created_at")
SELECT
    gen_random_uuid(),
    a."id",
    'EXTERNAL_LINK'::"EntityType",
    pd."id",
    'EXTERNAL_LINK'::"EntityType",
    'PRODUCES'::"LinkType",
    pd."created_at"
FROM "preview_deployments" pd
JOIN "artifacts" a ON pd."artifact_id" = a."id";

-- 7c. Plan → PR links (Implementation Plan produced Pull Request)
-- Captures Plan→PR relationships where the PR artifact doesn't have parent_id set to the plan.
INSERT INTO "entity_links" ("id", "source_id", "source_type", "target_id", "target_type", "link_type", "created_at")
SELECT DISTINCT
    gen_random_uuid(),
    plan_art."id",
    'ARTIFACT'::"EntityType",
    pr_art."id",
    'EXTERNAL_LINK'::"EntityType",
    'PRODUCES'::"LinkType",
    pr_art."created_at"
FROM "artifacts" plan_art
JOIN "artifacts" pr_art
    ON plan_art."workstream_id" = pr_art."workstream_id"
    AND plan_art."organization_id" = pr_art."organization_id"
WHERE plan_art."subtype" = 'IMPLEMENTATION_PLAN'
  AND plan_art."is_latest" = true
  AND pr_art."subtype" = 'PULL_REQUEST'
  AND pr_art."is_latest" = true
  -- Exclude pairs already linked via parent_id in 7a
  AND pr_art."parent_id" IS DISTINCT FROM plan_art."id";

-- Step 8: Clean up references to artifacts being removed

-- 8a. Delete artifact_ratings for artifacts being removed (non-surviving subtypes, non-latest versions, and obsolete templates)
DELETE FROM "artifact_ratings"
WHERE "artifact_id" IN (
    SELECT "id" FROM "artifacts"
    WHERE "subtype" NOT IN ('PRD', 'IMPLEMENTATION_PLAN', 'TEMPLATE')
       OR "is_latest" = false
       OR ("subtype" = 'TEMPLATE' AND "template_for_subtype"::text IN ('ISSUE', 'BUG'))
);

-- 8b. Delete artifact_evaluations for artifacts being removed
DELETE FROM "artifact_evaluations"
WHERE "artifact_id" IN (
    SELECT "id" FROM "artifacts"
    WHERE "subtype" NOT IN ('PRD', 'IMPLEMENTATION_PLAN', 'TEMPLATE')
       OR "is_latest" = false
       OR ("subtype" = 'TEMPLATE' AND "template_for_subtype"::text IN ('ISSUE', 'BUG'))
);

-- 8c. Nullify github_pull_requests references for artifacts being removed
UPDATE "github_pull_requests"
SET "artifact_id" = NULL
WHERE "artifact_id" IN (
    SELECT "id" FROM "artifacts"
    WHERE "subtype" NOT IN ('PRD', 'IMPLEMENTATION_PLAN', 'TEMPLATE')
       OR "is_latest" = false
       OR ("subtype" = 'TEMPLATE' AND "template_for_subtype"::text IN ('ISSUE', 'BUG'))
);

-- Step 9: Delete migrated and non-latest rows from artifacts
-- Order matters: delete non-latest first (they may have parent_id refs to latest rows)
DELETE FROM "artifacts" WHERE "is_latest" = false;
DELETE FROM "artifacts" WHERE "subtype" IN ('ISSUE', 'BUG');
DELETE FROM "artifacts" WHERE "subtype" IN ('PULL_REQUEST', 'FIGMA_DESIGN');
-- Delete unused subtypes that don't map to the new ArtifactType enum
DELETE FROM "artifacts" WHERE "subtype" IN (
    'IMPLEMENTATION_STRATEGY', 'CODE_REVIEW_REPORT', 'VISUAL_QA_REPORT',
    'ACCESSIBILITY_REPORT', 'TEST_REPORT', 'COMPLETION_SUMMARY'
);
-- Delete template artifacts for ISSUE/BUG (no longer relevant after issues moved to own table)
DELETE FROM "artifacts"
WHERE "subtype" = 'TEMPLATE'
  AND "template_for_subtype"::text IN ('ISSUE', 'BUG');

-- ============================================================================
-- PHASE 3: Post-migration DDL (enum swap, column drops, index rebuilds)
-- ============================================================================

-- Make slug NOT NULL now that all surviving rows have it populated
ALTER TABLE "artifacts" ALTER COLUMN "slug" SET NOT NULL;

-- AlterEnum: ArtifactType (DOCUMENT/WORKFLOW/BRANCH → PRD/IMPLEMENTATION_PLAN/TEMPLATE)
-- Step A: Create the new enum type
CREATE TYPE "ArtifactType_new" AS ENUM ('PRD', 'IMPLEMENTATION_PLAN', 'TEMPLATE');

-- Step B: Convert type column to TEXT so we can update values freely
ALTER TABLE "artifacts" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "artifacts" ALTER COLUMN "type" TYPE TEXT USING ("type"::text);

-- Step C: Update the type column on surviving rows from the old category (DOCUMENT/WORKFLOW/BRANCH)
-- to the specific kind (PRD/IMPLEMENTATION_PLAN/TEMPLATE) using the subtype value.
UPDATE "artifacts" SET "type" = "subtype"::text
WHERE "subtype" IN ('PRD', 'IMPLEMENTATION_PLAN', 'TEMPLATE');

-- Step D: Cast type and template_for_type to the new enum, then swap names.
ALTER TABLE "artifacts" ALTER COLUMN "type" TYPE "ArtifactType_new" USING ("type"::"ArtifactType_new");
ALTER TABLE "artifacts" ALTER COLUMN "template_for_type" TYPE "ArtifactType_new" USING ("template_for_type"::text::"ArtifactType_new");
ALTER TYPE "ArtifactType" RENAME TO "ArtifactType_old";
ALTER TYPE "ArtifactType_new" RENAME TO "ArtifactType";
DROP TYPE "ArtifactType_old";

-- DropIndex (old indexes that reference dropped columns)
DROP INDEX "artifact_evaluations_artifact_id_idx";
DROP INDEX "artifact_evaluations_created_at_idx";
DROP INDEX "artifacts_organization_id_parent_id_subtype_is_latest_idx";
DROP INDEX "artifacts_organization_id_project_id_subtype_is_latest_idx";
DROP INDEX "artifacts_organization_id_subtype_template_for_subtype_idx";
DROP INDEX "artifacts_organization_id_template_for_subtype_key";
DROP INDEX "artifacts_organization_id_workstream_id_subtype_is_latest_idx";
DROP INDEX "artifacts_parent_id_idx";
DROP INDEX "github_pull_requests_repository_id_idx";

-- AlterTable: Drop old columns from artifacts
ALTER TABLE "artifacts" DROP COLUMN "content",
DROP COLUMN "document_slug",
DROP COLUMN "external_url",
DROP COLUMN "is_latest",
DROP COLUMN "parent_id",
DROP COLUMN "subtype",
DROP COLUMN "template_for_subtype",
DROP COLUMN "version";

-- DropTable
DROP TABLE "approvals";

-- DropTable
DROP TABLE "file_uploads";

-- DropTable
DROP TABLE "preview_deployments";

-- DropEnum
DROP TYPE "ApprovalStatus";

-- DropEnum
DROP TYPE "ArtifactSubtype";

-- DropEnum
DROP TYPE "FileUploadType";

-- ============================================================================
-- PHASE 4: Create new indexes
-- ============================================================================

-- Deduplicate artifact_versions before creating unique index.
-- Edge case: an is_latest=true artifact at version N and a non-latest artifact
-- in the same document_slug group also at version N both insert into artifact_versions,
-- creating a duplicate (artifact_id, version) pair.
DELETE FROM "artifact_versions" av1
USING "artifact_versions" av2
WHERE av1."artifact_id" = av2."artifact_id"
  AND av1."version" = av2."version"
  AND (av1."created_at" > av2."created_at"
    OR (av1."created_at" = av2."created_at" AND av1."id" > av2."id"));

-- CreateIndex
CREATE UNIQUE INDEX "artifact_versions_artifact_id_version_key" ON "artifact_versions"("artifact_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "issues_slug_key" ON "issues"("slug");

-- CreateIndex
CREATE INDEX "issues_organization_id_workstream_id_status_idx" ON "issues"("organization_id", "workstream_id", "status");

-- CreateIndex
CREATE INDEX "issues_organization_id_project_id_status_idx" ON "issues"("organization_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "issues_organization_id_assignee_id_status_idx" ON "issues"("organization_id", "assignee_id", "status");

-- CreateIndex
CREATE INDEX "issues_workstream_id_idx" ON "issues"("workstream_id");

-- CreateIndex
CREATE INDEX "issues_project_id_idx" ON "issues"("project_id");

-- CreateIndex
CREATE INDEX "issues_assignee_id_idx" ON "issues"("assignee_id");

-- CreateIndex
CREATE INDEX "issues_created_by_id_idx" ON "issues"("created_by_id");

-- CreateIndex
CREATE INDEX "external_links_organization_id_workstream_id_type_idx" ON "external_links"("organization_id", "workstream_id", "type");

-- CreateIndex
CREATE INDEX "external_links_organization_id_project_id_type_idx" ON "external_links"("organization_id", "project_id", "type");

-- CreateIndex
CREATE INDEX "external_links_workstream_id_idx" ON "external_links"("workstream_id");

-- CreateIndex
CREATE INDEX "external_links_project_id_idx" ON "external_links"("project_id");

-- CreateIndex
CREATE INDEX "entity_links_source_id_source_type_link_type_idx" ON "entity_links"("source_id", "source_type", "link_type");

-- CreateIndex
CREATE INDEX "entity_links_target_id_target_type_link_type_idx" ON "entity_links"("target_id", "target_type", "link_type");

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_slug_key" ON "artifacts"("slug");

-- CreateIndex
CREATE INDEX "artifacts_organization_id_workstream_id_type_idx" ON "artifacts"("organization_id", "workstream_id", "type");

-- CreateIndex
CREATE INDEX "artifacts_organization_id_project_id_type_idx" ON "artifacts"("organization_id", "project_id", "type");

-- CreateIndex
CREATE INDEX "artifacts_organization_id_type_template_for_type_idx" ON "artifacts"("organization_id", "type", "template_for_type");

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_organization_id_template_for_type_key" ON "artifacts"("organization_id", "template_for_type");

-- CreateIndex
CREATE INDEX "github_pull_requests_artifact_id_idx" ON "github_pull_requests"("artifact_id");
