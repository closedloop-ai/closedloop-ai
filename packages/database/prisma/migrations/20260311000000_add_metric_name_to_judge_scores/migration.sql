-- DropIndex
DROP INDEX "judge_scores_case_id_created_at_idx";

-- DropIndex
DROP INDEX "judge_scores_evaluation_id_case_id_key";

-- Step 1: Add column as nullable
ALTER TABLE "judge_scores" ADD COLUMN "metric_name" TEXT;

-- Step 2: Backfill existing rows: set metric_name = case_id
UPDATE "judge_scores" SET "metric_name" = "case_id" WHERE "metric_name" IS NULL;

-- Step 3: Set NOT NULL now that all rows have a value
ALTER TABLE "judge_scores" ALTER COLUMN "metric_name" SET NOT NULL;

-- CreateIndex
CREATE INDEX "judge_scores_metric_name_created_at_idx" ON "judge_scores"("metric_name", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "judge_scores_evaluation_id_case_id_metric_name_key" ON "judge_scores"("evaluation_id", "case_id", "metric_name");
