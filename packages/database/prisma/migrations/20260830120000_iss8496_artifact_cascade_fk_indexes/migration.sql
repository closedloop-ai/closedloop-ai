-- ISS-8496: give every unindexed referential action on the delete-project
-- cascade an index it can seek, so `DELETE /projects/:id` stops scanning whole
-- child tables once per artifact.
--
-- WHAT ASKS FOR IT. `projectsService.delete` (apps/api/app/projects/service.ts)
-- issues only a `projectTeam.deleteMany` and a `project.delete`. The cost is not
-- in those statements — `schema.prisma` sets no `relationMode`, so these are real
-- database cascades, and Postgres runs each referential action as a query
-- constrained on the FOREIGN KEY COLUMN ALONE. It has no `organization_id` to
-- supply, so an org-leading composite cannot serve the lookup: the planner falls
-- back to a sequential scan of the child table, once per row deleted. Ten
-- constraints on this cascade had no index leading with their FK column.
--
-- HOW THE GAP AROSE for `artifacts(project_id)`, which is the largest of them:
-- the index existed. It was created as `artifacts_project_id_idx` in
-- 20260203204426, renamed to `documents_project_id_idx` in 20260421120000 when
-- the legacy `artifacts` table vacated the name for the new parent (PLN-321 /
-- PRD-186), and dropped with that table. The parent table reclaimed the
-- `artifacts` name in 20260422180000 and was never given the index back. A grep
-- for the CREATE still finds it, which is why this looked indexed; the catalog
-- disagrees.
--
-- MEASURED (EXPLAIN ANALYZE, Postgres 16, throwaway database with every
-- migration applied. 300,000 artifacts, 400,400 artifact_activity_events,
-- 200,200 comment_threads, 200,200 artifact_links; the project under test holds
-- 200 artifacts):
--
--   DELETE FROM projects WHERE id = $1 AND organization_id = $2
--     before  Execution Time: 9929.3 ms
--               artifact_activity_events_artifact_id_fkey  time=3672.3 calls=200
--               comment_threads_artifact_id_fkey           time=2413.8 calls=200
--               artifact_links_target_id_fkey              time=2086.3 calls=200
--     after   Execution Time:   59.3 ms
--               artifact_activity_events_artifact_id_fkey  time=   5.8 calls=200
--               comment_threads_artifact_id_fkey           time=   6.1 calls=200
--               artifact_links_target_id_fkey              time=   4.7 calls=200
--
--   The single referential action, isolated:
--     before  Seq Scan on comment_threads, Rows Removed by Filter: 200199
--             Buffers: shared hit=2837     Execution Time: 28.947 ms
--     after   Index Scan using comment_threads_artifact_id_idx
--             Buffers: shared hit=8        Execution Time:  0.087 ms
--
-- THE CONTROLLED EXPERIMENT is `artifact_links`, which carries two FKs to
-- `artifacts` over the same 200,200 rows with the same 200 calls.
-- `artifact_links_source_id_fkey` was already served by the source-leading
-- `@@unique([sourceId, targetId, linkType])` and cost 9.9 ms;
-- `artifact_links_target_id_fkey` had nothing leading with `target_id` and cost
-- 2086.3 ms. Same table, same data, same call count, 211x apart — the index is
-- the only variable.
--
-- WHY THE COST IS SUPERLINEAR, and why the route fails rather than merely
-- dragging: each scan is proportional to the CHILD table's size, and it runs once
-- per artifact deleted. Cost is N_artifacts x sum(child table sizes), inside the
-- delete's transaction, holding row locks the whole time. That is the reported
-- "tanks the server on the way".
--
-- COST, stated rather than left to the reader: on the 300k-artifact slice above,
-- 2.0 MB (artifacts) + 9.7 MB (artifact_activity_events) + 6.2 MB
-- (comment_threads) + 6.2 MB (artifact_links). All ten are single-column
-- non-unique btrees on columns that are set at insert and rarely updated, so the
-- write amplification is one entry per inserted row and near-zero on update.
--
-- SCOPE, AND HOW FAR THE CASCADE ACTUALLY REACHES. `DELETE FROM projects` does
-- not stop at `artifacts`. Following ON DELETE CASCADE transitively from
-- `projects` reaches 48 tables and four levels deep, and every one of the 63
-- foreign keys pointing AT a table in that closure fires a lookup — CASCADE,
-- SET NULL, RESTRICT and NO ACTION all have to FIND the referencing rows first.
-- Ten of the 63 had no index leading with their own FK column; the other 53
-- already did. The set is taken from the live catalog (a recursive walk of
-- pg_constraint joined to pg_index on the FK's leading column) rather than from
-- migration text.
--
-- The first seven below are the depth-1 and depth-2 constraints, and they carry
-- the measurement above. The last three sit one to three hops further out and
-- were added in review, when the walk above replaced a traversal that stopped at
-- `artifacts`: `delivery_points(pull_request_detail_id)` fires
-- when a branch Artifact cascades into `pull_request_detail`,
-- `github_comment_thread_projections(branch_artifact_id)` when it cascades into
-- `branch_detail`, and `agent_component_invocations(part_id)` at the bottom of
-- the session_detail chain. They are NOT separately benchmarked — the numbers
-- above are the seven — but they are the same unserved-referential-action
-- mechanism on the same delete, so leaving them out would have left the
-- cascade's tail on sequential scans while the header claimed completeness.
--
-- CONCURRENTLY, AND THEREFORE BARE STATEMENTS ONLY IN THIS FILE. `artifacts`,
-- `artifact_activity_events` and `comment_threads` are written continuously, so a
-- plain `CREATE INDEX` would hold ACCESS EXCLUSIVE for the whole build and stall
-- that traffic at production size. `CREATE INDEX CONCURRENTLY` takes only SHARE
-- UPDATE EXCLUSIVE. It cannot run inside a transaction block (SQLSTATE 25001),
-- and `prisma migrate deploy` only splits a migration file into per-statement
-- simple queries when it can do so confidently — a `DO $$ … $$` block, embedded
-- semicolons or a `DROP INDEX CONCURRENTLY` push the whole file onto the
-- single-transaction fallback where every CONCURRENTLY statement fails 25001.
-- So this file is bare top-level CREATE INDEX CONCURRENTLY statements and
-- nothing else, following 20260820150000_iss7211_custom_field_value_facet_indexes.
--
-- NO `IF NOT EXISTS`: required by the concurrent-index lint
-- (scripts/lint/destructive-migrations/index-ddl.ts) so a retry after a cancelled
-- or crashed build fails closed on SQLSTATE 42P07 against the same-named INVALID
-- remnant instead of recording the migration APPLIED over a permanently-unusable
-- index.
--
-- RECOVERY IS OPERATOR-DRIVEN AND IS NOT "drop the remnant and re-run". Each
-- statement below commits on its own, so a build cancelled at statement k
-- leaves statements 1..k-1 as COMMITTED, VALID indexes and only statement k as
-- an INVALID remnant. Prisma still records the whole migration as failed, and a
-- naive retry re-runs the file from the top and dies on SQLSTATE 42P07 at
-- statement 1 — a `partial_committed_ddl_artifact`, exactly the state
-- docs/runbooks/prisma-deploy-migration-recovery.md exists for. Follow that
-- runbook: preserve the original deploy output, inspect ALL ten indexes in the
-- catalog (name present, `indisvalid`, key list) rather than only the one that
-- failed, drop any INVALID remnants in psql autocommit, and then choose between
-- `prisma migrate resolve --applied 20260830120000_iss8496_artifact_cascade_fk_indexes`
-- once the whole set verifies, and a corrective forward-only migration for
-- whatever is still missing. Do not mark it applied without verifying the set.
--
-- PREVIEW SCHEMAS: registered in PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS
-- (packages/database/scripts/preview-heavy-migrations-core.mjs) — these are pure
-- non-unique perf-only indexes, and CONCURRENTLY's instance-wide transaction wait
-- is the ISS-4437 P1002 advisory-lock amplifier on ephemeral `preview_*` schemas.
-- CI-enforced by packages/database/__tests__/preview-heavy-migrations.test.ts.
--
-- Purely additive: non-unique indexes change plan choice only, never results.
-- No existing index or constraint is dropped or altered.

-- CreateIndex
CREATE INDEX CONCURRENTLY "artifacts_project_id_idx" ON "artifacts"("project_id");

-- CreateIndex
CREATE INDEX CONCURRENTLY "artifact_activity_events_artifact_id_idx" ON "artifact_activity_events"("artifact_id");

-- CreateIndex
CREATE INDEX CONCURRENTLY "comment_threads_artifact_id_idx" ON "comment_threads"("artifact_id");

-- CreateIndex
CREATE INDEX CONCURRENTLY "artifact_links_target_id_idx" ON "artifact_links"("target_id");

-- CreateIndex
CREATE INDEX CONCURRENTLY "delivery_point_artifacts_artifact_id_idx" ON "delivery_point_artifacts"("artifact_id");

-- CreateIndex
CREATE INDEX CONCURRENTLY "delivery_points_branch_artifact_id_idx" ON "delivery_points"("branch_artifact_id");

-- CreateIndex
CREATE INDEX CONCURRENTLY "monitored_activity_quarantine_session_artifact_idx" ON "monitored_session_activity_quarantine"("session_artifact_id");

-- CreateIndex
CREATE INDEX CONCURRENTLY "delivery_points_pull_request_detail_id_idx" ON "delivery_points"("pull_request_detail_id");

-- CreateIndex
CREATE INDEX CONCURRENTLY "github_comment_thread_projections_branch_artifact_id_idx" ON "github_comment_thread_projections"("branch_artifact_id");

-- CreateIndex
CREATE INDEX CONCURRENTLY "agent_component_invocations_part_id_idx" ON "agent_component_invocations"("part_id");
