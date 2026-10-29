import {
  type BranchAnalytics,
  encodeBranchId,
} from "@repo/api/src/types/branch";
import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import { canonicalSpendKpis } from "@repo/lib/branches/branch-canonical-spend-kpis";
import { selectBranchServerRows } from "@repo/lib/branches/branch-list-page";
import { isAnomalousSpendTotal } from "@repo/lib/branches/spend-kpi";
import type { SharedBranchesQuery } from "../../shared/shared-branches-contract.js";
import type { BranchCanonicalActivityRow } from "../database/branch-activity-read.js";
import type {
  readBranchAnalyticsActivitySegmentRows,
  readBranchAnalyticsLifecycleEventRows,
} from "../database/branch-analytics-phase-evidence.js";
import type { BranchKeyRow } from "../database/branch-reads.js";
import {
  type readBranchAnalyticsTokenRows,
  type readLocalBranchCommitRows,
  type readLocalBranchLinkRows,
  type readLocalBranchPrRows,
  readSessionBranchCounts,
} from "../database/branch-reads.js";
import { writePersistentLog } from "../logging/durable-log-sink.js";
import { projectBranchAnalytics } from "./branch-analytics-projection.js";
import {
  filterCanonicalDesktopCohort,
  projectDesktopCanonicalMetrics,
  selectExactBranchCohort,
} from "./branch-canonical-metric-projection.js";
import { buildPhaseEvidence } from "./branch-canonical-phase-evidence.js";
import { readDesktopCohortAiSpendFacts } from "./branch-cohort-cost-facts.js";
import {
  type DesktopBranchLastActiveProjection,
  projectDesktopBranchLastActive,
} from "./branch-last-active-projection.js";
import {
  branchIdsForLinks,
  projectBranchListItems,
} from "./branch-list-projection.js";
import type { CanonicalBranchMetricEventRead } from "./branch-metric-event-read.js";
import { toDesktopBranchServerPageQuery } from "./branch-server-page-query.js";
import {
  branchUsageRowFromTokenRow,
  sumStoredBranchCost,
} from "./branch-usage-projection.js";
import {
  type BranchDefaultEligibilitySnapshot,
  denominatorEligibleBranchKeys,
  filterEligibleBranchRows,
  isEligibilityCoverageCompleteForCohort,
  resolveBranchProductEligibilitySnapshot,
} from "./shared-branches-default-eligibility.js";
import {
  collectSessionIds,
  filterBranchItemsByWindow,
  filterEventRowsByEventWindow,
  isDateWindowActive,
} from "./shared-branches-window.js";

type ExactCohortOptions = {
  branchIds: readonly string[];
  onMatchedBranchIds: (branchIds: string[]) => void;
};

