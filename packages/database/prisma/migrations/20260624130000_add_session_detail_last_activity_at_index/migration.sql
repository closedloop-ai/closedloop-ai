-- CreateIndex
-- The Sessions list default sort orders by last_activity_at DESC scoped only by
-- organization (via the artifact relation) with no compute_target_id filter, so
-- the existing composite (compute_target_id, last_activity_at) index cannot serve
-- it. Add a single-column index so the default sort uses an index scan instead of
-- a seq-scan + sort as session_detail grows.
CREATE INDEX "session_detail_last_activity_at_idx" ON "session_detail"("last_activity_at");
