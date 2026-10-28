/**
 * @file local-insights-tiles.ts
 * @description Per-section tile-availability maps for the local Insights
 * sections. Pure functions over already-computed counts — no SQL, no Prisma.
 */
import type { InsightsTileAvailabilityMap } from "@closedloop-ai/loops-api/insights";
import { InsightsTileAvailabilityState } from "@closedloop-ai/loops-api/insights";

// FEA-3455: local Delivery tile availability. Desktop is always personal scope,
// so this mirrors cloud's `buildDeliveryTileAvailability` at personal scope:
// `checkStatus` has no local CI source (always Unavailable), and the ttm /
// merge-rate KPIs gate on whether the local corpus carries the needed evidence.
export function buildDeliveryTileAvailability({
  hasDecidedPrCohort,
  hasTtmEvidence,
}: {
  hasDecidedPrCohort: boolean;
  hasTtmEvidence: boolean;
}): InsightsTileAvailabilityMap {
  const available = InsightsTileAvailabilityState.Available;
  const unavailable = InsightsTileAvailabilityState.Unavailable;
  return {
    "kpi:merged": available,
    "kpi:ttm": hasTtmEvidence ? available : unavailable,
    "kpi:merge-rate": hasDecidedPrCohort ? available : unavailable,
    // ISS-12709: the desktop store keeps no PR state or repo-level GitHub
    // data, so these charts have no source to draw from.
    "chart:prByRepo": unavailable,
    "chart:prByRepo:donut": unavailable,
    "chart:prByState": unavailable,
    "chart:prByState:donut": unavailable,
    // ISS-12256: the db-host has no Branches list read; main counts this chart
    // over that list and marks it Available (`withLocalBranchCoverage`).
    "chart:branchesWithoutPr": unavailable,
    "chart:branchesWithoutPr:donut": unavailable,
    "chart:checkStatus": unavailable,
    "chart:checkStatus:bar": unavailable,
  };
}

// FEA-3455: local Utilization tile availability. Mirrors cloud's
// `buildUtilizationTileAvailability({ isOrg: false })` — the review backlog,
// reviewQueue and reviewerLoad tiles are org-only and Unavailable under the
// desktop's personal scope.
export function buildUtilizationTileAvailability(): InsightsTileAvailabilityMap {
  const unavailable = InsightsTileAvailabilityState.Unavailable;
  return {
    "kpi:backlog": unavailable,
    "chart:reviewQueue": unavailable,
    "chart:reviewQueue:donut": unavailable,
    "chart:reviewerLoad": unavailable,
  };
}
