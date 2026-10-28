import { BranchMetricId } from "@repo/api/src/types/branch-metrics";

/**
 * ISS-10645: the Branches summary row's card ORDER, in a module with no React
 * and no feature-flag hook behind it.
 *
 * The desktop route's loading fallback has to name the same cards the live strip
 * will paint, and it must stay a static import — pulling the card specs in would
 * drag the flag hooks and the whole metric-card runtime into the eager bundle
 * and defeat the code split the fallback exists to cover. So the ORDER lives
 * here and the specs read it, rather than the fallback holding a second list;
 * `branches-summary-card-ids.test.ts` pins the two together.
 */
export const CANONICAL_BRANCH_SUMMARY_CARD_IDS = [
  BranchMetricId.ActiveBranches,
  BranchMetricId.MedianPrSize,
  BranchMetricId.TotalLocPushed,
  BranchMetricId.MergeRate,
  BranchMetricId.CanonicalLocPerDollar,
] as const;
