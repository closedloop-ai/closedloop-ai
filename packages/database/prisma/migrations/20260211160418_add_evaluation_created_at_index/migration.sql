-- CreateIndex
CREATE INDEX "artifact_evaluations_created_at_artifact_id_idx" ON "artifact_evaluations"("created_at", "artifact_id");
