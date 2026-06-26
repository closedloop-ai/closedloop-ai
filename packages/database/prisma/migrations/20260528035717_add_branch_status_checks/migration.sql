-- AlterTable
ALTER TABLE "branch_detail" ADD COLUMN     "checks_detail_head_sha" TEXT,
ADD COLUMN     "checks_detail_provider_state" TEXT,
ADD COLUMN     "checks_detail_total_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "checks_detail_truncated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "checks_detail_unavailable_reason" TEXT,
ADD COLUMN     "checks_detail_updated_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "branch_status_checks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_artifact_id" UUID NOT NULL,
    "head_sha" TEXT NOT NULL,
    "provider_key" VARCHAR(160) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "provider_node_id" VARCHAR(255),
    "name" VARCHAR(255) NOT NULL,
    "status" VARCHAR(64),
    "conclusion" VARCHAR(64),
    "target_url" VARCHAR(2048),
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_status_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branch_status_checks_branch_head_position_idx" ON "branch_status_checks"("branch_artifact_id", "head_sha", "position");

-- CreateIndex
CREATE UNIQUE INDEX "branch_status_checks_branch_head_provider_key" ON "branch_status_checks"("branch_artifact_id", "head_sha", "provider_key");

-- AddForeignKey
ALTER TABLE "branch_status_checks" ADD CONSTRAINT "branch_status_checks_branch_artifact_id_fkey" FOREIGN KEY ("branch_artifact_id") REFERENCES "branch_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;
