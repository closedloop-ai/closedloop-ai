-- CreateIndex
CREATE INDEX CONCURRENTLY "branch_detail_push_coverage_round_robin_idx" ON "branch_detail"("push_coverage_last_attempt_at", "artifact_id");

-- CreateIndex
CREATE INDEX CONCURRENTLY "branch_push_contributions_current_ref_history_idx" ON "branch_push_contributions"("organization_id", "branch_artifact_id", "repository_full_name", "ref_name", "observed_at", "id");
