import type { UtilizationInsightsResponse } from "@closedloop-ai/loops-api/insights";

/**
 * FEA-3684 — Event Activity heatmap fallback overlay.
 *
 * FEA-3684 moved the `activityHeatmap` computation into the cloud
 * `/insights/utilization` route (it was previously a desktop-only analytic
 * derived from the local `session_turn_bucket` table). Cloud is now the
 * authoritative source when it returns the slice.
 *
 * But a Cloud-mode desktop can still receive a Utilization payload with NO
 * `activityHeatmap`:
 *   - during a deploy window, the request can hit an OLDER / rolled-back route
 *     that predates the cloud computation, or
 *   - a legacy synced session with empty/absent `metadata.messages` yields no
 *     cells even on the new route.
 * In either case the "Event Activity" card would render its empty state even
 * though the local DB still holds hundreds of `session_turn_bucket` rows.
 *
 * This overlay repairs only that one slice: it takes the cloud response and,
 * when the cloud's `activityHeatmap` is genuinely missing or has no `cells`,
 * splices in the local read's `activityHeatmap` (cells + day axis). Whenever the
 * cloud slice is populated it wins untouched, so the SSOT/consolidation intent
 * (cloud is authoritative when present) is preserved — we fall back only when
 * the cloud slice is absent/empty. No other slice is touched.
 */
export function overlayLocalActivityHeatmap(
  cloud: UtilizationInsightsResponse,
  local: UtilizationInsightsResponse | undefined
): UtilizationInsightsResponse {
  const cloudHeatmap = cloud.charts.activityHeatmap;
  if (hasCells(cloudHeatmap)) {
    return cloud;
  }
  const localHeatmap = local?.charts.activityHeatmap;
  if (!hasCells(localHeatmap)) {
    return cloud;
  }
  return {
    ...cloud,
    charts: {
      ...cloud.charts,
      activityHeatmap: localHeatmap,
    },
  };
}

function hasCells(
  heatmap: UtilizationInsightsResponse["charts"]["activityHeatmap"]
): boolean {
  return (heatmap?.cells.length ?? 0) > 0;
}
