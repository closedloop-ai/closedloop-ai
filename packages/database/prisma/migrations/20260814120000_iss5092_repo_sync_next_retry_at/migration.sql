-- ISS-5092: Add exponential backoff timestamp to github_repo_sync_state.
-- Nullable so existing rows are "eligible now" (NULL passes the OR filter).
ALTER TABLE "github_repo_sync_state" ADD COLUMN "next_retry_at" TIMESTAMP(3);
