-- AlterTable
ALTER TABLE "compute_targets" ADD COLUMN "selected_harness" TEXT NOT NULL DEFAULT 'claude';

-- AlterTable
ALTER TABLE "loops" ADD COLUMN "harness" TEXT NOT NULL DEFAULT 'claude';
