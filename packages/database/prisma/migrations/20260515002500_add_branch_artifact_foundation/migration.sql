-- PLN-587 Migration A: additive branch artifact foundation.
--
-- This migration intentionally keeps PULL_REQUEST artifacts and the legacy
-- pull_request_detail branch-owned columns in place. The destructive cutover
-- migration will backfill/collapse historical PR artifacts, promote
-- pull_request_detail.id to the PR-detail identity, swap the ArtifactType enum,
-- and drop legacy PR/deployment names after branch-aware code has deployed.

-- AlterEnum
ALTER TYPE "ArtifactType" ADD VALUE 'BRANCH';

-- AlterTable
ALTER TABLE "pull_request_detail" ADD COLUMN     "branch_artifact_id" UUID,
ADD COLUMN     "html_url" TEXT,
ADD COLUMN     "id" UUID DEFAULT gen_random_uuid(),
ADD COLUMN     "is_current" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "deployment_detail" ADD COLUMN     "branch_artifact_id" UUID;

-- CreateTable
CREATE TABLE "branch_detail" (
    "artifact_id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "branch_name" TEXT NOT NULL,
    "base_branch" TEXT,
    "base_branch_source" TEXT,
    "head_sha" TEXT,
    "head_sha_source" TEXT,
    "head_sha_observed_at" TIMESTAMP(3),
    "last_push_before_sha" TEXT,
    "current_pull_request_detail_id" UUID,
    "deleted_at" TIMESTAMP(3),
    "checks_status" "ChecksStatus" NOT NULL DEFAULT 'UNKNOWN',
    "file_cache_status" TEXT NOT NULL DEFAULT 'absent',
    "file_cache_head_sha" TEXT,
    "file_cache_file_count" INTEGER NOT NULL DEFAULT 0,
    "file_cache_patch_bytes" INTEGER NOT NULL DEFAULT 0,
    "file_cache_updated_at" TIMESTAMP(3),
    "sync_status" TEXT NOT NULL DEFAULT 'idle',
    "last_sync_started_at" TIMESTAMP(3),
    "last_sync_completed_at" TIMESTAMP(3),
    "last_sync_error_code" TEXT,
    "last_sync_error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_detail_pkey" PRIMARY KEY ("artifact_id")
);

-- CreateTable
CREATE TABLE "branch_file_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_artifact_id" UUID NOT NULL,
    "head_sha" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "previous_path" TEXT,
    "status" TEXT NOT NULL,
    "additions" INTEGER,
    "deletions" INTEGER,
    "changes" INTEGER,
    "patch" TEXT,
    "patch_bytes" INTEGER NOT NULL DEFAULT 0,
    "patch_omitted_reason" TEXT,
    "is_binary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_file_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branch_detail_repository_id_head_sha_idx" ON "branch_detail"("repository_id", "head_sha");

-- CreateIndex
CREATE INDEX "branch_detail_current_pull_request_detail_id_idx" ON "branch_detail"("current_pull_request_detail_id");

-- CreateIndex
CREATE INDEX "branch_detail_sync_status_idx" ON "branch_detail"("sync_status");

-- CreateIndex
CREATE UNIQUE INDEX "branch_detail_repository_id_branch_name_key" ON "branch_detail"("repository_id", "branch_name");

-- CreateIndex
CREATE INDEX "branch_file_changes_branch_artifact_id_path_idx" ON "branch_file_changes"("branch_artifact_id", "path");

-- CreateIndex
CREATE INDEX "branch_file_changes_branch_artifact_id_head_sha_idx" ON "branch_file_changes"("branch_artifact_id", "head_sha");

-- CreateIndex
CREATE UNIQUE INDEX "branch_file_changes_branch_artifact_id_head_sha_path_key" ON "branch_file_changes"("branch_artifact_id", "head_sha", "path");

-- CreateIndex
CREATE UNIQUE INDEX "pull_request_detail_id_key" ON "pull_request_detail"("id");

-- CreateIndex
CREATE INDEX "pull_request_detail_branch_artifact_id_is_current_idx" ON "pull_request_detail"("branch_artifact_id", "is_current");

-- CreateIndex
CREATE INDEX "deployment_detail_branch_artifact_id_idx" ON "deployment_detail"("branch_artifact_id");

-- AddForeignKey
ALTER TABLE "branch_detail" ADD CONSTRAINT "branch_detail_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_detail" ADD CONSTRAINT "branch_detail_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "github_installation_repositories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_detail" ADD CONSTRAINT "branch_detail_current_pull_request_detail_id_fkey" FOREIGN KEY ("current_pull_request_detail_id") REFERENCES "pull_request_detail"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_request_detail" ADD CONSTRAINT "pull_request_detail_branch_artifact_id_fkey" FOREIGN KEY ("branch_artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_file_changes" ADD CONSTRAINT "branch_file_changes_branch_artifact_id_fkey" FOREIGN KEY ("branch_artifact_id") REFERENCES "branch_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_detail" ADD CONSTRAINT "deployment_detail_branch_artifact_id_fkey" FOREIGN KEY ("branch_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
