-- FEA-3857 (parent FEA-3800, PLN-1456 Slice 1) — search_document indexes, built
-- CONCURRENTLY so they never take a write-blocking lock. Paired with the
-- CREATE TABLE migration 20260723030000_fea3857_search_document_projection,
-- which intentionally omits this DDL.
--
-- Three indexes:
--   • GIN on `tsv` — the full-text match the Slice-3 query runs
--     (`tsv @@ websearch_to_tsquery(...)`). Prisma cannot declare an index on an
--     `Unsupported("tsvector")` column, so this index is UNMANAGED by Prisma
--     (name `search_document_tsv_gin_idx`); it exists only here.
--   • btree `(organization_id, entity_type, updated_at)` — the org-scoped,
--     type-faceted, recency-ordered candidate scan. Prisma-managed by name.
--   • unique `(organization_id, entity_type, entity_id)` — the idempotent
--     upsert key for the backfill and the Slice-2 write hooks. Prisma-managed by
--     name.
-- The two Prisma-managed names match the `@@index` / `@@unique` declarations in
-- schema.prisma verbatim, so the dev shadow-database drift check stays clean
-- even though they are built CONCURRENTLY here rather than by Prisma's
-- generated plain-index DDL.
--
-- NON-TRANSACTIONAL BY DESIGN — WHY THIS FILE IS ONLY BARE `CREATE INDEX
-- CONCURRENTLY` STATEMENTS: `CREATE INDEX CONCURRENTLY` cannot run inside a
-- transaction block (Postgres SQLSTATE 25001). `prisma migrate deploy` splits a
-- migration file into per-statement simple queries and runs each outside a
-- transaction — but ONLY if every statement is a bare top-level statement. Any
-- `DO $$ ... $$` block, `DROP INDEX CONCURRENTLY`, `BEGIN`/`COMMIT`, or embedded
-- semicolon/dollar-quoting defeats Prisma's naive splitter and makes it wrap the
-- WHOLE file in one transaction, which then fails every CONCURRENTLY statement
-- with 25001. So keep this file to bare `CREATE INDEX CONCURRENTLY IF NOT
-- EXISTS` statements only — no BEGIN/COMMIT, no DO block, no DROP CONCURRENTLY.
-- (Canonical precedent:
-- 20260721160000_fea3638_insights_perf_indexes_concurrent.)
--
-- IDEMPOTENT (`IF NOT EXISTS`): safe to re-run. On a mid-build cancel/crash an
-- INVALID same-named index can remain and a bare `IF NOT EXISTS` create would
-- silently skip its rebuild; that recovery is operator-driven (drop the invalid
-- index once, re-run migrate deploy) exactly as documented in the FEA-3638
-- migration — it cannot be auto-fixed in-file without re-triggering the
-- whole-file transaction wrap above.

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "search_document_tsv_gin_idx" ON "search_document" USING GIN ("tsv");

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "search_document_organization_id_entity_type_updated_at_idx" ON "search_document"("organization_id", "entity_type", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "search_document_organization_id_entity_type_entity_id_key" ON "search_document"("organization_id", "entity_type", "entity_id");