/** Project fetched Branch and usage evidence into canonical Desktop analytics. */
export async function buildBranchAnalyticsResult(
  prisma: Parameters<typeof readSessionBranchCounts>[0],
  linkRows: Awaited<ReturnType<typeof readLocalBranchLinkRows>>,
  prRows: Awaited<ReturnType<typeof readLocalBranchPrRows>>,
  commitRows: Awaited<ReturnType<typeof readLocalBranchCommitRows>>,
  activityRows: readonly BranchCanonicalActivityRow[],
  usageTokenRows: Awaited<ReturnType<typeof readBranchAnalyticsTokenRows>>,
  request: SharedBranchesQuery,
  metricEventRead: CanonicalBranchMetricEventRead,
  activitySegmentEvidence: Awaited<
    ReturnType<typeof readBranchAnalyticsActivitySegmentRows>
  >,
  lifecycleEvidence: Awaited<
    ReturnType<typeof readBranchAnalyticsLifecycleEventRows>
  >,
  cohortOptions?: ExactCohortOptions,
  eligibilitySnapshot?: BranchDefaultEligibilitySnapshot,
  operationLastActiveByBranch?: DesktopBranchLastActiveProjection
): Promise<BranchAnalytics> {
  const { requestBoundary, rows: eventRows } = metricEventRead;
  const resolvedEligibility =
    eligibilitySnapshot ?? resolveBranchProductEligibilitySnapshot(linkRows);
  const eligibleLinkRows = filterEligibleBranchRows(
    linkRows,
    resolvedEligibility
  );
  const eligiblePrRows = filterEligibleBranchRows(prRows, resolvedEligibility);
  const eligibleCommitRows = filterEligibleBranchRows(
    commitRows,
    resolvedEligibility
  );
  const lastActiveByBranch =
    operationLastActiveByBranch ??
    projectDesktopBranchLastActive(
      branchIdsForLinks(eligibleLinkRows),
      activityRows,
      eligiblePrRows,
      eligibleCommitRows,
      eligibleLinkRows
    );
  const eligibleItems = projectBranchListItems(
    eligibleLinkRows,
    eligiblePrRows,
    [],
    lastActiveByBranch
  );
  const allItems = projectBranchListItems(
    linkRows,
    prRows,
    [],
    lastActiveByBranch
  );
  const serverFilteredItems =
    request.pageMode === BranchListPageMode.Server
      ? selectBranchServerRows(
          eligibleItems,
          {
            ...toDesktopBranchServerPageQuery(request),
            startDate: undefined,
            endDate: undefined,
          },
          requestBoundary.toISOString()
        )
      : eligibleItems;
  const selectedItems = cohortOptions
    ? selectExactBranchCohort(serverFilteredItems, cohortOptions.branchIds)
    : serverFilteredItems;
  const windowedItems = filterBranchItemsByWindow(selectedItems, request);
  // Exact cohort identity is settled before metric windows. Ordinary List
  // analytics retain the established Last-active-windowed population.
  const analyticsItems = cohortOptions ? selectedItems : windowedItems;
  const analyticsSessionIds = collectSessionIds(analyticsItems);
  const denominatorKeys = denominatorEligibleBranchKeys(resolvedEligibility);
  const denominatorIdSet = new Set(denominatorKeys.map(encodeBranchId));
  const denominatorLinkRows = linkRows.filter((row) =>
    denominatorIdSet.has(encodeBranchId(row))
  );
  const denominatorItems = selectDesktopDenominatorItems(
    allItems.filter((item) => denominatorIdSet.has(item.id)),
    selectedItems,
    request,
    Boolean(cohortOptions)
  );
  const denominatorItemIds = new Set(denominatorItems.map((item) => item.id));
  const scopedDenominatorLinkRows = denominatorLinkRows.filter((row) =>
    denominatorItemIds.has(encodeBranchId(row))
  );
  const denominatorSessionIds = new Set(
    scopedDenominatorLinkRows.map((row) => row.sessionId)
  );
  const windowActive = isDateWindowActive(request);
  const windowedUsageRows = windowActive
    ? filterEventRowsByEventWindow(
        eventRows.filter((row) => analyticsSessionIds.has(row.sessionId)),
        request
      )
    : usageTokenRows.filter((row) => analyticsSessionIds.has(row.sessionId));

  const totalSpendUsd = sumStoredBranchCost(
    windowedUsageRows.map(branchUsageRowFromTokenRow)
  );
  if (isAnomalousSpendTotal(totalSpendUsd)) {
    writePersistentLog(
      "warn",
      "branch-analytics",
      `invalid AI-spend total ${String(totalSpendUsd)} over ${windowedUsageRows.length} usage row(s); reporting no-data`
    );
  }
  const canonicalSessionIds = [
    ...new Set([...analyticsSessionIds, ...denominatorSessionIds]),
  ];
  const [branchCountBySession, aiSpendFacts] = await Promise.all([
    readSessionBranchCounts(prisma, canonicalSessionIds, denominatorKeys),
    // `denominatorKeys`, not `denominatorItems`: the even-split divisor is the
    // whole publication-gated eligible set, which is what web passes
    // (`branchMetricDenominatorIdsSql` under `branchListQuerySchema.parse({})`,
    // apps/api/app/branches/branch-cohort-cost-facts.ts). `denominatorItems`
    // carries the request's repo/owner/status/search/loc filters, so narrowing
    // the list would shrink the divisor with it and report a shared session's
    // whole cost against the one branch that survived the filter.
    readDesktopCohortAiSpendFacts(
      prisma,
      branchKeyRows(filterCanonicalDesktopCohort(analyticsItems, request)),
      branchKeyRows(denominatorKeys),
      request,
      requestBoundary
    ).catch((error: unknown) => {
      // Fail open to an Unavailable spend card, the way web's cost read settles
      // rather than rejects: a throw inside this `Promise.all` would reject the
      // whole builder, and `getSharedBranchesPageData` would drop EVERY card.
      writePersistentLog(
        "warn",
        "branch-analytics",
        `AI-spend fold failed (${String(error)}); reporting no cost facts`
      );
      return undefined;
    }),
  ]);
  const analytics = projectBranchAnalytics(analyticsItems);
  const canonicalMetrics = projectDesktopCanonicalMetrics(
    analyticsItems,
    eligibleLinkRows,
    eligiblePrRows,
    request,
    requestBoundary,
    eventRows,
    branchCountBySession,
    buildPhaseEvidence(activitySegmentEvidence, lifecycleEvidence),
    isEligibilityCoverageCompleteForCohort(resolvedEligibility),
    resolvedEligibility.pullRequestCoverageComplete,
    denominatorItems,
    scopedDenominatorLinkRows,
    !cohortOptions,
    // ISS-9956: the session-deduped total of the windowed usage rows, which the
    // canonical LOC per $ divides.
    totalSpendUsd ?? undefined,
    aiSpendFacts
  );
  analytics.canonicalMetrics = canonicalMetrics;
  const spendKpis = canonicalSpendKpis(canonicalMetrics);
  analytics.totalSpendUsd = spendKpis.totalSpendUsd;
  analytics.locPerDollar = spendKpis.locPerDollar;
  cohortOptions?.onMatchedBranchIds(selectedItems.map((item) => item.id));
  return analytics;
}

function branchKeyRows(
  items: readonly { repoFullName: string | null; branchName: string }[]
): BranchKeyRow[] {
  return items.map((item) => ({
    repoFullName: item.repoFullName,
    branchName: item.branchName,
  }));
}

/** Keep exact-cohort cost on exact identities; never widen by repository. */
export function selectDesktopDenominatorItems(
  authorityItems: Readonly<ReturnType<typeof projectBranchListItems>>,
  selectedItems: Readonly<ReturnType<typeof projectBranchListItems>>,
  request: SharedBranchesQuery,
  exactCohort: boolean
) {
  const filtered = filterCanonicalDesktopCohort(authorityItems, request);
  if (!exactCohort) {
    return filtered;
  }
  const selectedIds = new Set(selectedItems.map((item) => item.id));
  return filtered.filter((item) => selectedIds.has(item.id));
}
