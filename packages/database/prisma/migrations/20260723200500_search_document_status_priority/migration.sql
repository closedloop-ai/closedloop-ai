-- FEA-3930 (parent FEA-3800, PLN-1456) — structured query-language slice for
-- unified search. Additive `status` + `priority` filter columns on the search
-- projection `search_document`.
--
-- WHY: the query language lets a user type `:status=TODO` / `:priority>=high`
-- inline. The projection already mirrors `project_id`/`assignee_id`/`updated_at`
-- but NOT the source entity's status or priority, so those filters had nothing
-- to resolve against. These two columns carry the source entity's own lifecycle
-- status and priority as plain TEXT so the filter is a column predicate, not a
-- join back to Artifact/Project/Loop. The `status` column is deliberately NOT a
-- DB enum — it holds whichever vocabulary the source uses (FeatureStatus /
-- DocumentStatus / ProjectStatus / LoopStatus) as its raw string. `priority` is
-- compared by the ordinal in packages/api/src/types/search-query.ts
-- (LOW < MEDIUM < HIGH < URGENT).
--
-- ADDITIVE / BACKFILL-SAFE: both columns are NULLABLE with no default, so adding
-- them takes only a metadata-level lock and every existing row stays valid with
-- NULL (null where the source has no such field — a loop has no priority — or
-- until the backfill/write-hooks populate it). Neither column is part of the
-- generated `tsv` vector or any index, so the GIN/btree indexes are untouched.
--
-- Generated verbatim from schema.prisma's SearchDocument model (two `ADD COLUMN`
-- statements) — no Prisma-inexpressible construct here; committed alongside the
-- schema change so `prisma migrate dev` reports no drift.

-- AlterTable
ALTER TABLE "search_document" ADD COLUMN "status" TEXT;
ALTER TABLE "search_document" ADD COLUMN "priority" TEXT;
