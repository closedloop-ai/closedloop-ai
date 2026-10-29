-- ISS-12209: two-way sync of a session's name with the title the user gave it
-- inside its harness (Claude Code `custom-title`, Codex thread name).
--
-- `harness_title` is the latest observed title; `harness_title_delivered` is the
-- value the cloud is known to hold, the push lane's watermark. A row is owed a
-- push when the two differ and the title is not null.
--
-- `harness_title_baselined = 0` marks a row with history the lane never saw: its
-- first observation seeds the watermark instead of pushing, so this migration
-- never reads as a rename of every titled session. New rows default to 1 — a row
-- the live hook path creates is a live session with no backlog, so its first
-- rename is owed. (A row the IMPORT creates is seeded explicitly at import.)
ALTER TABLE "sessions" ADD COLUMN "harness_title" TEXT;
ALTER TABLE "sessions" ADD COLUMN "harness_title_delivered" TEXT;
ALTER TABLE "sessions" ADD COLUMN "harness_title_baselined" INTEGER NOT NULL DEFAULT 1;
UPDATE "sessions" SET "harness_title_baselined" = 0;

-- The push lane's page read: owed rows only, which is almost always none.
CREATE INDEX IF NOT EXISTS "idx_sessions_harness_title_owed" ON "sessions"("id") WHERE harness_title IS NOT NULL AND harness_title IS NOT harness_title_delivered;

-- The pull lane's position in `GET /agent-sessions/renames`, per signed-in
-- account so an account switch never resumes another account's cursor.
CREATE TABLE IF NOT EXISTS "harness_title_feed_cursors" (
  "account_key" TEXT NOT NULL PRIMARY KEY,
  "cursor" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
