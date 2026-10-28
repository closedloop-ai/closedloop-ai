-- AlterTable
ALTER TABLE "branch_detail" ADD COLUMN     "push_coverage_availability" VARCHAR(32),
ADD COLUMN     "push_coverage_last_attempt_at" TIMESTAMP(3);
