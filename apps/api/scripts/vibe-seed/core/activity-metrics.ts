import type { SyncedSessionActivityMetrics } from "@repo/api/src/types/session-activity-metrics";
import {
  MAX_ROLLUP_COUNT,
  MAX_TIER_SPEND_USD,
} from "@repo/api/src/types/session-activity-metrics-normalize";
import { z } from "zod";
import { openSnapshot } from "../../perf-import-desktop-snapshot-reads";

/**
 * ISS-12017: the `activityMetrics` wire field for each golden session, read
 * from the store's `session_activity_metrics` rollup. The perf mapping predates
 * this field and does not send it, so without it the ingest fold never writes
 * `AgentSessionActivityMetrics`.
 *
 * Mirrors Desktop's own producer, `mapSyncedSessionActivityMetrics` in
 * `apps/desktop/src/main/database/sync-source-rollup-reads.ts` (not importable
 * across apps): a measure that is not usable is omitted rather than sent, and
 * the three spend tiers are sent whole or not at all.
 */

const ACTIVITY_METRICS_SELECT = `
  SELECT
    session_id AS "sessionId",
    autonomy_band AS "autonomyBand",
    coverage AS "coverage",
    spend_low_conf_usd AS "spendLow",
    spend_medium_conf_usd AS "spendMedium",
    spend_high_conf_usd AS "spendHigh",
    segment_count AS "segmentCount",
    covered_segment_count AS "coveredSegmentCount",
    version AS "classifierVersion",
    metric_version AS "metricVersion"
  FROM session_activity_metrics
`;

/**
 * Each measure parses to `null` when it is not usable, which the mapping below
 * turns into omission.
 */
const usableCount = z
  .number()
  .int()
  .min(0)
  .max(MAX_ROLLUP_COUNT)
  .nullable()
  .catch(null);
const usableAmount = z
  .number()
  .finite()
  .min(0)
  .max(MAX_TIER_SPEND_USD)
  .nullable()
  .catch(null);

const activityMetricsRowSchema = z.object({
  sessionId: z.string(),
  autonomyBand: z.string().min(1).nullable().catch(null),
  coverage: z.number().finite().min(0).max(1).nullable().catch(null),
  spendLow: usableAmount,
  spendMedium: usableAmount,
  spendHigh: usableAmount,
  segmentCount: usableCount,
  coveredSegmentCount: usableCount,
  classifierVersion: usableCount,
  metricVersion: usableCount,
});

type ActivityMetricsRow = z.infer<typeof activityMetricsRowSchema>;

/** The mapped rollup per Desktop session id; sessions without a usable row are absent. */
export function readActivityMetricsBySession(
  storePath: string
): ReadonlyMap<string, SyncedSessionActivityMetrics> {
  const db = openSnapshot(storePath);
  try {
    const bySession = new Map<string, SyncedSessionActivityMetrics>();
    for (const raw of db.prepare(ACTIVITY_METRICS_SELECT).all()) {
      const row = activityMetricsRowSchema.safeParse(raw);
      if (!row.success) {
        continue;
      }
      const metrics = mapActivityMetricsRow(row.data);
      if (metrics !== null) {
        bySession.set(row.data.sessionId, metrics);
      }
    }
    return bySession;
  } finally {
    db.close();
  }
}

function mapActivityMetricsRow(
  row: ActivityMetricsRow
): SyncedSessionActivityMetrics | null {
  const { spendLow, spendMedium, spendHigh } = row;
  const measures: SyncedSessionActivityMetrics = {
    autonomyBand: row.autonomyBand,
    coverage: row.coverage,
    segmentCount: row.segmentCount,
    coveredSegmentCount: row.coveredSegmentCount,
    classifierVersion: row.classifierVersion,
    metricVersion: row.metricVersion,
    ...(spendLow !== null && spendMedium !== null && spendHigh !== null
      ? {
          spendLowConfUsd: spendLow,
          spendMediumConfUsd: spendMedium,
          spendHighConfUsd: spendHigh,
        }
      : {}),
  };
  const metrics = Object.fromEntries(
    Object.entries(measures).filter(([, value]) => value !== null)
  );
  return Object.keys(metrics).length > 0 ? metrics : null;
}
