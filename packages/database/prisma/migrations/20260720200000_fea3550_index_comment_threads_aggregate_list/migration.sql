-- FEA-3550: the org-scoped aggregate `GET /trace-comments` list queries
-- comment_threads by (organization_id, source, status?) with a live-comment
-- EXISTS check and orders by created_at DESC. The existing composite indexes
-- lead with (organization_id, artifact_id, status) and (organization_id,
-- status, updated_at); neither carries `source` next to `organization_id` nor
-- `created_at` as the trailing sort column, so as an org's native comment
-- volume grows the planner degrades toward a scan. This additive composite
-- index leads with the equality columns (organization_id, source, status) and
-- carries created_at last to serve both the status filter and the DESC sort.
-- Purely additive (index-only, no data mutation); generated offline
-- (no local DB in this env), applied by `prisma migrate deploy` in CI/prod.

-- CreateIndex
CREATE INDEX "comment_threads_organization_id_source_status_created_at_idx" ON "comment_threads"("organization_id", "source", "status", "created_at");
