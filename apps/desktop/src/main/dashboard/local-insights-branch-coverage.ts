import {
  type DeliveryInsightsResponse,
  InsightsTileAvailabilityState,
  insightsPeriodDays,
} from "@closedloop-ai/loops-api/insights";
import { branchCoverageBuckets } from "@closedloop-ai/loops-api/insights-branch-coverage";
import { stableUtcListWindow } from "@closedloop-ai/loops-api/stable-utc-window";
import {
  BranchListFacetAvailability,
  BranchListPageMode,
  BranchListPullRequestPresence,
} from "@repo/api/src/types/branch-list-contract";
import type { InsightsPeriod } from "@repo/api/src/types/insights";
import { z } from "zod";
import { isDbHostShutdownError } from "../../shared/db-host-shutdown-error.js";
import { SHARED_BRANCHES_TRANSIENT_ERROR_CODE } from "../../shared/shared-branches-contract.js";
import {
  type BranchSyncSource,
  getSharedBranchesPageData,
} from "../branch/shared-branches-api.js";
import type {
  BranchListSnapshot,
  BranchListSnapshotRequest,
} from "../database/branch-list-snapshot-read.js";
import { gatewayLog } from "../logging/gateway-logger.js";

/**
 * ISS-12256 — the Local-mode Dashboard's "Branch coverage" chart, counted over
 * the Desktop Branches list's OWN population for the same range.
 *
 * Operator ruling (Marisol Ashgrove, 2026-10-08, ISS-11915): "the Dashboard for 7
 * days has the same # of branches as the branches listing page for 7 days."
 * The cloud Dashboard counts the cloud list's population
 * (`apps/api/app/insights/insights-branch-population.ts`); this applies the same
 * rule to the local list. The read is the one the Local-mode Branches page
 * makes (`getSharedBranchesPageData` in server-page mode over the
 * `branches.listSnapshot` store op), bounded by the
 * range's list window (`stableUtcListWindow`). The two buckets ARE that page's
 * Pull request facet: the same population, and the same "has a pull request"
 * rule (any associated PR, not the selected-PR pointer), so the chart and the
 * list's own filter cannot disagree.
 *
 * "Check status" stays Unavailable: it is org-wide CI health, omitted at
 * personal scope on cloud as well, and the Desktop is always personal scope.
 *
 * A db-host exit or shutdown rethrows so the caller's redrive and shutdown
 * handling still see it. Any other failed read, or a facet the read could not
 * count completely, leaves the chart as the db-host built it (Unavailable)
 * rather than publishing a partial population as measured.
 */
export async function withLocalBranchCoverage(
  delivery: DeliveryInsightsResponse,
  source: BranchSyncSource,
  period: InsightsPeriod,
  readListSnapshot: (
    request: BranchListSnapshotRequest
  ) => Promise<BranchListSnapshot>,
  now: Date = new Date()
): Promise<DeliveryInsightsResponse> {
  let pullRequests: BranchPullRequestFacet;
  try {
    const { list } = await getSharedBranchesPageData(
      source,
      {
        ...stableUtcListWindow(insightsPeriodDays(period), now),
        pageMode: BranchListPageMode.Server,
      },
      readListSnapshot
    );
    pullRequests = list.facets?.pullRequests;
  } catch (error) {
    if (isRedrivableBranchReadFailure(error)) {
      throw error;
    }
    gatewayLog.warn(
      LOG_TAG,
      `local Dashboard Branch coverage read failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return delivery;
  }
  if (pullRequests?.availability !== BranchListFacetAvailability.Complete) {
    return delivery;
  }
  const count = (presence: BranchListPullRequestPresence) =>
    pullRequests.options.find((option) => option.id === presence)?.count ?? 0;
  const available = InsightsTileAvailabilityState.Available;
  return {
    ...delivery,
    tileAvailability: {
      ...delivery.tileAvailability,
      "chart:branchesWithoutPr": available,
      "chart:branchesWithoutPr:donut": available,
    },
    charts: {
      ...delivery.charts,
      branchesWithoutPr: branchCoverageBuckets(
        count(BranchListPullRequestPresence.Linked),
        count(BranchListPullRequestPresence.None)
      ),
    },
  };
}

type BranchPullRequestFacet =
  | NonNullable<
      Awaited<ReturnType<typeof getSharedBranchesPageData>>["list"]["facets"]
    >["pullRequests"]
  | undefined;

/** A db-host exit or shutdown the IPC wrapper redrives or reports itself. */
function isRedrivableBranchReadFailure(error: unknown): boolean {
  return (
    isDbHostShutdownError(error) ||
    (error instanceof Error &&
      error.message === SHARED_BRANCHES_TRANSIENT_ERROR_CODE)
  );
}

const LOG_TAG = "dashboard-insights";

/** The Delivery section is the one local insights shape carrying this chart. */
export function isDeliveryInsights(
  insights: unknown
): insights is DeliveryInsightsResponse {
  return DELIVERY_BRANCH_COVERAGE_SHAPE.safeParse(insights).success;
}

const DELIVERY_BRANCH_COVERAGE_SHAPE = z.object({
  charts: z.object({ branchesWithoutPr: z.array(z.unknown()) }),
});
