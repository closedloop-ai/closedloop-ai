-- DropForeignKey
ALTER TABLE "preview_deployments" DROP CONSTRAINT "preview_deployments_artifact_id_fkey";

-- CreateTable
CREATE TABLE "artifact_evaluations" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "action_run_id" UUID,
    "report_id" TEXT NOT NULL,
    "report_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "artifact_evaluations_artifact_id_idx" ON "artifact_evaluations"("artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX "artifact_evaluations_artifact_id_report_id_key" ON "artifact_evaluations"("artifact_id", "report_id");
