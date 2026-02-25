-- CreateTable
CREATE TABLE "judge_scores" (
    "id" UUID NOT NULL,
    "evaluation_id" UUID NOT NULL,
    "prompt_id" UUID,
    "case_id" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "justification" TEXT NOT NULL,
    "final_status" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "judge_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "judge_scores_evaluation_id_case_id_key" ON "judge_scores"("evaluation_id", "case_id");

-- CreateIndex
CREATE INDEX "judge_scores_prompt_id_idx" ON "judge_scores"("prompt_id");

-- CreateIndex
CREATE INDEX "judge_scores_case_id_created_at_idx" ON "judge_scores"("case_id", "created_at");

-- Note: No DB-level FK constraint. This project uses relationMode = "prisma",
-- so referential integrity (including cascading deletes) is managed by the
-- Prisma client, not database constraints.
