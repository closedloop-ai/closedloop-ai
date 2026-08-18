import type {
  AgentsInsightsResponse,
  TimeSeries,
} from "@closedloop-ai/loops-api/insights";

/**
 * FEA-3454 — Autonomy Trend overlay.
 *
 * The `autonomyTrend` slice of the Agents payload is a desktop-only analytic
 * derived from the local `session_turn_bucket` table (see
 * `apps/desktop/src/main/database/local-insights.ts` `computeAgents`). The cloud
 * `/insights/agents` route never computes it — the field is additive and omitted
 * by web/cloud peers (see the type comment on
 * `AgentsInsightsResponse.charts.autonomyTrend`), and the cloud DB carries no
 * turn-level data to derive it from.
 *
 * So when authenticated desktop reads its own Agents data from the cloud (Cloud
 * mode, PRD-461 D3), the trend arrives empty/absent even though the local DB
 * holds the buckets — and the shared overview dashboard hides the Autonomy Trend
 * row entirely (`insights-overview-dashboard.tsx`), so an authenticated+online
 * desktop user loses the chart a signed-out/offline (Local) user still sees.
 *
 * This overlay repairs only that one slice: it takes the cloud response and,
 * when the cloud's `autonomyTrend` is missing or carries no measured values,
 * splices in the local read's `autonomyTrend`. The cloud value is preserved
 * whenever it is populated, so a future cloud-computed trend wins. No other
 * slice is touched — the D3 principle (own-data metrics come from the cloud) is
 * intact; this fills a slice the cloud simply never returns. Mirrors the #3061
 * Event Activity heatmap overlay.
 */
export function overlayLocalAutonomyTrend(
  cloud: AgentsInsightsResponse,
  local: AgentsInsightsResponse | undefined
): AgentsInsightsResponse {
  if (hasMeasuredValues(cloud.charts.autonomyTrend)) {
    return cloud;
  }
  const localTrend = local?.charts.autonomyTrend;
  if (!hasMeasuredValues(localTrend)) {
    return cloud;
  }
  return {
    ...cloud,
    charts: {
      ...cloud.charts,
      autonomyTrend: localTrend,
    },
  };
}

/**
 * Whether a trend series carries at least one measured (non-null) value. The
 * local gap-filled series backfills days with no activity as `null`, so an
 * all-null series (no sessions in range) has nothing worth overlaying — the
 * TimeSeries analogue of the heatmap overlay's `cells.length > 0` guard.
 */
function hasMeasuredValues(series: TimeSeries | undefined): boolean {
  return Boolean(
    series?.points.some((point) =>
      Object.values(point.values).some((value) => value !== null)
    )
  );
}
