-- clear-local-sessions.sql — FEA-3538
-- Clear ALL harness-session data from the LOCAL desktop store. Run from a SQLite
-- client against the libSQL file `agent-dashboard.sqlite`:
--   macOS:   ~/Library/Application Support/Closedloop/agent-dashboard.sqlite
--   Windows: %APPDATA%\Closedloop\agent-dashboard.sqlite
--   Linux:   ~/.config/Closedloop/agent-dashboard.sqlite
-- (NOT the legacy `agent-dashboard.pgdata` directory.)
--
-- QUIT the Closedloop app first — it holds the WAL write lock while running.
--
-- DESTRUCTIVE. Deletes everything downstream of the transcript parsers (the
-- collected sessions and every derived/child row). PRESERVES the database schema,
-- the agent-component catalog (agent_packs / skills / pack_catalog), model
-- pricing, repos, and settings. The next app launch re-derives session history
-- from the on-disk agent-CLI transcripts.
--
-- Also clears the sync cursors (sync_state, transcript_sync_state) so the
-- desktop re-syncs everything to the web from scratch after the wipe.
--
-- Rows are deleted child-before-parent, so this works whether or not the client
-- has `PRAGMA foreign_keys` enabled. Each DELETE reports its own row count.

BEGIN TRANSACTION;

DELETE FROM events;
DELETE FROM token_events;
DELETE FROM session_activity_segments;
DELETE FROM session_turn_bucket;
DELETE FROM token_usage;
DELETE FROM codex_trace_span;
DELETE FROM claude_code_cost_event;
DELETE FROM claude_code_permission_event;
DELETE FROM claude_code_api_request;
DELETE FROM session_artifact_links;
DELETE FROM artifact_link_backfill_seen;
DELETE FROM activity_segment_backfill_seen;
DELETE FROM pull_requests;
DELETE FROM pr_backfill_seen;
DELETE FROM session_analytics;
DELETE FROM session_tool_analytics;
DELETE FROM agent_component_session_usage;
DELETE FROM agents;
DELETE FROM agent_session_sync_outbox;
DELETE FROM sessions;

-- Sync cursors (not session-FK'd) — cleared so re-sync starts fresh.
DELETE FROM sync_state;
DELETE FROM transcript_sync_state;

COMMIT;
