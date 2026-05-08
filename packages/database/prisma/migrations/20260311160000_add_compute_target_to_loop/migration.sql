-- AlterTable
ALTER TABLE "loops" ADD COLUMN "compute_target_id" UUID;

-- CreateIndex
CREATE INDEX "loops_compute_target_id_idx" ON "loops"("compute_target_id");
