import { decodeBranchId, encodeBranchId } from "@repo/api/src/types/branch";
import {
  type BranchAnalyticsCohortResponse,
  branchAnalyticsCohortRequestSchema,
} from "@repo/api/src/types/branch-analytics-cohort";
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
  filterEligibleBranchRows,
  resolveBranchProductEligibilitySnapshot,
} from "./shared-branches-default-eligibility.js";

/** Project exact canonical metrics for existing requested Desktop Branch IDs. */
export async function getSharedBranchCohortAnalytics(
  source: BranchSyncSource | null | undefined,
  rawRequest: unknown,
  cloudHydration?: BranchCloudHydrationSource
): Promise<BranchAnalyticsCohortResponse | null> {
  const request = branchAnalyticsCohortRequestSchema.parse(rawRequest);
  if (!source) {
    return null;
  }
  try {
    const requestBoundary = new Date();
    const branchKeys = request.branchIds.map(decodeBranchId);
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
      readCanonicalBranchMetricEventRows(
        source,
        { startDate: request.startDate, endDate: request.endDate },
        requestBoundary,
        branchKeys
      ),
      readBranchAnalyticsLifecycleEventRows(source.prisma, branchKeys),
    ]);
    const eligibilitySnapshot = await resolveBranchProductEligibilitySnapshot(
      linkRows,
      cloudHydration,
      { scope: "list" }
    );
    const requestedIds = new Set(request.branchIds);
    const eligibleRequestedLinks = filterEligibleBranchRows(
      linkRows,
      eligibilitySnapshot
    ).filter((row) => requestedIds.has(encodeBranchId(row)));
    const activityRows = await readBranchCanonicalActivityRowsForScope(source, {
      branchKeys: eligibleBranchKeys(
        eligibleRequestedLinks,
        eligibilitySnapshot
      ),
    });
    let matchedBranchIds: string[] = [];
    const analytics = await buildBranchAnalyticsResult(
      source.prisma,
      linkRows,
      prRows,
      commitRows,
      activityRows,
      usageTokenRows,
      { startDate: request.startDate, endDate: request.endDate },
      cloudHydration,
      metricEventRead,
      metricEventRead.activitySegments,
      lifecycleEvidence,
      {
        branchIds: request.branchIds,
        onMatchedBranchIds: (branchIds) => {
          matchedBranchIds = branchIds;
        },
      },
      eligibilitySnapshot
    );
    if (!analytics.canonicalMetrics) {
      throw new Error("Canonical Branch cohort metrics were not projected");
    }
    return { matchedBranchIds, canonicalMetrics: analytics.canonicalMetrics };
  } catch (error) {
    rethrowAsBranchSourceError("getSharedBranchCohortAnalytics", error);
  }
}
