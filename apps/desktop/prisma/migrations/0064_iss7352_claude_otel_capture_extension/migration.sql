-- ISS-7352: extend the Claude Code OTel capture model over capture list A, B
-- and E. Additive throughout: new nullable columns with defaults on an existing
-- table, plus two new tables. No existing row is rewritten and no existing
-- column changes type.

-- AlterTable: ISS-7352 item E, harness-stamped component attribution on the
-- cost counter. `attribution_key` is NOT NULL with a "" default because it
-- joins the natural key below, and SQLite treats NULLs as DISTINCT in a UNIQUE
-- index -- a nullable key column would make every unattributed row unique
-- against itself and turn the persister's upsert into a duplicate insert.
-- Rows written before this migration take the "" default and are therefore
-- correctly identified as unattributed.
ALTER TABLE "claude_code_cost_event" ADD COLUMN "attribution_key" TEXT NOT NULL DEFAULT '';
ALTER TABLE "claude_code_cost_event" ADD COLUMN "attribution_source" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "claude_code_cost_event" ADD COLUMN "agent_name" TEXT;
ALTER TABLE "claude_code_cost_event" ADD COLUMN "skill_name" TEXT;
ALTER TABLE "claude_code_cost_event" ADD COLUMN "plugin_name" TEXT;
ALTER TABLE "claude_code_cost_event" ADD COLUMN "marketplace_name" TEXT;
ALTER TABLE "claude_code_cost_event" ADD COLUMN "mcp_server_name" TEXT;
ALTER TABLE "claude_code_cost_event" ADD COLUMN "mcp_tool_name" TEXT;
ALTER TABLE "claude_code_cost_event" ADD COLUMN "query_source" TEXT;
ALTER TABLE "claude_code_cost_event" ADD COLUMN "speed" TEXT;
ALTER TABLE "claude_code_cost_event" ADD COLUMN "effort" TEXT;

-- DropIndex + CreateIndex: widen the natural key by `attribution_key`. Two
-- data points that differ only in which component they are attributed to used
-- to land on one key, where the upsert REPLACES cost rather than adding to it,
-- so one component's spend silently erased another's. Widening a unique key
-- can only ever split existing rows apart, never collide them, so this is safe
-- against rows already written under the old key.
DROP INDEX IF EXISTS "idx_claude_code_cost_event_natural";
CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_cost_event_natural" ON "claude_code_cost_event"("session_id", "model", "observed_at", "attribution_key");

-- CreateTable: ISS-7352 item A, the error/refusal taxonomy.
CREATE TABLE IF NOT EXISTS "claude_code_error_event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "error_kind" TEXT NOT NULL,
    "observed_at" TEXT NOT NULL,
    "occurrence_key" TEXT NOT NULL DEFAULT '',
    "model" TEXT,
    "status_code" INTEGER,
    "attempt" INTEGER,
    "error_category" TEXT,
    "duration_ms" INTEGER,
    "request_id" TEXT,
    "client_request_id" TEXT,
    "refusal_category" TEXT,
    "server_fallback_hop" INTEGER,
    "has_category" BOOLEAN,
    "has_explanation" BOOLEAN,
    "error_name" TEXT,
    "error_code" TEXT,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);

-- CreateTable: ISS-7352 item B, permission mode transitions.
CREATE TABLE IF NOT EXISTS "claude_code_permission_mode_change" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "observed_at" TEXT NOT NULL,
    "from_mode" TEXT NOT NULL,
    "to_mode" TEXT NOT NULL,
    "trigger" TEXT,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_error_event_session" ON "claude_code_error_event"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_error_event_observed" ON "claude_code_error_event"("observed_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_error_event_kind_observed" ON "claude_code_error_event"("error_kind", "observed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_error_event_natural" ON "claude_code_error_event"("session_id", "error_kind", "observed_at", "occurrence_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_permission_mode_change_session" ON "claude_code_permission_mode_change"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_permission_mode_change_observed" ON "claude_code_permission_mode_change"("observed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_permission_mode_change_natural" ON "claude_code_permission_mode_change"("session_id", "observed_at", "from_mode", "to_mode");
