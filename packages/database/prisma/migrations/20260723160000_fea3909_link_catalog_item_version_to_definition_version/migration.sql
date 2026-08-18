-- FEA-3909 / PRD-527 F4: link the catalog (pack membership) to the F1 provenance-free
-- definition registry. `catalog_item_versions` is the row that carries a pack
-- member's definition body (`content`), so the nullable link to the exact
-- `definition_versions` row lives here. Additive only: a new nullable FK column
-- (SetNull so a purged version never orphans the catalog row) plus its lookup
-- index. The provenance-tainted `catalog_items.component_uuid` is preserved as a
-- compatibility identity; readers prefer this link when present.
-- AlterTable
ALTER TABLE "catalog_item_versions" ADD COLUMN     "definition_version_id" UUID;

-- CreateIndex
CREATE INDEX "catalog_item_versions_definition_version_id_idx" ON "catalog_item_versions"("definition_version_id");

-- AddForeignKey
ALTER TABLE "catalog_item_versions" ADD CONSTRAINT "catalog_item_versions_definition_version_id_fkey" FOREIGN KEY ("definition_version_id") REFERENCES "definition_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- FEA-3909 / PRD-527 F4: NULL-safe unique key for null-`compute_target_id`
-- provenance (a `pack` occurrence today; a future repo scan). The full 8-column
-- `idx_source_occurrence_natural_key` cannot arbitrate a race here because
-- Postgres treats a NULL `compute_target_id` as DISTINCT in a unique index, so
-- two concurrent pack imports of the same member would each pass a find-then-
-- create check and insert a duplicate `pack` occurrence. This PARTIAL unique
-- index makes the database the arbiter for the null-target family, letting the
-- writer use an atomic `INSERT … ON CONFLICT DO UPDATE` (see
-- apps/api/app/definition-registry/service.ts#upsertSourceOccurrence). It scopes
-- to `WHERE compute_target_id IS NULL` so it never overlaps the non-null (local)
-- rows the full index already keys, and omits `compute_target_id` from its column
-- list (it is constant NULL in the predicate). Prisma cannot express a partial
-- unique index, so it is hand-written here and documented on the model in
-- schema.prisma.
CREATE UNIQUE INDEX "idx_source_occurrence_null_target_key"
  ON "source_occurrences" (
    "definition_version_id", "occurrence_type", "repo_full_name",
    "repo_path", "repo_commit", "local_path", "pack_id"
  )
  WHERE "compute_target_id" IS NULL;
