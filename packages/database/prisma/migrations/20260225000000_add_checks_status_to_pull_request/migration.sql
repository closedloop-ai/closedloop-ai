-- CreateEnum
CREATE TYPE "ChecksStatus" AS ENUM ('UNKNOWN', 'PENDING', 'PASSING', 'FAILING');

-- AlterTable: add checksStatus field with default UNKNOWN
ALTER TABLE "github_pull_requests" ADD COLUMN "checks_status" "ChecksStatus" NOT NULL DEFAULT 'UNKNOWN';

-- CreateIndex: fast lookups by headSha for webhook processing
CREATE INDEX "github_pull_requests_head_sha_idx" ON "github_pull_requests"("head_sha");
