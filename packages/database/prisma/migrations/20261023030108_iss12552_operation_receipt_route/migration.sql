-- ISS-12552: the route template that took an API-key write, so the
-- attribution comparison report can count API-key writes by route.
-- AlterTable
ALTER TABLE "artifact_operation_receipts" ADD COLUMN     "route" TEXT;
