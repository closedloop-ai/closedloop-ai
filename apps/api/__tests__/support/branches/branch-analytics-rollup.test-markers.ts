/**
 * Fragments that identify one rendered rollup statement and no other, for the
 * suites whose mocked `$queryRaw` routes canned rows by SQL text. One owner, so
 * a reworded statement reddens every router at once instead of one at a time.
 */

/** Rendered only by the read's completeness gate (`selectIncompleteMaterializedSessions`). */
export const COMPLETENESS_GATE_MARKER =
  "materialized_watermark.source_max_event_created_at";

/** Rendered only by the refresh pass's source watermark read (`readSourceWatermark`). */
export const SOURCE_WATERMARK_MARKER = 'AS "malformedSessionCount"';

/** Rendered only by the refresh queue (`selectBranchAnalyticsSessionRefreshBatch`). */
export const REFRESH_QUEUE_MARKER = 'AS "needsBackfill"';

/**
 * Rendered only by the read's state lookup (`readBranchAnalyticsRollupState`).
 * The refresh pass's receive probe also reads the state table, so the table
 * name alone no longer identifies this statement.
 */
export const ROLLUP_STATE_READ_MARKER =
  'backfill_completed_at AS "backfillCompletedAt"';
