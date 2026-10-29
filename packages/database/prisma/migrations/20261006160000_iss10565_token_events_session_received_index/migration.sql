-- ISS-10565: the Branch analytics refresh pass asks, per session, "was any
-- event received since this session was materialized?"
-- (`branchSessionReceivedSinceMaterializedSql`). `created_at` is RECEIVE time;
-- the existing `(agent_session_id, event_created_at)` index orders by OCCURRENCE
-- time, which bounds nothing here (81% of events arrive more than six hours
-- after they occurred), so without this index every probe reads the session's
-- whole history. That full read, twice per pass, is what timed the largest
-- organization's refresh out against its 60s transaction.
--
-- CONCURRENTLY, so this file is ONE bare statement: do not add BEGIN/COMMIT or a
-- `DO` block. NO `IF NOT EXISTS`, per scripts/lint/destructive-migrations/
-- index-ddl.ts: a retry over an INVALID remnant must fail closed (42P07).
-- Registered in PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS: non-unique and
-- perf-only, so it changes plan choice and never results.

-- CreateIndex
CREATE INDEX CONCURRENTLY "agent_session_token_events_agent_session_id_created_at_idx" ON "agent_session_token_events"("agent_session_id", "created_at");
