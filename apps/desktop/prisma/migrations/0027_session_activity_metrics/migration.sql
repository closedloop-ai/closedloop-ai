-- FEA-2273 (PRD-488 FR-12, PLN-1205): in-product cohort metrics emission.
-- Persist per-session activity-attribution metrics — Coverage + the reported-
-- confidence spend distribution — computed at ingest (and boot-backfilled) from
-- the session's `session_activity_segments` (FEA-2267/2269) + `token_events` via
-- the shared FEA-2266 metric module (telemetry/attribution-metrics.ts). One row
-- per session, cohort-keyed, so per-cohort metrics are a cheap GROUP BY over this
-- narrow table (the FEA-2038 metadata-only-aggregate invariant) instead of a log
-- scrape or an events re-scan — making weak cohorts visible as the iteration
-- target (PRD-488 Goal 4).
--
-- Cohort keys mirror the materialized `session_analytics` rollup (harness / the
-- human-vs-agent turn split / runtime_ms) + `sessions` identity (user_id /
-- organization_id), bucketed with the band cut-points imported from the FEA-2266
-- module — never redefined here. `covered_spend_usd` / `total_spend_usd` are the
-- exact micro-cent Coverage inputs kept so read-time per-cohort coverage is
-- SUM(covered)/SUM(total). `version` is the segments' ACTIVITY_CLASSIFIER_VERSION
-- the metrics summarize, so a classifier bump re-derives: a fresh import recomputes
-- inline, and the version-aware boot backfill (backfillActivityMetrics) refreshes
-- any row whose stamped version trails its segments after the separate re-tile
-- pathway (backfillActivitySegmentsFromTranscripts), which re-tiles but does not
-- itself refresh metrics.
--
-- Additive; no FK on session_id (matches session_analytics / session_tool_analytics
-- / session_turn_bucket convention). Rewritten per-session at import
-- (upsertActivityMetricsRollup, INSERT OR REPLACE — idempotent) inside the same
-- transaction as `session_analytics`, backfilled for pre-existing sessions that
-- have segments but no metrics row, and re-derived by the same version-aware
-- backfill when a re-tile leaves a row behind. Purged with the session in the
-- manual-delete and retention-sweep paths (no-FK derived rollup).
CREATE TABLE IF NOT EXISTS "session_activity_metrics" (
  "session_id" TEXT NOT NULL PRIMARY KEY,
  "harness" TEXT,
  "autonomy_band" TEXT NOT NULL,
  "closedloop_user" INTEGER NOT NULL DEFAULT 0,
  "length_band" TEXT NOT NULL,
  "started_day" TEXT,
  "coverage" REAL NOT NULL DEFAULT 0,
  "covered_spend_usd" REAL NOT NULL DEFAULT 0,
  "total_spend_usd" REAL NOT NULL DEFAULT 0,
  "spend_low_conf_usd" REAL NOT NULL DEFAULT 0,
  "spend_medium_conf_usd" REAL NOT NULL DEFAULT 0,
  "spend_high_conf_usd" REAL NOT NULL DEFAULT 0,
  "segment_count" INTEGER NOT NULL DEFAULT 0,
  "covered_segment_count" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL,
  "updated_at" TEXT
);

CREATE INDEX IF NOT EXISTS "idx_session_activity_metrics_harness"
  ON "session_activity_metrics"("harness");

CREATE INDEX IF NOT EXISTS "idx_session_activity_metrics_started_day"
  ON "session_activity_metrics"("started_day");
