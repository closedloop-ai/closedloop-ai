-- ISS-12439: the Sessions list's Harness, Model and Priority facets are read
-- from `sessions.harness`, `sessions.model` and `sessions.priority` (the Owner
-- facet already has `idx_sessions_user_id`). Without an index each facet's
-- COUNT(*) scans the table. Plain, not partial: the "unknown" Harness/Model
-- option and the unset Priority option select the NULL rows.
CREATE INDEX IF NOT EXISTS "idx_sessions_harness" ON "sessions"("harness");
CREATE INDEX IF NOT EXISTS "idx_sessions_model" ON "sessions"("model");
CREATE INDEX IF NOT EXISTS "idx_sessions_priority" ON "sessions"("priority");
