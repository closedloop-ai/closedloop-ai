-- CreateTable
CREATE TABLE "github_action_run_performances" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "action_run_id" UUID NOT NULL,
    "summary_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_action_run_performances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_action_run_performances_artifact_id_action_run_id_key" ON "github_action_run_performances"("artifact_id", "action_run_id");

-- AddForeignKey
ALTER TABLE "github_action_run_performances" ADD CONSTRAINT "github_action_run_performances_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
