-- FEA-3132: materialize per-turn buckets at ingest so the Insights autonomy
-- trend + activity heatmap no longer json_each-expand every message of every
-- in-window session on EVERY dashboard load (the hot, expensive read that was
-- implicated in the db-host native crash under concurrent load). One row per
-- (session, message-timestamp, resolved turn_kind); the read becomes a small
-- indexed GROUP BY.
--
-- Timezone contract (mirrors session_analytics.started_day, write-core.ts):
-- `ts` is stored as the RAW UTC ISO `$.timestamp` verbatim, NOT a local
-- day/hour. The read re-buckets with strftime(ts,'localtime'), so a user
-- changing OS timezone / DST is automatically correct with no rebuild.
--
-- `turn_kind` pre-resolves the read-side role+headless predicate to a single
-- enum ('human'|'agent'): human = role='human' AND headless=0; agent =
-- role='assistant' OR (role='human' AND headless=1). headless is the READ
-- path's classifier (entrypoint LIKE 'sdk%' OR '%exec%'), NOT the analytics
-- rollup's headlessMetadataSql — reproducing the read predicate is what keeps
-- the charts byte-identical.
--
-- `turn_count` collapses multiple messages that share an identical
-- (session, ts, turn_kind) so SUM(turn_count) == the old COUNT(*).
--
-- Additive; no FK on session_id (matches session_tool_analytics /
-- agent_component_session_usage convention). Rematerialized per-session at
-- import (rebuildSessionTurnBuckets) in the same transaction as
-- session_analytics, and backfilled once for pre-existing sessions.
CREATE TABLE IF NOT EXISTS "session_turn_bucket" (
  "session_id" TEXT NOT NULL,
  "ts" TEXT NOT NULL,
  "turn_kind" TEXT NOT NULL,
  "turn_count" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("session_id", "ts", "turn_kind")
);
