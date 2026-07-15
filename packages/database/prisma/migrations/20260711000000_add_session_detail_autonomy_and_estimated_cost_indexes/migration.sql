-- CreateIndex
-- The Sessions list gained autonomy-tier and cost-bucket facets (FEA-2504,
-- agent-sessions/service.ts buildAutonomyTierWhere / buildCostBucketWhere). Both
-- filter session_detail with RANGE predicates (autonomy gte/lt with an IS NULL
-- "unknown" tier; estimated_cost gte/lt). No existing index covers either column
-- — the composites lead with compute_target_id/user_id/harness/last_activity_at
-- — so each faceted read falls back to a seq-scan as session_detail grows.
--
-- These are single-column indexes rather than composites with the list's
-- last_activity_at sort column on purpose: a range predicate on the leading
-- column can't also serve the ORDER BY (unlike the equality-based harness facet's
-- [harness, session_started_at] index), so the useful shape is one index per
-- filtered column — mirroring the single-column session_detail_repository_full_name_idx
-- facet index.
CREATE INDEX "session_detail_autonomy_idx" ON "session_detail"("autonomy");

-- CreateIndex
CREATE INDEX "session_detail_estimated_cost_idx" ON "session_detail"("estimated_cost");
