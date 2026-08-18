/**
 * Shared fixture builders for the Branches page suites. Extracted from
 * `page.test.tsx` (ISS-5574) when that file reached the 1,000-line ceiling —
 * these are pure data/render helpers with no `vi.mock` coupling, so they move
 * cleanly and are reusable by the sibling Branches suites. Mirrors the existing
 * `sessions-page-test-helpers.tsx` precedent for the Sessions page.
 */
import {
  type BranchAnalytics,
  type BranchesPageData,
  BranchKpiState,
  type BranchListResponse,
  type BranchRow,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { screen } from "@testing-library/react";
import React, { type ReactNode } from "react";

// One day ago, NOT a fixed ISO date: the page's default saved view windows
// rows to the last 30 days of activity (approved dateRange "30d"),
// so a pinned date silently ages out of the window and empties the table —
// this exact fixture went red on 2026-07-08 with zero code change.
export const RECENT_ACTIVITY_AT = new Date(
  Date.now() - 24 * 60 * 60 * 1000
).toISOString();

export function makeBranchRow(overrides: Partial<BranchRow> = {}): BranchRow {
  return {
    additions: 42,
    ahead: null,
    baseBranch: "main",
    behind: null,
    branchName: "feature/web-branches",
    checksPassed: null,
    checksStatus: null,
    checksTotal: null,
    deletions: 8,
    estimatedCostUsd: 12.34,
    filesChanged: 5,
    id: "branch-1",
    lastActivityAt: RECENT_ACTIVITY_AT,
    multiPrWarning: false,
    owner: "Ada",
    prNumber: 123,
    prState: null,
    prTitle: "Wire web branches",
    prUrl: "https://github.com/acme/app/pull/123",
    repoFullName: "acme/app",
    reviewDecision: null,
    sessionIds: ["session-1"],
    status: BranchStatus.Open,
    ...overrides,
  };
}

// `sessionCostUsd` is an OPTIONAL wire field (an older producer omits it), so it
// is spread in only when a caller supplies one rather than serialized as null.
export function makeListResponse(
  items: BranchRow[],
  sessionCostUsd?: Record<string, number>
): BranchListResponse {
  return {
    items,
    total: items.length,
    viewerScope: BranchViewerScope.Organization,
    ...(sessionCostUsd ? { sessionCostUsd } : {}),
  };
}

export function makeAnalytics(): BranchAnalytics {
  const kpi = {
    baseline30d: null,
    deltaPct: null,
    state: BranchKpiState.Available,
    value: 1,
  };
  return {
    activeBranchCount: kpi,
    activePrCount: kpi,
    buildVsReworkSplit: {
      buildPct: 100,
      reworkPct: 0,
      state: BranchKpiState.Available,
    },
    leadTimeForChangeMs: kpi,
    locPerDollar: kpi,
    medianPrSize: kpi,
    medianTimeToMergeMs: kpi,
    mergeRate: kpi,
    mergedCount: kpi,
    totalSpendUsd: kpi,
    viewerScope: BranchViewerScope.Organization,
    canonicalMetrics: makeCanonicalMetrics(),
  };
}

// The full rendered text of one summary KPI card, keyed by its label. Shared by
// both summary-card suites above so they cannot drift on how a card is located.
export function cardText(label: string): string {
  const labelEl = screen.getByText(label);
  const card = labelEl.closest("div")?.parentElement?.parentElement;
  return card?.textContent ?? "";
}

export function renderHeaderMock({
  breadcrumbs,
  children,
}: {
  breadcrumbs: Array<{ label: string }>;
  children: ReactNode;
}) {
  return React.createElement(
    "div",
    { "data-testid": "header" },
    React.createElement(
      "h1",
      { className: "sr-only" },
      breadcrumbs.at(-1)?.label
    ),
    children
  );
}

export function makeCanonicalMetrics(): BranchListMetricBundle {
  const current = (value: number) => ({
    current: {
      state: BranchMetricAvailability.Complete,
      value,
    },
  });
  return {
    period: BranchMetricPeriod.ThirtyDays,
    label: BranchMetricComparisonLabel.MonthOverMonth,
    window: {
      startAt: "2026-06-05T00:00:00.000Z",
      endAt: "2026-07-05T00:00:00.000Z",
    },
    cohortSize: 1,
    lastActiveAt: {
      state: BranchMetricAvailability.Complete,
      value: "2026-07-04T00:00:00.000Z",
    },
    activeBranches: current(1),
    locPerDollar: current(1),
    medianPrSize: current(1),
    aiSpendUsd: current(1),
    mergeRatePct: current(1),
  };
}

export function makeAnalyticsWithCanonicalSpend(
  current: BranchMetricResult<number>
): BranchAnalytics {
  const analytics = makeAnalytics();
  return {
    ...analytics,
    canonicalMetrics: {
      ...makeCanonicalMetrics(),
      aiSpendUsd: { current },
    },
  };
}

/** Build the combined list-and-analytics hook result used by page tests. */
export function pageDataResult({
  list,
  analytics = makeAnalytics(),
  analyticsError = false,
  isError = false,
  isFetching = false,
  isPending = false,
}: {
  list?: BranchListResponse;
  analytics?: BranchAnalytics;
  analyticsError?: boolean;
  isError?: boolean;
  isFetching?: boolean;
  isPending?: boolean;
}): {
  data: BranchesPageData | undefined;
  isError: boolean;
  isFetching: boolean;
  isPending: boolean;
} {
  return {
    data: resolvePageData({ list, analytics, analyticsError }),
    isError,
    isFetching,
    isPending,
  };
}

/** Build a stable exact cohort with one uniquely priced Session per Branch. */
export function makeCohortRows(count: number, owner: string): BranchRow[] {
  return Array.from({ length: count }, (_, index) =>
    makeBranchRow({
      id: `cohort-${index + 1}`,
      branchName: `feature/cohort-${index + 1}`,
      owner,
      sessionIds: [`session-${index + 1}`],
    })
  );
}

function resolvePageData({
  list,
  analytics,
  analyticsError,
}: {
  list?: BranchListResponse;
  analytics: BranchAnalytics;
  analyticsError: boolean;
}): BranchesPageData | undefined {
  if (!list) {
    return undefined;
  }
  if (analyticsError) {
    return { list, analyticsError: true };
  }
  return { list, analytics };
}
