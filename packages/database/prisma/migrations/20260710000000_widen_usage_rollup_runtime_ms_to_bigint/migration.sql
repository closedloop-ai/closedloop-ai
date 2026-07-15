-- Widen the synced per-session usage-rollup runtime counter from int4 to int8.
-- The desktop syncs `runtime_ms` as wall-clock session duration in milliseconds,
-- which crosses int4's 2,147,483,647 ceiling after a session stays open longer
-- than ~24.86 days, making the `persistSessionAnalytics` upsert fail the entire
-- session sync with a Postgres "integer out of range" error. The sibling token
-- counters in this table were already widened to int8 (see
-- 20260625000000_widen_token_usage_columns_to_bigint); this aligns runtime_ms
-- with them. int4 -> int8 is a lossless widening cast, so no USING clause is
-- needed and the column stays nullable. Note: changing the on-disk column width
-- rewrites the table under a brief ACCESS EXCLUSIVE lock; acceptable here, but
-- worth scheduling deliberately if this table grows large.

-- AlterTable
ALTER TABLE "agent_session_usage_rollups"
  ALTER COLUMN "runtime_ms" SET DATA TYPE BIGINT;
