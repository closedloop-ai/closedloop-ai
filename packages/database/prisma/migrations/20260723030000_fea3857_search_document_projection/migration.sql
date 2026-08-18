-- FEA-3857 (parent FEA-3800, PLN-1456 Slice 1) — unified-search full-text
-- projection table. ADDITIVE / SHIPS DARK: no read or write path yet; rows are
-- populated only by the one-shot backfill
-- (packages/database/scripts/backfill-search-documents.ts). Write-time indexing
-- hooks (Slice 2) and the GET /search FTS query (Slice 3) land later.
--
-- WHY THIS FILE IS HAND-WRITTEN (Prisma cannot express it): the `tsv` column is
-- a Postgres GENERATED column
-- (`to_tsvector('english', title || ' ' || body)`), which Prisma's schema DSL
-- has no syntax for — the model carries it as `Unsupported("tsvector")?` and
-- `prisma migrate diff` would otherwise emit a plain nullable `tsvector` column
-- with no `GENERATED ALWAYS ... STORED` clause. So the CREATE TABLE is
-- hand-authored to define `tsv` as the STORED generated column. Everything else
-- (column set, types, `search_document_pkey`) matches the Prisma-generated DDL
-- verbatim so the dev shadow-database drift check stays clean.
--
-- WHY THE INDEXES ARE NOT HERE: the GIN index on `tsv`, the btree
-- `(organization_id, entity_type, updated_at)`, and the unique
-- `(organization_id, entity_type, entity_id)` are built with
-- `CREATE INDEX CONCURRENTLY` in the sibling migration
-- 20260723030001_fea3857_search_document_concurrent_indexes so they never take a
-- write-blocking lock. This transactional migration deliberately omits their
-- DDL; the concurrent file creates them with the exact names Prisma expects for
-- the two `@@`-declared indexes (plus an unmanaged name for the GIN), so the
-- combined post-migration schema matches schema.prisma and drift stays clean.
--
-- COALESCE guards NULL `body` so the generated expression is never NULL for a
-- present title.

-- CreateTable
CREATE TABLE "search_document" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "project_id" UUID,
    "assignee_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "tsv" tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce("title", '') || ' ' || coalesce("body", ''))
    ) STORED,

    CONSTRAINT "search_document_pkey" PRIMARY KEY ("id")
);
