-- Desktop-local durable trace comments. Cloud comment/thread ids are attached
-- after best-effort sync so commenting works while offline or before a local
-- session has resolved to a cloud artifact.
CREATE TABLE IF NOT EXISTS "trace_comments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "thread_id" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "artifact_id" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "anchor" JSONB NOT NULL,
  "body" TEXT NOT NULL,
  "author_id" TEXT NOT NULL,
  "author_name" TEXT,
  "author_avatar_url" TEXT,
  "cloud_comment_id" TEXT,
  "cloud_thread_id" TEXT,
  "sync_status" TEXT NOT NULL DEFAULT 'local_pending',
  "last_sync_attempt_at" TEXT,
  "sync_error" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_trace_comments_target"
  ON "trace_comments"("target_type", "target_id", "created_at", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_trace_comments_cloud_comment"
  ON "trace_comments"("cloud_comment_id")
  WHERE cloud_comment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_trace_comments_sync_status"
  ON "trace_comments"("sync_status");
