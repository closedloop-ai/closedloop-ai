-- FEA-4373: index the My Tasks assigned-artifact paging path.
--
-- The bounded My Tasks list query filters on (organization_id, assignee_id) and
-- orders by (created_at DESC, id DESC), then pages with take/skip. The existing
-- "artifacts_organization_id_assignee_id_idx" serves the filter but not the
-- sort, so offset paging over a large assigned set had to scan and sort the
-- whole slice per page. This composite covers the full predicate + order, in the
-- exact sort direction, so paging stays index-ordered on the large datasets this
-- change targets.
--
-- Hand-written (not Prisma-generated) only because the shared local Postgres
-- cannot be applied against from a worktree without causing drift/reset; the
-- schema carries the matching `@@index([...], map: "...")` so `prisma migrate
-- dev` reports no drift once this migration is applied.
CREATE INDEX "artifacts_org_assignee_created_id_idx"
  ON "artifacts" ("organization_id", "assignee_id", "created_at" DESC, "id" DESC);
