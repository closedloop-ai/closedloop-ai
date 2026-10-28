-- ISS-7352: capture list C (MCP / auth / plugin lifecycle) and G (the counters
-- we approximated but did not carry natively). Purely additive -- six new
-- tables, no existing row rewritten and no existing column changed.
--
-- Every key column that flattens a tuple of optional attributes is NOT NULL
-- with a "" default. SQLite treats NULLs as DISTINCT in a UNIQUE index, so a
-- nullable key column would make every row carrying one unique against itself
-- and turn the persister's upsert into a duplicate insert on every export.

-- CreateTable: ISS-7352 item C, MCP server connection attempts.
CREATE TABLE IF NOT EXISTS "claude_code_mcp_server_connection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "observed_at" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "connection_key" TEXT NOT NULL DEFAULT '',
    "transport_type" TEXT,
    "server_scope" TEXT,
    "duration_ms" INTEGER,
    "error_code" TEXT,
    "is_plugin" BOOLEAN,
    "plugin_id_hash" TEXT,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);

-- CreateTable: ISS-7352 item C, auth actions.
CREATE TABLE IF NOT EXISTS "claude_code_auth_event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "observed_at" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "occurrence_key" TEXT NOT NULL DEFAULT '',
    "success" BOOLEAN,
    "auth_method" TEXT,
    "error_category" TEXT,
    "status_code" INTEGER,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);

-- CreateTable: ISS-7352 item C, plugin install / load.
CREATE TABLE IF NOT EXISTS "claude_code_plugin_event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "lifecycle" TEXT NOT NULL,
    "observed_at" TEXT NOT NULL,
    "plugin_key" TEXT NOT NULL DEFAULT '',
    "plugin_name" TEXT,
    "plugin_version" TEXT,
    "marketplace_name" TEXT,
    "marketplace_is_official" BOOLEAN,
    "install_trigger" TEXT,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);

-- CreateTable: ISS-7352 item G, lines-of-code churn by direction and model.
CREATE TABLE IF NOT EXISTS "claude_code_lines_of_code" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "observed_at" TEXT NOT NULL,
    "change_type" TEXT NOT NULL,
    "line_count" BIGINT NOT NULL DEFAULT 0,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);

-- CreateTable: ISS-7352 item G, session starts by start_type.
CREATE TABLE IF NOT EXISTS "claude_code_session_start" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "observed_at" TEXT NOT NULL,
    "start_type" TEXT NOT NULL,
    "session_count" BIGINT NOT NULL DEFAULT 0,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);

-- CreateTable: ISS-7352 item G, the result side of a tool invocation.
CREATE TABLE IF NOT EXISTS "claude_code_tool_result" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "observed_at" TEXT NOT NULL,
    "result_key" TEXT NOT NULL DEFAULT '',
    "tool_use_id" TEXT,
    "success" BOOLEAN,
    "error_type" TEXT,
    "tool_input_size_bytes" BIGINT,
    "tool_result_size_bytes" BIGINT,
    "mcp_server_scope" TEXT,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_mcp_server_connection_session" ON "claude_code_mcp_server_connection"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_mcp_server_connection_observed" ON "claude_code_mcp_server_connection"("observed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_mcp_server_connection_natural" ON "claude_code_mcp_server_connection"("session_id", "observed_at", "status", "connection_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_auth_event_session" ON "claude_code_auth_event"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_auth_event_observed" ON "claude_code_auth_event"("observed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_auth_event_natural" ON "claude_code_auth_event"("session_id", "observed_at", "action", "occurrence_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_plugin_event_session" ON "claude_code_plugin_event"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_plugin_event_observed" ON "claude_code_plugin_event"("observed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_plugin_event_natural" ON "claude_code_plugin_event"("session_id", "lifecycle", "observed_at", "plugin_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_lines_of_code_session" ON "claude_code_lines_of_code"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_lines_of_code_observed" ON "claude_code_lines_of_code"("observed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_lines_of_code_natural" ON "claude_code_lines_of_code"("session_id", "model", "observed_at", "change_type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_session_start_session" ON "claude_code_session_start"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_session_start_observed" ON "claude_code_session_start"("observed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_session_start_natural" ON "claude_code_session_start"("session_id", "observed_at", "start_type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_tool_result_session" ON "claude_code_tool_result"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_tool_result_observed" ON "claude_code_tool_result"("observed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_tool_result_natural" ON "claude_code_tool_result"("session_id", "tool_name", "observed_at", "result_key");
