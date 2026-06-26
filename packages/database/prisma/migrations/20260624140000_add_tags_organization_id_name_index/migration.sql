-- CreateIndex
-- The Tags list (apps/api/app/tags/service.ts findByOrg) filters by organization_id
-- and orders by name ASC, and create()'s duplicate check (findFirst) filters on
-- (organization_id, name). The existing single-column (organization_id) index covers
-- the filter but not the ORDER BY, so Postgres falls back to a sort. Add a composite
-- (organization_id, name) index so the filter + ordered scan and the equality lookup
-- are both served by an index scan.
CREATE INDEX "tags_organization_id_name_idx" ON "tags"("organization_id", "name");
