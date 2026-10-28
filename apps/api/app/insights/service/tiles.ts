import {
  type InsightsTileAvailabilityMap,
  InsightsTileAvailabilityState,
} from "@repo/api/src/types/insights";

/**
 * ISS-8424: the merged-PR-derived tiles, which describe the org-merged
 * population and nothing else. When verification has never reached that
 * population there is no measurement behind any of them, so they report
 * Unavailable together rather than each rendering its own zero.
 *
 * The two branch-population charts are deliberately absent: they read the
 * BRANCH population (`fetchBranchesWithoutPrBuckets`), which needs no PR
 * verification, so an unmeasured merged population leaves them measured.
 */
export const MERGED_PR_DERIVED_TILE_IDS = [
  "kpi:merged",
  "kpi:kloc",
  "kpi:pr-size",
  "kpi:ttm",
  "kpi:merge-rate",
  // Every catalog variant of each merged-PR chart, not just the default one
  // (cr, review-soul). A missing variant does not fall back to Unavailable —
  // it renders "No data yet", which is the collapsed pair this whole change
  // exists to separate, and it would sit on the same screen as its own
  // Unavailable KPI. `packages/app/insights/lib/__tests__/tile-catalog.test.ts`
  // derives the expected set from the catalog and fails when a new variant is
  // added here, because `apps/api` is gated from importing that catalog and a
  // hand-kept list cannot notice one on its own.
  "chart:prTrend",
  "chart:prTrend:bar",
  "chart:prTrend:heatmap",
  "chart:klocTrend",
  "chart:klocTrend:bar",
  "chart:klocTrend:heatmap",
  "chart:prByRepo",
  "chart:prByRepo:donut",
  "chart:prByState",
  "chart:prByState:donut",
  // Both histograms are computed from `ttms` over the same deduped merged rows
  // as `kpi:ttm`, which this change already nulls and gates.
  "chart:meanTimeToMerge",
  "chart:meanTimeToMerge:donut",
  "chart:branchLifespan",
  "chart:branchLifespan:donut",
] as const;

export function buildDeliveryTileAvailability({
  checkStatusAvailable,
  hasDecidedPrCohort,
  hasTtmEvidence,
  mergedPrPopulationMeasured,
}: {
  checkStatusAvailable: boolean;
  hasDecidedPrCohort: boolean;
  hasTtmEvidence: boolean;
  /**
   * False when the scope has session-linked merged PRs and none is verified —
   * see `delivery-measurement.ts`. Required rather than defaulted: a caller
   * that forgets it would silently restore the fabricated zero.
   */
  mergedPrPopulationMeasured: boolean;
}): InsightsTileAvailabilityMap {
  const unavailable = InsightsTileAvailabilityState.Unavailable;
  const available = InsightsTileAvailabilityState.Available;
  const map: InsightsTileAvailabilityMap = {
    "kpi:merged": available,
    // ISS-7866: the merged-PR LOC pair became GitHub-truth tiles, so they need
    // payload proof here or the Cloud+Me fast path reads `undefined` and calls
    // a populated cloud KPI Unavailable. Unconditional like `kpi:merged`: an
    // empty merged-PR cohort yields a null value the card renders as its own
    // honest empty, which is not the same statement as "this tile cannot apply".
    "kpi:kloc": available,
    "kpi:pr-size": available,
    "kpi:ttm": hasTtmEvidence ? available : unavailable,
    // FEA-3151: gate on the DECIDED cohort (merged + closed > 0), matching the
    // decided-denominator merge rate; opened-but-undecided PRs yield a null rate.
    "kpi:merge-rate": hasDecidedPrCohort ? available : unavailable,
    "chart:branchesWithoutPr": available,
    "chart:branchesWithoutPr:donut": available,
    // ISS-12638: the repo chart became a GitHub-truth tile on the cloud too, so
    // it needs payload proof here for the same reason the merged-PR LOC pair
    // does — without it the Cloud+Me fast path reads `undefined` and calls a
    // populated chart Unavailable.
    "chart:prByRepo": available,
    "chart:prByRepo:donut": available,
    "chart:checkStatus": checkStatusAvailable ? available : unavailable,
    "chart:checkStatus:bar": checkStatusAvailable ? available : unavailable,
  };
  if (mergedPrPopulationMeasured) {
    return map;
  }
  for (const tileId of MERGED_PR_DERIVED_TILE_IDS) {
    map[tileId] = unavailable;
  }
  return map;
}

export function buildUtilizationTileAvailability({
  isOrg,
}: {
  isOrg: boolean;
}): InsightsTileAvailabilityMap {
  const state = isOrg
    ? InsightsTileAvailabilityState.Available
    : InsightsTileAvailabilityState.Unavailable;
  return {
    "kpi:backlog": state,
    "chart:reviewQueue": state,
    "chart:reviewQueue:donut": state,
    "chart:reviewerLoad": state,
  };
}
