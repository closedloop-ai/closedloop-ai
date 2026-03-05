-- CreateTable
CREATE TABLE "judge_human_scores" (
    "id" UUID NOT NULL,
    "evaluation_id" UUID NOT NULL,
    "judge_score_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "judge_human_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "judge_human_scores_evaluation_id_idx" ON "judge_human_scores"("evaluation_id");

-- CreateIndex
CREATE INDEX "judge_human_scores_organization_id_idx" ON "judge_human_scores"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "judge_human_scores_judge_score_id_user_id_organization_id_key" ON "judge_human_scores"("judge_score_id", "user_id", "organization_id");

-- CreateIndex
CREATE INDEX "judge_human_scores_organization_id_user_id_idx" ON "judge_human_scores"("organization_id", "user_id");