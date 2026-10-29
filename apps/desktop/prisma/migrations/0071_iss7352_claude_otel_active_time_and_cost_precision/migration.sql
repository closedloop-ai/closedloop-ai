-- ISS-7352 capture list D, the GA half. The published reference gates only the
-- TRACE tier behind CLAUDE_CODE_ENHANCED_TELEMETRY_BETA, so
-- `claude_code.active_time.total` (a metric) and `cost_usd_micros` (an
-- attribute on the `api_request` event) need no beta dependency. The rest of
-- item D -- ttft_ms, stop_reason, gen_ai.response.finish_reasons,
-- response.has_tool_call -- does, and is not captured here.
--
-- Purely additive: one new table and one new nullable column. No existing row
-- is rewritten and no existing column changes type.

-- AlterTable: the producer's own exact-integer spelling of a cost we already
-- store as a binary float. Nullable rather than defaulted to 0, because a row
-- written before this column -- or by a Claude Code that never stamps the
-- attribute -- has an UNKNOWN exact cost, and a 0 there would read as a free
-- request.
ALTER TABLE "claude_code_api_request" ADD COLUMN "cost_usd_micros" BIGINT;

-- CreateTable: active time, split by whose it was.
--
-- `activity_type` is NOT NULL and part of the natural key. Unlike the flattened
-- key columns on the sibling capture tables it needs no "" default: it is a
-- required attribute the normalizer refuses a point without, so no row can
-- reach here carrying an absent one.
CREATE TABLE IF NOT EXISTS "claude_code_active_time" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "observed_at" TEXT NOT NULL,
    "activity_type" TEXT NOT NULL,
    "seconds" DECIMAL NOT NULL DEFAULT 0,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_active_time_session" ON "claude_code_active_time"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_active_time_observed" ON "claude_code_active_time"("observed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_active_time_natural" ON "claude_code_active_time"("session_id", "observed_at", "activity_type");
