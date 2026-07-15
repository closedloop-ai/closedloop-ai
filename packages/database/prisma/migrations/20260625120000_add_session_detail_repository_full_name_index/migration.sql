-- CreateIndex
-- The Sessions list filters session_detail by repository_full_name (IN clause,
-- agent-sessions/service.ts buildWhere), sorts by it (the "repo" sort key), and
-- aggregates over it (the groupBy("repositoryFullName") repo facet). No existing
-- index covers repository_full_name — the composite indexes lead with
-- compute_target_id/user_id/harness/last_activity_at — so each of these falls
-- back to a seq-scan + sort/hash-aggregate as session_detail grows. Add a
-- single-column index so the filter, ordered scan, and grouped aggregate are all
-- served by an index scan.
CREATE INDEX "session_detail_repository_full_name_idx" ON "session_detail"("repository_full_name");
