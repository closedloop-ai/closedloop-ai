-- AlterTable
ALTER TABLE "artifact_links" ADD COLUMN     "branch_participation" VARCHAR(32),
ADD COLUMN     "branch_participation_method" VARCHAR(200),
ADD COLUMN     "branch_participation_observed_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "artifact_links_org_source_link_participation_idx" ON "artifact_links"("organization_id", "source_id", "link_type", "branch_participation");

-- CreateIndex
CREATE INDEX "artifact_links_org_target_link_participation_idx" ON "artifact_links"("organization_id", "target_id", "link_type", "branch_participation");
