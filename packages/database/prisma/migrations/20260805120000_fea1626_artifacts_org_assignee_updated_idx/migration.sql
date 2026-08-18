-- FEA-1626: index the My Tasks recency window.
--
-- The bounded user-scoped list filters on (organization_id, assignee_id) and can
-- additionally window on updated_at. The existing
-- artifacts_org_assignee_created_id_idx does not carry updated_at, so every row
-- reached by org+assignee was rechecked against the window in memory -- the same
-- scan of the whole assigned set the window exists to avoid. Leading with the
-- window column lets the range scan stop early.
CREATE INDEX "artifacts_org_assignee_updated_idx" ON "artifacts" ("organization_id", "assignee_id", "updated_at" DESC);
