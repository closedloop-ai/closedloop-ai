-- AlterTable
ALTER TABLE "github_pull_requests" ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "is_draft" BOOLEAN NOT NULL DEFAULT false;

-- AlterEnum
ALTER TYPE "WorkstreamEventType" ADD VALUE 'GITHUB_PR_CLOSED';
