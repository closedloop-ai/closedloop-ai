-- ISS-7211 (custom-field list filtering/sorting), facet indexes on
-- `custom_field_values` — built CONCURRENTLY (zero write-blocking prod apply).
--
-- WHY CONCURRENTLY: a plain `CREATE INDEX` takes a SHARE lock on the table for
-- the full duration of the build, blocking every INSERT/UPDATE/DELETE against
-- it until the index is ready. This repo has already paid for that once:
-- 20260721120000_fea3638_insights_perf_tier1_indexes used plain `CREATE INDEX`
-- on hot tables, "blocked writes and stalled the app", and was reverted and
-- re-landed as 20260721160000_fea3638_insights_perf_indexes_concurrent. Six new
-- indexes on `custom_field_values` — the table every custom-field write touches,
-- one row per field per entity — is that same profile. The table already exists
-- on main with real rows (it landed in #5487), so these builds would lock live
-- data; that is also why this migration does NOT belong on the plain-CREATE lock
-- allowlist, whose entries all create their table empty in the same migration
-- and therefore cannot use CONCURRENTLY at all.
-- `CREATE INDEX CONCURRENTLY` holds only SHARE UPDATE EXCLUSIVE, so concurrent
-- writes proceed while each index builds.
--
-- NO `IF NOT EXISTS`, DELIBERATELY — IT MUST FAIL CLOSED: a
-- `CREATE INDEX CONCURRENTLY` that is cancelled or crashes mid-build leaves an
-- INVALID index of the same name behind, which Postgres ignores for planning.
-- With `IF NOT EXISTS` a retry would see that name, skip the rebuild, and mark
-- the migration applied — recording a permanently-unusable perf index as
-- healthy. Without it the retry errors on the remnant, which is the outcome we
-- want: an operator drops it once and re-runs the migrate step (a plain
-- `DROP INDEX` on an unused invalid index is instant and non-blocking):
--       DROP INDEX IF EXISTS "custom_field_values_custom_field_id_entity_type_text_value_idx";
--   (and likewise for the other five names below), then re-run
--   `prisma migrate deploy`, which rebuilds them CONCURRENTLY.
-- This is enforced by scripts/lint/destructive-migrations/index-ddl.ts, which
-- requires CONCURRENTLY to omit IF NOT EXISTS and requires the opposite of an
-- allowlisted plain create.
--
-- NON-TRANSACTIONAL BY DESIGN — WHY THIS FILE IS ONLY BARE `CREATE INDEX
-- CONCURRENTLY` STATEMENTS: `CREATE INDEX CONCURRENTLY` cannot run inside a
-- transaction block (Postgres SQLSTATE 25001). `prisma migrate deploy` splits a
-- migration file into per-statement simple queries, so a file of ONLY bare
-- top-level statements executes each create outside any transaction and
-- succeeds. But the splitter is naive: any statement carrying embedded
-- semicolons or dollar-quoting — a `DO $$ ... $$` block, a `DROP INDEX
-- CONCURRENTLY`, a multi-statement function body — defeats it and makes Prisma
-- wrap the WHOLE file in one transaction, which then fails every CONCURRENTLY
-- statement with 25001 (the FEA-3638 re-land hit exactly that in CI and prod).
-- So: keep this file to bare top-level `CREATE INDEX CONCURRENTLY` statements
-- only. Do NOT add a BEGIN/COMMIT, a `DO` block, or a `DROP INDEX CONCURRENTLY`
-- here.
--
-- Purely additive: index-only, no data mutation, no result change (indexes alter
-- plan choice only). Names and key lists match the `@@index` declarations in
-- schema.prisma, so the Prisma drift check stays green.

-- CreateIndex
CREATE INDEX CONCURRENTLY "custom_field_values_custom_field_id_entity_type_text_value_idx" ON "custom_field_values"("custom_field_id", "entity_type", "text_value");

-- CreateIndex
CREATE INDEX CONCURRENTLY "custom_field_values_custom_field_id_entity_type_number_valu_idx" ON "custom_field_values"("custom_field_id", "entity_type", "number_value");

-- CreateIndex
CREATE INDEX CONCURRENTLY "custom_field_values_custom_field_id_entity_type_date_value_idx" ON "custom_field_values"("custom_field_id", "entity_type", "date_value");

-- CreateIndex
CREATE INDEX CONCURRENTLY "custom_field_values_custom_field_id_entity_type_enum_value__idx" ON "custom_field_values"("custom_field_id", "entity_type", "enum_value_id");

-- CreateIndex
CREATE INDEX CONCURRENTLY "custom_field_values_multi_enum_value_ids_idx" ON "custom_field_values" USING GIN ("multi_enum_value_ids");

-- CreateIndex
CREATE INDEX CONCURRENTLY "custom_field_values_people_value_ids_idx" ON "custom_field_values" USING GIN ("people_value_ids");
