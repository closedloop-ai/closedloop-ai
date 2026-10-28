import type {
  InsightsPeriod,
  InsightsScope,
  InsightsSection,
} from "@repo/api/src/types/insights";
import type { SessionAnalyticsSection } from "@repo/api/src/types/session-analytics";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { ORIGIN, type Origin } from "@repo/observability/telemetry/origin";

// ---------------------------------------------------------------------------
// insights.dashboard.* metric emitter module (ISS-7512)
//
// Single import point for /insights
type InsightsSectionLatencyMetric = {
  metric: typeof FilterToken.InsightsDashboardSectionLatency;
  origin: Origin;
  section: InsightsSection | SessionAnalyticsSection;
  period: InsightsPeriod;
  scope: InsightsScope;
  teamScoped: boolean;
  value: number;
};

/**
 * One successful /insights section read, in milliseconds.
 *
 * BEST-EFFORT BY CONTRACT: a telemetry failure must never turn a section whose
 * data already resolved into a 500 for the reader. The emit is therefore
 * swallowed rather than propagated — deliberately silent, because the only
 * fallback available here would itself be the logger that just failed.
 *
 * Emitted on the SUCCESS path only. A section that threw is already reported by
 * the handler's `insights.<section>_failed` log with full correlation, and a
 * duration recorded for a request that produced no data would drag the p50 of a
 * latency metric toward whatever the failure took to raise.
 */
export function emitInsightsSectionLatency(sample: {
  section: InsightsSection | SessionAnalyticsSection;
  period: InsightsPeriod;
  scope: InsightsScope;
  teamScoped: boolean;
  durationMs: number;
}): void {
  try {
    emitTelemetryMetric<InsightsSectionLatencyMetric>({
      metric: FilterToken.InsightsDashboardSectionLatency,
      origin: ORIGIN,
      section: sample.section,
      period: sample.period,
      scope: sample.scope,
      teamScoped: sample.teamScoped,
      value: sample.durationMs,
    });
  } catch {
    // Intentionally swallowed — see the contract note above.
  }
}

/**
 * `count:` (occurrences), NOT `value:` — this one IS summed, unlike its gauge
 * sibling above.
 *
 * Carries the same closed-union tags and, like the gauge, no tenant id: the
 * org lives only in the throttle's process-local key, which is what bounds
 * volume without spending cardinality.
 */
type InsightsSectionLatencySuppressedMetric = {
  metric: typeof FilterToken.InsightsDashboardSectionLatencySuppressed;
  origin: Origin;
  section: InsightsSection | SessionAnalyticsSection;
  period: InsightsPeriod;
  scope: InsightsScope;
  count: number;
};

/**
 * How many successful section reads were NOT sampled, for one throttle key's
 * closed window (ISS-7512).
 *
 * WHY THIS EXISTS AT ALL. Throttling the gauge without this would leave the
 * dashboard-latency panel unable to distinguish a quiet minute from a throttled
 * one — a p95 over one sample and a p95 over one sample standing for ten
 * thousand reads would render identically. `apps/api/AGENTS.md` asks for a
 * bounded suppressed count for exactly that reason. Emitted only when the count
 * is positive, so a fully-observed window stays silent rather than shipping a
 * `0` that costs log volume to say nothing.
 *
 * Best-effort on the same contract as the gauge: a telemetry failure must never
 * turn a section whose data already resolved into a 500.
 */
export function emitInsightsSectionLatencySuppressed(rollup: {
  section: InsightsSection | SessionAnalyticsSection;
  period: InsightsPeriod;
  scope: InsightsScope;
  suppressedCount: number;
}): void {
  if (rollup.suppressedCount <= 0) {
    return;
  }
  try {
    emitTelemetryMetric<InsightsSectionLatencySuppressedMetric>({
      metric: FilterToken.InsightsDashboardSectionLatencySuppressed,
      origin: ORIGIN,
      section: rollup.section,
      period: rollup.period,
      scope: rollup.scope,
      count: rollup.suppressedCount,
    });
  } catch {
    // Intentionally swallowed — see the contract note above.
  }
}
