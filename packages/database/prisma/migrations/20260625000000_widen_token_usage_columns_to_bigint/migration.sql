-- Widen synced token-usage counters from int4 to int8 so desktop sessions whose
-- per-model or summed token counts exceed 2,147,483,647 no longer fail the entire
-- session upsert with a Postgres "integer out of range" error. The desktop SQLite
-- side already stores these as BigInt (up to Number.MAX_SAFE_INTEGER); this aligns
-- the cloud sinks. int4 -> int8 is a lossless widening cast, so no USING clause is
-- needed and the existing DEFAULT 0 constraints are preserved. Note: changing the
-- on-disk column width does rewrite each table under a brief ACCESS EXCLUSIVE lock;
-- acceptable here, but worth scheduling deliberately if these tables grow large.

-- AlterTable
ALTER TABLE "session_detail"
  ALTER COLUMN "input_tokens" SET DATA TYPE BIGINT,
  ALTER COLUMN "output_tokens" SET DATA TYPE BIGINT,
  ALTER COLUMN "cache_read_tokens" SET DATA TYPE BIGINT,
  ALTER COLUMN "cache_write_tokens" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "agent_session_token_usage"
  ALTER COLUMN "input_tokens" SET DATA TYPE BIGINT,
  ALTER COLUMN "output_tokens" SET DATA TYPE BIGINT,
  ALTER COLUMN "cache_read_tokens" SET DATA TYPE BIGINT,
  ALTER COLUMN "cache_write_tokens" SET DATA TYPE BIGINT;
