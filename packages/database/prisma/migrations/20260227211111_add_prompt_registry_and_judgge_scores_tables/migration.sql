-- CreateEnum
CREATE TYPE "EvalStatus" AS ENUM ('FAILED', 'NEEDS_IMPROVEMENT', 'PASSED');

-- CreateEnum
CREATE TYPE "PromptType" AS ENUM ('AGENT', 'JUDGE');

-- AlterTable
ALTER TABLE "artifact_evaluations" ALTER COLUMN "report_data" DROP NOT NULL;

-- CreateTable
CREATE TABLE "judge_scores" (
    "id" UUID NOT NULL,
    "evaluation_id" UUID NOT NULL,
    "prompt_id" UUID,
    "case_id" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "justification" TEXT NOT NULL,
    "final_status" "EvalStatus" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "judge_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_registry" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "prompt_type" "PromptType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tools" TEXT[],
    "file_path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_registry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "judge_scores_prompt_id_idx" ON "judge_scores"("prompt_id");

-- CreateIndex
CREATE INDEX "judge_scores_case_id_created_at_idx" ON "judge_scores"("case_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "judge_scores_evaluation_id_case_id_key" ON "judge_scores"("evaluation_id", "case_id");

-- CreateIndex
CREATE INDEX "prompt_registry_organization_id_name_idx" ON "prompt_registry"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_registry_organization_id_name_version_key" ON "prompt_registry"("organization_id", "name", "version");
