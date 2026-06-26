-- FEA-1684 / PRD-463 7.1: Session ↔ PR link table for deterministic extraction.
-- Shared with PRD-463 Stage 2. Do not re-create this table.
-- Stage 2 (LLM classification) adds PROBABILISTIC rows on top.

-- CreateEnum
CREATE TYPE "SessionPrRelationType" AS ENUM ('CREATED', 'REFERENCED');

-- CreateEnum
CREATE TYPE "SessionPrLinkSource" AS ENUM ('DETERMINISTIC');

-- CreateTable
CREATE TABLE "session_pull_request_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "session_artifact_id" UUID NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "pr_url" TEXT NOT NULL,
    "relation_type" "SessionPrRelationType" NOT NULL,
    "source" "SessionPrLinkSource" NOT NULL DEFAULT 'DETERMINISTIC',
    "confidence" DOUBLE PRECISION,
    "pull_request_detail_id" UUID,
    "review_status" TEXT,
    "extractor_version" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_pull_request_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_pull_request_links_organization_id_session_artifact_idx" ON "session_pull_request_links"("organization_id", "session_artifact_id");

-- CreateIndex
CREATE INDEX "session_pull_request_links_organization_id_repository_full__idx" ON "session_pull_request_links"("organization_id", "repository_full_name", "pr_number");

-- CreateIndex
CREATE UNIQUE INDEX "session_pull_request_links_session_artifact_id_repository_f_key" ON "session_pull_request_links"("session_artifact_id", "repository_full_name", "pr_number", "relation_type");

-- AddForeignKey
ALTER TABLE "session_pull_request_links" ADD CONSTRAINT "session_pull_request_links_session_artifact_id_fkey" FOREIGN KEY ("session_artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_pull_request_links" ADD CONSTRAINT "session_pull_request_links_pull_request_detail_id_fkey" FOREIGN KEY ("pull_request_detail_id") REFERENCES "pull_request_detail"("id") ON DELETE SET NULL ON UPDATE CASCADE;
