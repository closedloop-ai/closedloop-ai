-- AlterTable
ALTER TABLE "pull_request_detail" ADD COLUMN     "github_updated_at" TIMESTAMP(3),
ADD COLUMN     "head_ref_oid" TEXT;

-- CreateTable
CREATE TABLE "github_repo_sync_state" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'unsyncable',
    "watermark" TIMESTAMP(3),
    "cursor" TEXT,
    "last_swept_at" TIMESTAMP(3),
    "last_tier_evaluated_at" TIMESTAMP(3),
    "consecutive_failure_count" INTEGER NOT NULL DEFAULT 0,
    "deferred_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_repo_sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- index-lock-ok(github_repo_sync_state): table is created empty in this same migration so the unique index build locks zero rows with no concurrent writer, and CONCURRENTLY cannot defer it because Prisma wraps this migration file in a transaction and the (org, repo) unique is the upsert ON CONFLICT target that must exist before the first insert
CREATE UNIQUE INDEX IF NOT EXISTS "github_repo_sync_state_organization_id_repository_full_name_key" ON "github_repo_sync_state"("organization_id", "repository_full_name");

-- AddForeignKey
ALTER TABLE "github_repo_sync_state" ADD CONSTRAINT "github_repo_sync_state_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
