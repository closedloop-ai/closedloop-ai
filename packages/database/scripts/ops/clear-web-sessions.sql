-- clear-web-sessions.sql — FEA-3538
-- Clear ALL harness-session data from the WEB (cloud Postgres) database, across
-- EVERY organization. Run from a psql / database client against the target DB.
--
-- DESTRUCTIVE and GLOBAL. There is no org filter. Confirm you are pointed at the
-- intended database (dev / preview / prod) before running.
--
-- What it deletes:
--   * artifacts WHERE type = 'SESSION' — the harness session itself. Postgres
--     ON DELETE CASCADE then removes session_detail and every agent-session
--     child (agent_session_events, agent_session_token_events,
--     agent_session_token_usage, agent_session_usage_rollups,
--     agent_component_session_usage), plus session-scoped artifact links/comments.
--
-- What it does NOT touch:
--   * session_transcript — intentionally kept. Its FK to session_detail is
--     ON DELETE SET NULL, so the artifact delete only nulls the link; the
--     transcript rows persist and re-link when the session re-syncs.
--   * desktop_sessions — device AUTH sessions (gateway bindings / refresh
--     tokens). Deleting them would sign every desktop out. Left alone.
--   * Any non-SESSION artifact type (documents, branches, deployments).
--
-- The DELETE reports its own affected-row count.

BEGIN;

DELETE FROM artifacts WHERE type = 'SESSION';

COMMIT;
