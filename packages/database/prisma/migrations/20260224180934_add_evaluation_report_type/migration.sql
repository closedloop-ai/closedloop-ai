-- CreateEnum
CREATE TYPE "EvaluationReportType" AS ENUM ('PLAN', 'CODE');

-- AlterTable
ALTER TABLE "artifact_evaluations"
ADD COLUMN "report_type" "EvaluationReportType" NOT NULL DEFAULT 'PLAN';
