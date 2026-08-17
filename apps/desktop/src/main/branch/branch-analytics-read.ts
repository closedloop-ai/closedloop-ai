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
import { readBranchCanonicalActivityRowsForScope } from "./branch-empty-scope-reads.js";
import { readCanonicalBranchMetricEventRows } from "./branch-metric-event-read.js";
import { rethrowAsBranchSourceError } from "./branch-read-boundaries.js";
import {
  type BranchCloudHydrationSource,
  type BranchSyncSource,
  buildBranchAnalyticsResult,
} from "./shared-branches-api.js";
import {
  eligibleBranchKeys,
  resolveBranchProductEligibilitySnapshot,
} from "./shared-branches-default-eligibility.js";
import { hasUnsupportedCloudFilter } from "./shared-branches-window.js";

/** Read the standalone Desktop Branches analytics response. */
export async function getSharedBranchAnalytics(
  source: BranchSyncSource | null | undefined,
  request: SharedBranchesQuery = {},
  cloudHydration?: BranchCloudHydrationSource
): Promise<BranchAnalytics> {
  if (!source) {
    return emptySharedBranchesAnalytics();
  }
  if (hasUnsupportedCloudFilter(request)) {
    return emptySharedBranchesAnalytics();
  }
  try {
    const requestBoundary = new Date();
    const [
      linkRows,
      prRows,
      commitRows,
      usageTokenRows,
      metricEventRead,
      lifecycleEvidence,
    ] = await Promise.all([
      readLocalBranchLinkRows(source.prisma),
      readLocalBranchPrRows(source.prisma),
      readLocalBranchCommitRows(source.prisma),
      readBranchAnalyticsTokenRows(source.prisma),
      readCanonicalBranchMetricEventRows(source, request, requestBoundary),
      readBranchAnalyticsLifecycleEventRows(source.prisma),
    ]);
    const eligibilitySnapshot = await resolveBranchProductEligibilitySnapshot(
      linkRows,
      cloudHydration,
      { scope: "list" }
    );
    const activityRows = await readBranchCanonicalActivityRowsForScope(source, {
      branchKeys: eligibleBranchKeys(linkRows, eligibilitySnapshot),
    });
    return await buildBranchAnalyticsResult(
      source.prisma,
      linkRows,
      prRows,
      commitRows,
      activityRows,
      usageTokenRows,
      request,
      cloudHydration,
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
