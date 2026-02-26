-- =============================================================================
-- Migration: standardize_entity_fields
-- Consolidates priority enums, renames status values, renames owner → assignee,
-- adds createdById, status, slug fields across Project/Workstream/Artifact/Issue.
-- =============================================================================

-- =============================================================================
-- STEP 1: Create new enum types
-- =============================================================================

-- 1a. Unified Priority enum (replaces ProjectPriority and IssuePriority)
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- 1b. ProjectStatus enum (new)
CREATE TYPE "ProjectStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'ARCHIVED');

-- 1c. New IssueStatus enum (renames TODO → NOT_STARTED, CLOSED → COMPLETED, adds OBSOLETE)
CREATE TYPE "IssueStatus_new" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'IN_REVIEW', 'COMPLETED', 'OBSOLETE');

-- 1d. New ArtifactStatus enum (renames REVIEW → IN_REVIEW, ARCHIVED → OBSOLETE)
CREATE TYPE "ArtifactStatus_new" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'OBSOLETE');

-- =============================================================================
-- STEP 2: Migrate IssueStatus enum values
-- =============================================================================

-- Convert column to text, map old values, cast to new enum
ALTER TABLE "issues" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "issues" ALTER COLUMN "status" TYPE TEXT;

UPDATE "issues" SET "status" = 'NOT_STARTED' WHERE "status" = 'TODO';
UPDATE "issues" SET "status" = 'COMPLETED' WHERE "status" = 'CLOSED';

ALTER TABLE "issues" ALTER COLUMN "status" TYPE "IssueStatus_new" USING "status"::"IssueStatus_new";
ALTER TABLE "issues" ALTER COLUMN "status" SET DEFAULT 'NOT_STARTED';

-- Drop old IssueStatus and rename new
DROP TYPE "IssueStatus";
ALTER TYPE "IssueStatus_new" RENAME TO "IssueStatus";

-- =============================================================================
-- STEP 3: Migrate ArtifactStatus enum values
-- =============================================================================

ALTER TABLE "artifacts" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "artifacts" ALTER COLUMN "status" TYPE TEXT;

UPDATE "artifacts" SET "status" = 'IN_REVIEW' WHERE "status" = 'REVIEW';
UPDATE "artifacts" SET "status" = 'OBSOLETE' WHERE "status" = 'ARCHIVED';

ALTER TABLE "artifacts" ALTER COLUMN "status" TYPE "ArtifactStatus_new" USING "status"::"ArtifactStatus_new";
ALTER TABLE "artifacts" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- Drop old ArtifactStatus and rename new
DROP TYPE "ArtifactStatus";
ALTER TYPE "ArtifactStatus_new" RENAME TO "ArtifactStatus";

-- =============================================================================
-- STEP 4: Migrate Project priority from ProjectPriority to Priority
-- =============================================================================

ALTER TABLE "projects" ALTER COLUMN "priority" DROP DEFAULT;
ALTER TABLE "projects" ALTER COLUMN "priority" TYPE TEXT;

-- Map NOT_SET → MEDIUM (no direct equivalent in unified enum)
UPDATE "projects" SET "priority" = 'MEDIUM' WHERE "priority" = 'NOT_SET';

ALTER TABLE "projects" ALTER COLUMN "priority" TYPE "Priority" USING "priority"::"Priority";
ALTER TABLE "projects" ALTER COLUMN "priority" SET DEFAULT 'MEDIUM';

-- Drop old ProjectPriority enum
DROP TYPE "ProjectPriority";

-- =============================================================================
-- STEP 5: Migrate Issue priority from IssuePriority to Priority
-- =============================================================================

ALTER TABLE "issues" ALTER COLUMN "priority" DROP DEFAULT;
ALTER TABLE "issues" ALTER COLUMN "priority" TYPE TEXT;

-- Values are identical (LOW, MEDIUM, HIGH, URGENT) so no mapping needed
ALTER TABLE "issues" ALTER COLUMN "priority" TYPE "Priority" USING "priority"::"Priority";
ALTER TABLE "issues" ALTER COLUMN "priority" SET DEFAULT 'MEDIUM';

