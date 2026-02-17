-- CreateTable
CREATE TABLE "github_action_run_performances" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "action_run_id" UUID,
    "summary_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_action_run_performances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "github_action_run_performances_artifact_id_idx" ON "github_action_run_performances"("artifact_id");

-- AddForeignKey
ALTER TABLE "github_action_run_performances" ADD CONSTRAINT "github_action_run_performances_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
