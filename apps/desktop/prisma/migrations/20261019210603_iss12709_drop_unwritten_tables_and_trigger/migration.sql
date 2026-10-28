-- ISS-12709 (1 of 2): ISS-12638 item 1, the planned pass that deletes the columns and
-- tables nothing writes. Operator ruling 2026-10-19, from a column-by-column
-- review of the desktop schema.
--
-- `pull_request_status_observations` and `pr_backfill_seen` have no production
-- writer. Dropping a table drops its indexes and triggers with it, including the
-- three `invalidate_session_list_trace_projection_pr_status_*` triggers.
DROP TABLE IF EXISTS "pull_request_status_observations";
DROP TABLE IF EXISTS "pr_backfill_seen";
-- `artifacts` columns the removed projection and enrichment once filled. Two
-- partial indexes name `head_sha` and `merge_commit_sha`, and one trigger names
-- `pr_state`, `lines_added`, `lines_removed` and `files_changed`; SQLite refuses
-- to drop a column an index or trigger references, so they go first and the
-- trigger is re-created without the dropped columns.
DROP INDEX IF EXISTS "idx_artifacts_head_sha_p7";
DROP INDEX IF EXISTS "idx_artifacts_merge_commit_sha_p7";
DROP TRIGGER IF EXISTS "invalidate_session_list_trace_projection_artifact_update";
CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_artifact_update"
AFTER UPDATE OF
  "kind",
  "slug",
  "repo_full_name",
  "pr_number",
  "url",
  "title",
  "committed_at",
  "observed_at",
  "sha",
  "branch_name",
  "base_ref",
  "priority"
ON "artifacts"
WHEN OLD."kind" IS NOT NEW."kind"
  OR OLD."slug" IS NOT NEW."slug"
  OR OLD."repo_full_name" IS NOT NEW."repo_full_name"
  OR OLD."pr_number" IS NOT NEW."pr_number"
  OR OLD."url" IS NOT NEW."url"
  OR OLD."title" IS NOT NEW."title"
  OR OLD."committed_at" IS NOT NEW."committed_at"
  OR OLD."observed_at" IS NOT NEW."observed_at"
  OR OLD."sha" IS NOT NEW."sha"
  OR OLD."branch_name" IS NOT NEW."branch_name"
  OR OLD."base_ref" IS NOT NEW."base_ref"
  OR OLD."priority" IS NOT NEW."priority"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" IN (
    SELECT "session_id" FROM "session_artifact_links"
    WHERE "artifact_id" IN (OLD."id", NEW."id")
  );
END;
--
-- The column drops are the next migration: the heal path splits statements on
-- `;` and cannot carry a trigger body, so the trigger lives here with only
-- idempotent statements.
