-- Add denormalized organizationId to GitHubPullRequest for defense-in-depth (org-scoped queries).
-- Backfill from workstream.organization_id since workstreamId is required.

-- Step 1: Add column as nullable
ALTER TABLE "github_pull_requests" ADD COLUMN "organization_id" UUID;

-- Step 2: Backfill from workstream
UPDATE "github_pull_requests" gpr
SET "organization_id" = w."organization_id"
FROM "workstreams" w
WHERE gpr."workstream_id" = w.id;

-- Step 3: Enforce NOT NULL (fails if any row has null - workstreamId is required so backfill should cover all)
ALTER TABLE "github_pull_requests" ALTER COLUMN "organization_id" SET NOT NULL;

-- Step 4: Create index for org-scoped queries
-- Note: no FK constraint added — relationMode = "prisma" means Prisma manages
-- relations without DB-level FKs. Cascade deletes only run through Prisma client.
-- Direct SQL deletes of organizations may leave orphaned github_pull_requests rows.
CREATE INDEX "github_pull_requests_organization_id_idx" ON "github_pull_requests"("organization_id");
