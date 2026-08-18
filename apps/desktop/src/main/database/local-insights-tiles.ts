/**
 * @file local-insights-tiles.ts
 * @description Presentation shapes for the local Insights sections: the
 * Delivery PR-state distribution and the per-section tile-availability maps.
 * Pure functions over already-computed counts — no SQL, no Prisma.
 *
 * Extracted from `local-insights.ts` by ISS-5936, following the seam the
 * sibling `local-insights-loc.ts` / `-series.ts` / `-spend.ts` modules already
 * use. That file was on the shrink-only grandfather list at the time, so the
 * change that touched `computeDelivery` / `computeUtilization` carried this
 * extraction to leave it smaller than it found it. The three helpers moved
 * verbatim, and the
 * five symbols they need came with them — three from `@closedloop-ai/loops-api/insights`
 * and two from `@repo/api/src/types/github` — none of which was used anywhere
 * else in the origin file.
 */

import type {
  CategoryBucket,
  InsightsTileAvailabilityMap,
} from "@closedloop-ai/loops-api/insights";
import { InsightsTileAvailabilityState } from "@closedloop-ai/loops-api/insights";
import {
  GITHUB_PR_STATE_LABELS,
  GitHubPRState,
} from "@repo/api/src/types/github";

// FEA-3455: real PR-state distribution for the local Delivery `prByState`
// chart. Mirrors cloud's `mergedStateBuckets` (service.ts): every counted PR is
// merged, so the distribution is a single MERGED bucket sized by the merged
// count — or empty when there are none — keeping it consistent with the "Merged
// PRs" figure and the shared GitHub PR-state labels. Replaces the fabricated
// single "Captured locally" bucket.
export function mergedStateBuckets(mergedCount: number): CategoryBucket[] {
  if (mergedCount === 0) {
    return [];
  }
  return [
    {
      key: GitHubPRState.Merged,
      label: GITHUB_PR_STATE_LABELS[GitHubPRState.Merged],
      value: mergedCount,
    },
  ];
}

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
