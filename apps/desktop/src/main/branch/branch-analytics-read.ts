import type { BranchAnalytics } from "@repo/api/src/types/branch";
import {
  emptySharedBranchesAnalytics,
  type SharedBranchesQuery,
} from "../../shared/shared-branches-contract.js";
import { readBranchAnalyticsLifecycleEventRows } from "../database/branch-analytics-phase-evidence.js";
import {
  readBranchAnalyticsTokenRows,
  readLocalBranchCommitRows,
  readLocalBranchLinkRows,
  readLocalBranchPrRows,
} from "../database/branch-reads.js";
import { buildBranchAnalyticsResult } from "./branch-analytics-builder.js";
import { readBranchCanonicalActivityRowsForScope } from "./branch-empty-scope-reads.js";
import { readCanonicalBranchMetricEventRows } from "./branch-metric-event-read.js";
import { rethrowAsBranchSourceError } from "./branch-read-boundaries.js";
import type { BranchSyncSource } from "./shared-branches-api.js";
import {
  eligibleBranchKeys,
  resolveBranchProductEligibilitySnapshot,
} from "./shared-branches-default-eligibility.js";
import { hasUnsupportedCloudFilter } from "./shared-branches-window.js";

/** Read the standalone Desktop Branches analytics response. */
export async function getSharedBranchAnalytics(
  source: BranchSyncSource | null | undefined,
  request: SharedBranchesQuery = {}
): Promise<BranchAnalytics> {
  if (!source) {
    return emptySharedBranchesAnalytics();
  }
  if (hasUnsupportedCloudFilter(request)) {
    return emptySharedBranchesAnalytics();
  }
  try {
    const requestBoundary = new Date();
    const [linkRows, prRows, commitRows, usageTokenRows, metricEventRead] =
      await Promise.all([
        readLocalBranchLinkRows(source.prisma),
        readLocalBranchPrRows(source.prisma),
        readLocalBranchCommitRows(source.prisma),
        readBranchAnalyticsTokenRows(source.prisma),
        readCanonicalBranchMetricEventRows(source, request, requestBoundary),
      ]);
    const eligibilitySnapshot =
      resolveBranchProductEligibilitySnapshot(linkRows);
    // ISS-9862: the lifecycle bound is per request, so the read takes the same
    // eligible cohort the activity read takes instead of the whole corpus.
    const branchKeys = eligibleBranchKeys(linkRows, eligibilitySnapshot);
    const [activityRows, lifecycleEvidence] = await Promise.all([
      readBranchCanonicalActivityRowsForScope(source, { branchKeys }),
      readBranchAnalyticsLifecycleEventRows(source.prisma, branchKeys),
    ]);
    return await buildBranchAnalyticsResult(
      source.prisma,
      linkRows,
      prRows,
      commitRows,
      activityRows,
      usageTokenRows,
      request,
      metricEventRead,
      metricEventRead.activitySegments,
      lifecycleEvidence,
      undefined,
      eligibilitySnapshot
    );
  } catch (error) {
    rethrowAsBranchSourceError("getSharedBranchAnalytics", error);
  }
}
