/*
  Warnings:

  - A unique constraint covering the columns `[evaluation_id,case_id,metric_name]` on the table `judge_scores` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "judge_scores_case_id_created_at_idx";

-- DropIndex
DROP INDEX "judge_scores_evaluation_id_case_id_key";

-- Step 1: Add metric_name as nullable for safe backfill
ALTER TABLE "judge_scores" ADD COLUMN "metric_name" TEXT;

-- Step 2a: Backfill from normalized prompt name when prompt exists
UPDATE "judge_scores" AS "js"
SET "metric_name" = REPLACE(
  REGEXP_REPLACE(LOWER("pr"."name"), '(-judge|_judge|_score|-score)$', ''),
  '-',
  '_'
)
FROM "prompt_registry" AS "pr"
WHERE "js"."prompt_id" = "pr"."id"
  AND "js"."metric_name" IS NULL;

-- Step 2b: Fallback backfill from normalized case_id (NULL prompt_id or dangling prompt_id)
UPDATE "judge_scores"
SET "metric_name" = REPLACE(
  REGEXP_REPLACE(LOWER("case_id"), '(-judge|_judge|_score|-score)$', ''),
  '-',
  '_'
)
WHERE "metric_name" IS NULL;

-- Step 3: Enforce NOT NULL after backfill
ALTER TABLE "judge_scores" ALTER COLUMN "metric_name" SET NOT NULL;

-- CreateIndex
CREATE INDEX "judge_scores_metric_name_created_at_idx" ON "judge_scores"("metric_name", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "judge_scores_evaluation_id_case_id_metric_name_key" ON "judge_scores"("evaluation_id", "case_id", "metric_name");
