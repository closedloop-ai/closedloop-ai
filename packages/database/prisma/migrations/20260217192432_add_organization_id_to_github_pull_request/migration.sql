-- Note: relationMode = "prisma" - Prisma manages relations; no DB-level FKs.
-- Direct SQL deletes of organizations may leave orphaned github_pull_requests rows.
-- DropForeignKey
ALTER TABLE "github_pull_requests" DROP CONSTRAINT "github_pull_requests_organization_id_fkey";
