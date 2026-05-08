-- AlterTable
ALTER TABLE "compute_targets" ADD COLUMN "is_shared_with_org" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "compute_targets_organization_id_is_shared_with_org_idx" ON "compute_targets"("organization_id", "is_shared_with_org");
