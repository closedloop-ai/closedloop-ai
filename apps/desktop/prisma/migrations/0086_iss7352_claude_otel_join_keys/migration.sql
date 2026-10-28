-- ISS-7352 item F, JOIN-KEY half — the per-event keys that join a Claude Code
-- OTel row back to Anthropic's own records and to each other.
--
-- Item F's OTHER half, the per-session identity block (`organization.id`,
-- `user.account_uuid`, `user.account_id`, …), is deliberately NOT here: open
-- question #4 leaves the content/PII decision unanswered, and `user.email` /
-- `user.groups` ride on the same records. There is no `claude_code_session_
-- identity` table in this migration and none is implied by it.
--
-- Purely additive: new NULLABLE columns on eight existing tables, no new table,
-- no existing row rewritten, no existing column changed in type, nullability or
-- default. An install that has not yet taken this migration keeps working; a
-- row written before it reads NULL, which means "not captured", never "absent
-- from the producer".
--
-- NONE of these columns joins a natural key, and that is load-bearing rather
-- than incidental. SQLite treats NULLs as DISTINCT in a UNIQUE index, so a
-- nullable key column would make every row carrying one unique against itself
-- and turn the persister's upsert into a duplicate insert on every export.
-- They are compared in memory by `sameEventCorrelation` /
-- `samePermissionDecisionOutcome` instead, which is what makes a
-- provably-distinct collision COUNTABLE in `unusable` (ISS-7481) rather than a
-- silent overwrite.
--
-- The four counter-sourced tables (`claude_code_cost_event`,
-- `claude_code_lines_of_code`, `claude_code_session_start`,
-- `claude_code_active_time`) are deliberately absent: Claude Code documents
-- these four attributes as events-only, because their cardinality is unbounded.
-- Their absence there is the producer's design, not a gap.

-- AlterTable: ISS-7481 — `tool_use_id` is the harness's own identifier for the
-- invocation a decision is about, and the join to this call's
-- `claude_code_tool_result` row.
ALTER TABLE "claude_code_permission_event" ADD COLUMN "tool_use_id" TEXT;
ALTER TABLE "claude_code_permission_event" ADD COLUMN "prompt_id" TEXT;
ALTER TABLE "claude_code_permission_event" ADD COLUMN "message_uuid" TEXT;
ALTER TABLE "claude_code_permission_event" ADD COLUMN "workflow_run_id" TEXT;
ALTER TABLE "claude_code_permission_event" ADD COLUMN "workflow_name" TEXT;

-- AlterTable: `request_id` is Anthropic's own identifier for the request. This
-- table's natural key uses a DERIVED `started_at` (the completion stamp less
-- the duration, at millisecond resolution), so these ids are the strongest
-- evidence it has that a collision is two requests rather than one re-sent.
ALTER TABLE "claude_code_api_request" ADD COLUMN "request_id" TEXT;
ALTER TABLE "claude_code_api_request" ADD COLUMN "client_request_id" TEXT;
ALTER TABLE "claude_code_api_request" ADD COLUMN "prompt_id" TEXT;
ALTER TABLE "claude_code_api_request" ADD COLUMN "message_uuid" TEXT;
ALTER TABLE "claude_code_api_request" ADD COLUMN "workflow_run_id" TEXT;
ALTER TABLE "claude_code_api_request" ADD COLUMN "workflow_name" TEXT;

-- AlterTable: the remaining event-sourced tables take the four correlation keys
-- and nothing else.
ALTER TABLE "claude_code_error_event" ADD COLUMN "prompt_id" TEXT;
ALTER TABLE "claude_code_error_event" ADD COLUMN "message_uuid" TEXT;
ALTER TABLE "claude_code_error_event" ADD COLUMN "workflow_run_id" TEXT;
ALTER TABLE "claude_code_error_event" ADD COLUMN "workflow_name" TEXT;

ALTER TABLE "claude_code_permission_mode_change" ADD COLUMN "prompt_id" TEXT;
ALTER TABLE "claude_code_permission_mode_change" ADD COLUMN "message_uuid" TEXT;
ALTER TABLE "claude_code_permission_mode_change" ADD COLUMN "workflow_run_id" TEXT;
ALTER TABLE "claude_code_permission_mode_change" ADD COLUMN "workflow_name" TEXT;

ALTER TABLE "claude_code_mcp_server_connection" ADD COLUMN "prompt_id" TEXT;
ALTER TABLE "claude_code_mcp_server_connection" ADD COLUMN "message_uuid" TEXT;
ALTER TABLE "claude_code_mcp_server_connection" ADD COLUMN "workflow_run_id" TEXT;
ALTER TABLE "claude_code_mcp_server_connection" ADD COLUMN "workflow_name" TEXT;

ALTER TABLE "claude_code_auth_event" ADD COLUMN "prompt_id" TEXT;
ALTER TABLE "claude_code_auth_event" ADD COLUMN "message_uuid" TEXT;
ALTER TABLE "claude_code_auth_event" ADD COLUMN "workflow_run_id" TEXT;
ALTER TABLE "claude_code_auth_event" ADD COLUMN "workflow_name" TEXT;

ALTER TABLE "claude_code_plugin_event" ADD COLUMN "prompt_id" TEXT;
ALTER TABLE "claude_code_plugin_event" ADD COLUMN "message_uuid" TEXT;
ALTER TABLE "claude_code_plugin_event" ADD COLUMN "workflow_run_id" TEXT;
ALTER TABLE "claude_code_plugin_event" ADD COLUMN "workflow_name" TEXT;

ALTER TABLE "claude_code_tool_result" ADD COLUMN "prompt_id" TEXT;
ALTER TABLE "claude_code_tool_result" ADD COLUMN "message_uuid" TEXT;
ALTER TABLE "claude_code_tool_result" ADD COLUMN "workflow_run_id" TEXT;
ALTER TABLE "claude_code_tool_result" ADD COLUMN "workflow_name" TEXT;
