"use client";

import {
  BRANCH_METRIC_DICTIONARY,
  BranchMetricId,
} from "@repo/api/src/types/branch-metrics";
import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions";
import { ONE_LABEL_PER_METRIC_FLAG_KEY } from "@repo/api/src/types/one-label-per-metric-flag";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";

/**
 * ISS-9097: which LOC definition each Branch metric renders.
 *
 * Partial because only these four ids name a LOC ratio; every other dictionary
 * entry is a metric the LOC registry does not describe and keeps its own word.
 *
 * The three publication ratios canonicalize to the PUSHED phrase by ISS-10667's
 * ruling, and that mapping is carried here unchanged rather than re-argued. It
 * is worth knowing what the phrase does NOT assert: the producer picks one lane
 * PER BRANCH and falls back to merged-PR rows, so a cohort can mix both lanes
 * under it (see the numerator prose in `branch-metrics.ts`). Whether a
 * lane-selected numerator should name a single basis is ISS-9097 item 3.
 */
const LOC_DEFINITION_BY_BRANCH_METRIC: Partial<
  Record<BranchMetricId, LocMetricDefinitionId>
> = {
  [BranchMetricId.CanonicalLocPerDollar]:
    LocMetricDefinitionId.BranchCanonicalPublicationLoc,
  [BranchMetricId.DetailLocPerDollar]:
    LocMetricDefinitionId.BranchDetailPublicationLoc,
  [BranchMetricId.ListLocPerDollar]:
    LocMetricDefinitionId.BranchListPublicationLoc,
  [BranchMetricId.PushedLocPerDollar]: LocMetricDefinitionId.BranchPushedLoc,
};

function shippedBranchMetricLabel(id: BranchMetricId): string {
  return BRANCH_METRIC_DICTIONARY[id].label;
}

function canonicalBranchMetricLabel(id: BranchMetricId): string {
  const definitionId = LOC_DEFINITION_BY_BRANCH_METRIC[id];
  if (definitionId === undefined) {
    return shippedBranchMetricLabel(id);
  }
  return LOC_METRIC_DEFINITION[definitionId].canonicalLabel;
}

/**
 * Read here, branched here, and what leaves is the RESOLVER — never the gate.
 *
 * A resolver rather than a whole map because the loading shell names its cards
 * inside a `.map`, where a hook cannot be called; the card component and the
 * detail row each call this once at their own top level.
 */
export function useBranchMetricLabels(): (id: BranchMetricId) => string {
  return useFeatureFlagEnabledOptional(ONE_LABEL_PER_METRIC_FLAG_KEY)
    ? canonicalBranchMetricLabel
    : shippedBranchMetricLabel;
}
