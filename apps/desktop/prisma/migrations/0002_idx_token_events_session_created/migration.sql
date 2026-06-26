CREATE INDEX IF NOT EXISTS "idx_token_events_session_created" ON "token_events"("session_id", "created_at");
