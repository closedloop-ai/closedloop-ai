-- ISS-7352 capture list D, beta tier: one `claude_code.llm_request` span.
--
-- The only carrier of `ttft_ms`, `stop_reason`, `gen_ai.response.finish_reasons`
-- and `response.has_tool_call` — no metric and no GA event stamps them. Spans
-- only arrive when the user has set `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`;
-- nothing in this lane sets it, so with the beta off this table stays empty.
--
-- Keyed on `(trace_id, span_id)`, the producer's own identity for a request, so
-- a retried OTLP batch upserts rather than doubling the table.
--
-- No column holds a span's `status.message` or its span events: both are
-- free-text content (a `tool.output` span event carries request and response
-- bodies under `OTEL_LOG_TOOL_CONTENT=1`), and neither is read.
CREATE TABLE IF NOT EXISTS "claude_code_llm_request" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "trace_id" TEXT NOT NULL,
    "span_id" TEXT NOT NULL,
    "parent_span_id" TEXT,
    "started_at" TEXT NOT NULL,
    "model" TEXT,
    "query_source" TEXT,
    "speed" TEXT,
    "request_context" TEXT,
    "duration_ms" INTEGER,
    "ttft_ms" INTEGER,
    "stop_reason" TEXT,
    "finish_reasons" TEXT,
    "response_has_tool_call" BOOLEAN,
    "attempt" INTEGER,
    "success" BOOLEAN,
    "status_code" INTEGER,
    "request_id" TEXT,
    "client_request_id" TEXT,
    "response_id" TEXT,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_creation_tokens" BIGINT NOT NULL DEFAULT 0,
    "agent_id" TEXT,
    "parent_agent_id" TEXT,
    "workflow_run_id" TEXT,
    "workflow_name" TEXT,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_claude_code_llm_request_session" ON "claude_code_llm_request"("session_id");
CREATE INDEX IF NOT EXISTS "idx_claude_code_llm_request_started" ON "claude_code_llm_request"("started_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_llm_request_natural" ON "claude_code_llm_request"("trace_id", "span_id");
