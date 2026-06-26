-- AlterTable
ALTER TABLE "branch_detail" ADD COLUMN     "last_activity_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "session_detail" ADD COLUMN     "last_activity_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "branch_detail_last_activity_at_idx" ON "branch_detail"("last_activity_at");

-- CreateIndex
CREATE INDEX "session_detail_compute_target_id_last_activity_at_idx" ON "session_detail"("compute_target_id", "last_activity_at");

-- Data backfill (hand-written; Prisma cannot express it). PLN-1034.
-- Seed last_activity_at from GENUINE activity only, so the new default sort is
-- meaningful for rows that predate the write-path wiring.

-- Sessions: latest agent event time, floored at the session start. Sessions
-- with no events fall back to their start time. Deliberately NOT
-- session_updated_at (polluted by desktop OTEL ingest / enrichment / sync).
UPDATE "session_detail" sd
SET "last_activity_at" = GREATEST(
  sd."session_started_at",
  COALESCE(
    (
      SELECT MAX(e."event_created_at")
      FROM "agent_session_events" e
      WHERE e."agent_session_id" = sd."artifact_id"
    ),
    sd."session_started_at"
  )
);

-- Branches: GREATEST of real git/GitHub events — a pushed commit
-- (head_sha_observed_at), the current PR's merge/close time, and the latest PR
-- review submission — falling back to the branch artifact's creation time.
-- GREATEST() ignores NULL inputs, and artifacts.created_at is non-null, so the
-- result is never NULL. Deliberately excludes CI checks, file/checks cache
-- refreshes, sync bookkeeping, and pull_request_detail.updated_at (an @updatedAt
-- row-write timestamp, not a GitHub activity time).
-- Correlated scalar subqueries (not UPDATE..FROM joins) so each may reference
-- the target row `bd`; PostgreSQL forbids referencing the UPDATE target inside a
-- FROM-clause join condition.
UPDATE "branch_detail" bd
SET "last_activity_at" = GREATEST(
  (SELECT a."created_at" FROM "artifacts" a WHERE a."id" = bd."artifact_id"),
  bd."head_sha_observed_at",
  (
    SELECT pr."merged_at" FROM "pull_request_detail" pr
    WHERE pr."id" = bd."current_pull_request_detail_id"
  ),
  (
    SELECT pr."closed_at" FROM "pull_request_detail" pr
    WHERE pr."id" = bd."current_pull_request_detail_id"
  ),
  (
    SELECT MAX(r."submitted_at") FROM "github_pr_reviews" r
    WHERE r."pull_request_id" = bd."current_pull_request_detail_id"
  )
);
