-- FEA-3930 (parent FEA-3800) — index the exact ID/slug lookup path added to
-- `GET /search` (search-fts-service.ts#runExactLookupQuery). That query filters
--   WHERE "organization_id" = $1 AND (lower("slug") = lower($2) OR "entity_id" = $3)
-- across ALL entity types. The existing SearchDocument indexes
--   • (organization_id, entity_type, updated_at)
--   • unique (organization_id, entity_type, entity_id)
--   • GIN (tsv)
-- do NOT cover it: the slug branch has no index at all, and the unique index
-- cannot serve an `entity_id` lookup without also constraining `entity_type`
-- (entity_id is its third column). So a growing corpus makes the exact lookup
-- scan the org's projection rows.
--
-- Two org-scoped indexes for the two exact-match branches:
--   • EXPRESSION index `(organization_id, lower(slug))` for the slug branch.
--     Prisma's DSL cannot declare a functional/expression index, so this index
--     is UNMANAGED by Prisma (like `search_document_tsv_gin_idx`); it exists
--     ONLY in this migration and is documented in schema.prisma so Prisma does
--     not try to drop it as an unknown index. `WHERE "slug" IS NOT NULL` keeps
--     it small — most projection rows (loops/sessions/branches) carry no slug.
--   • btree `(organization_id, entity_id)` for the pasted-UUID branch.
--
-- NON-TRANSACTIONAL BY DESIGN — bare `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
-- statements only (no BEGIN/COMMIT, no DO block, no DROP CONCURRENTLY). Any of
-- those would defeat Prisma's naive statement splitter and wrap the whole file
-- in one transaction, which fails every CONCURRENTLY statement with SQLSTATE
-- 25001. Canonical precedent:
-- 20260723030001_fea3857_search_document_concurrent_indexes.
--
-- IDEMPOTENT (`IF NOT EXISTS`): safe to re-run. On a mid-build cancel an INVALID
-- same-named index can remain and a bare `IF NOT EXISTS` create would silently
-- skip its rebuild; recovery is operator-driven (drop the invalid index once,
-- re-run migrate deploy), exactly as documented in the FEA-3857 precedent.

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "search_document_org_lower_slug_idx" ON "search_document"("organization_id", lower("slug")) WHERE "slug" IS NOT NULL;

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "search_document_organization_id_entity_id_idx" ON "search_document"("organization_id", "entity_id");
