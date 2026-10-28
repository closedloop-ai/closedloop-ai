-- ISS-9584 — covering index for the last-activity tie narrowing.
--
-- The Sessions list's last-activity sort now narrows a tie by start time
-- descending, then id descending, as the cloud's SESSION_DEFAULT_ORDER_BY does
-- (owner ruling on PR #7961, item 4). `idx_sessions_last_activity` keys only
-- (last_activity_at, id), so that order would need a full temp B-tree sort.
-- This index supplies all three terms. Both reads order by the bare
-- `started_at` column so the planner can use it. The cursor page pins it
-- (`listCursorPageSortSql`): unpinned, SQLite full-sorts the ASC direction.

CREATE INDEX IF NOT EXISTS "idx_sessions_last_activity_started" ON "sessions"("last_activity_at" DESC, "started_at" DESC, "id" DESC);