-- Drop old IssuePriority enum
DROP TYPE "IssuePriority";

-- =============================================================================
-- STEP 6: Project field changes
-- =============================================================================

-- 6a. Rename owner_id → assignee_id
ALTER TABLE "projects" RENAME COLUMN "owner_id" TO "assignee_id";

-- 6b. Add new columns
ALTER TABLE "projects" ADD COLUMN "created_by_id" UUID;
ALTER TABLE "projects" ADD COLUMN "status" "ProjectStatus" NOT NULL DEFAULT 'NOT_STARTED';
ALTER TABLE "projects" ADD COLUMN "slug" TEXT;

-- 6c. Backfill created_by_id from assignee_id (old owner_id)
UPDATE "projects" SET "created_by_id" = "assignee_id" WHERE "assignee_id" IS NOT NULL;

-- 6d. For projects where assignee_id is NULL, use first user in the same org
UPDATE "projects" p
SET "created_by_id" = (
  SELECT u."id" FROM "users" u
  WHERE u."organization_id" = p."organization_id"
  ORDER BY u."created_at" ASC
  LIMIT 1
)
WHERE p."created_by_id" IS NULL;

-- 6e. Set NOT NULL constraint after backfill
ALTER TABLE "projects" ALTER COLUMN "created_by_id" SET NOT NULL;

-- 6f. Update indexes: drop old owner_id index, create new ones
DROP INDEX IF EXISTS "projects_owner_id_idx";
CREATE INDEX "projects_assignee_id_idx" ON "projects"("assignee_id");
CREATE INDEX "projects_created_by_id_idx" ON "projects"("created_by_id");

-- 6g. Add unique constraint for slug (nullable, so NULLs don't conflict)
CREATE UNIQUE INDEX "projects_organization_id_slug_key" ON "projects"("organization_id", "slug");

-- =============================================================================
-- STEP 7: Artifact field changes
-- =============================================================================

-- 7a. Rename owner_id → assignee_id
ALTER TABLE "artifacts" RENAME COLUMN "owner_id" TO "assignee_id";

-- 7b. Rename generated_by → created_by_id
ALTER TABLE "artifacts" RENAME COLUMN "generated_by" TO "created_by_id";

-- 7c. Backfill created_by_id where NULL using COALESCE chain
UPDATE "artifacts" a
SET "created_by_id" = COALESCE(
  a."created_by_id",
  a."assignee_id",
  a."approver_id",
  (
    SELECT u."id" FROM "users" u
    WHERE u."organization_id" = a."organization_id"
    ORDER BY u."created_at" ASC
    LIMIT 1
  )
)
WHERE a."created_by_id" IS NULL;

-- 7d. Set NOT NULL constraint after backfill
ALTER TABLE "artifacts" ALTER COLUMN "created_by_id" SET NOT NULL;

-- 7e. Update indexes: drop old owner_id index, create new ones
DROP INDEX IF EXISTS "artifacts_owner_id_idx";
CREATE INDEX "artifacts_assignee_id_idx" ON "artifacts"("assignee_id");
CREATE INDEX "artifacts_created_by_id_idx" ON "artifacts"("created_by_id");

-- =============================================================================
-- STEP 8: Workstream new fields
-- =============================================================================

-- 8a. Add new columns
ALTER TABLE "workstreams" ADD COLUMN "assignee_id" UUID;
ALTER TABLE "workstreams" ADD COLUMN "priority" "Priority" NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE "workstreams" ADD COLUMN "slug" TEXT;

-- 8b. Add indexes
CREATE INDEX "workstreams_assignee_id_idx" ON "workstreams"("assignee_id");

-- 8c. Add unique constraint for slug (nullable, so NULLs don't conflict)
CREATE UNIQUE INDEX "workstreams_organization_id_slug_key" ON "workstreams"("organization_id", "slug");
