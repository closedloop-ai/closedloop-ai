-- Scope trace-comment cloud sync to the active desktop profile/account. Rows
-- created before this migration stay unscoped for local compatibility; new rows
-- write these columns and cloud reconciliation/pending retry filters by them.
ALTER TABLE "trace_comments"
  ADD COLUMN "profile_id" TEXT;

ALTER TABLE "trace_comments"
  ADD COLUMN "sync_compute_target_id" TEXT;

ALTER TABLE "trace_comments"
  ADD COLUMN "sync_user_id" TEXT;

ALTER TABLE "trace_comments"
  ADD COLUMN "sync_organization_id" TEXT;

CREATE INDEX IF NOT EXISTS "idx_trace_comments_sync_scope" ON "trace_comments"("profile_id", "sync_compute_target_id", "sync_user_id", "sync_organization_id");
