import {
  type BranchAnalytics,
  BranchKpiState,
  type BranchListResponse,
  type BranchRow,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import {
  BranchCollaboratorSource,
  type BranchCollaborators,
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import {
  type BranchListMetricValue,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
  type BranchMetricWindow,
} from "@repo/api/src/types/branch-metrics";
import { Priority } from "@repo/api/src/types/common";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  kpi,
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { createFixtureInstant } from "./fixture-clock";
import { liveAppShellRoutes } from "./live-app-fixtures";

// The live Branches list (`apps/app/.../branches/page.tsx`) reads the server
// page (`GET /branches?pageMode=server&limit=…`), the summary analytics
// (`GET /branches/analytics`), an unpaged cohort read (`GET /branches` with
// `limit=100`), the status ordering and, when filtered, the cohort analytics. These are one populated week of a
// team's branches, dated inside the default 7-day window.

const fixtureInstant = createFixtureInstant("2026-10-06T00:00:00.000Z");

const TEAM = ["Dana Reyes", "Priya Shah", "Marco Lind"] as const;

/** Everyone on the team but the owner reviewed or pushed to the branch. */
function collaboratorsBesides(owner: string | null): BranchCollaborators {
  const complete = BranchIdentityAvailability.Complete;
  return {
    availability: complete,
    people: TEAM.filter((name) => name !== owner).map((name) => ({
      displayName: name,
      id: name.toLowerCase().replace(" ", "-"),
      provider: BranchPersonProvider.ClosedLoop,
    })),
    sources: {
      [BranchCollaboratorSource.BranchComments]: complete,
      [BranchCollaboratorSource.PullRequestAuthors]: complete,
      [BranchCollaboratorSource.PullRequestComments]: complete,
      [BranchCollaboratorSource.Pushes]: complete,
      [BranchCollaboratorSource.SessionComments]: complete,
    },
  };
}

type RowSeed = Partial<BranchRow> &
  Pick<BranchRow, "id" | "branchName" | "status" | "lastActivityAt">;

function branchRow(seed: RowSeed): BranchRow {
  return {
    additions: 120,
    ahead: 3,
    baseBranch: "main",
    behind: 0,
    checksPassed: null,
    checksStatus: null,
    checksTotal: null,
    deletions: 24,
    estimatedCostUsd: 6.2,
    filesChanged: 6,
    multiPrWarning: false,
    owner: "Dana Reyes",
    prNumber: null,
    prState: null,
    prTitle: null,
    prUrl: null,
    repoFullName: "closedloop-ai/closedloop-ai",
    reviewDecision: null,
    sessionIds: [`session-${seed.id}`],
    ...seed,
    collaborators: collaboratorsBesides(seed.owner ?? "Dana Reyes"),
  };
}

export function pr(
  num: number,
  title: string,
  state: BranchRow["prState"],
  repo = "closedloop-ai/closedloop-ai"
) {
  return {
    prNumber: num,
    prState: state,
    prTitle: title,
    prUrl: `https://github.com/${repo}/pull/${num}`,
  };
}

export const branchesListRowsFixture: BranchRow[] = [
  branchRow({
    ...pr(7031, "Branch trace timeline: session lanes", GitHubPRState.Open),
    additions: 412,
    checksPassed: 18,
    checksStatus: ChecksStatus.Pending,
    checksTotal: 21,
    deletions: 96,
    estimatedCostUsd: 14.8,
    filesChanged: 17,
    id: "branch-4410",
    branchName: "fea-4410-branch-trace",
    lastActivityAt: fixtureInstant("2026-10-06T09:24:00.000Z"),
    priority: Priority.High,
    sessionIds: ["session-4182", "session-4175"],
    status: BranchStatus.Review,
  }),
  branchRow({
    ...pr(
      7012,
      "Retry desktop sync after gateway errors",
      GitHubPRState.Open,
      "closedloop-ai/desktop"
    ),
    additions: 188,
    checksPassed: 14,
    checksStatus: ChecksStatus.Failing,
    checksTotal: 16,
    deletions: 41,
    estimatedCostUsd: 3.15,
    filesChanged: 7,
    id: "branch-11420",
    branchName: "iss-11420-retry-sync",
    lastActivityAt: fixtureInstant("2026-10-05T16:12:00.000Z"),
    owner: "Priya Shah",
    priority: Priority.Urgent,
    repoFullName: "closedloop-ai/desktop",
    reviewDecision: ReviewDecision.ChangesRequested,
    status: BranchStatus.Blocked,
  }),
  branchRow({
    ...pr(6988, "Sessions CSV export", GitHubPRState.Merged),
    additions: 640,
    checksPassed: 21,
    checksStatus: ChecksStatus.Passing,
    checksTotal: 21,
    deletions: 120,
    estimatedCostUsd: 9.8,
    filesChanged: 22,
    id: "branch-4388",
    branchName: "fea-4388-csv-export",
    lastActivityAt: fixtureInstant("2026-10-04T12:03:00.000Z"),
    mergedAt: fixtureInstant("2026-10-04T15:40:00.000Z"),
    priority: Priority.Medium,
    reviewDecision: ReviewDecision.Approved,
    status: BranchStatus.Merged,
  }),
  branchRow({
    additions: 22,
    deletions: 14,
    estimatedCostUsd: 1.9,
    filesChanged: 2,
    id: "branch-11391",
    branchName: "iss-11391-flaky-e2e",
    lastActivityAt: fixtureInstant("2026-10-03T14:11:00.000Z"),
    owner: "Marco Lind",
    priority: Priority.Low,
    status: BranchStatus.Open,
  }),
  branchRow({
    ...pr(6971, "Tag picker keyboard navigation", GitHubPRState.Merged),
    additions: 233,
    checksPassed: 21,
    checksStatus: ChecksStatus.Passing,
    checksTotal: 21,
    deletions: 58,
    estimatedCostUsd: 4.6,
    filesChanged: 9,
    id: "branch-4375",
    branchName: "fea-4375-tag-picker",
    lastActivityAt: fixtureInstant("2026-10-02T10:21:00.000Z"),
    mergedAt: fixtureInstant("2026-10-02T13:05:00.000Z"),
    owner: "Priya Shah",
    priority: Priority.Medium,
    reviewDecision: ReviewDecision.Approved,
    status: BranchStatus.Merged,
  }),
  branchRow({
    ...pr(6962, "Loop usage chart axis labels", GitHubPRState.Open),
    additions: 97,
    checksPassed: 21,
    checksStatus: ChecksStatus.Passing,
    checksTotal: 21,
    deletions: 30,
    estimatedCostUsd: 2.7,
    filesChanged: 4,
    id: "branch-11377",
    branchName: "iss-11377-loop-usage",
    lastActivityAt: fixtureInstant("2026-10-01T17:14:00.000Z"),
    owner: "Marco Lind",
    priority: Priority.Low,
    reviewDecision: ReviewDecision.Approved,
    status: BranchStatus.Review,
  }),
  branchRow({
    ...pr(
      6950,
      "Compute target health indicators",
      GitHubPRState.Merged,
      "closedloop-ai/desktop"
    ),
    additions: 301,
    checksPassed: 16,
    checksStatus: ChecksStatus.Passing,
    checksTotal: 16,
    deletions: 77,
    estimatedCostUsd: 5.3,
    filesChanged: 11,
    id: "branch-4362",
    branchName: "fea-4362-compute-targets",
    lastActivityAt: fixtureInstant("2026-10-01T10:08:00.000Z"),
    mergedAt: fixtureInstant("2026-10-01T16:30:00.000Z"),
    priority: Priority.High,
    repoFullName: "closedloop-ai/desktop",
    reviewDecision: ReviewDecision.Approved,
    status: BranchStatus.Merged,
  }),
  branchRow({
    ...pr(6944, "Guided onboarding checklist order", GitHubPRState.Open),
    additions: 48,
    deletions: 19,
    estimatedCostUsd: 1.2,
    filesChanged: 3,
    id: "branch-11360",
    branchName: "iss-11360-onboarding-copy",
    lastActivityAt: fixtureInstant("2026-10-01T14:32:00.000Z"),
    owner: "Priya Shah",
    priority: Priority.Medium,
    status: BranchStatus.Draft,
  }),
];

export function branchListResponse(items: BranchRow[]): BranchListResponse {
  return {
    items,
    total: items.length,
    viewerScope: BranchViewerScope.Organization,
  };
}

const WINDOW: BranchMetricWindow = {
  endAt: fixtureInstant("2026-10-06T23:59:59.999Z"),
  startAt: fixtureInstant("2026-09-30T00:00:00.000Z"),
};
const PRIOR_WINDOW: BranchMetricWindow = {
  endAt: fixtureInstant("2026-09-29T23:59:59.999Z"),
  startAt: fixtureInstant("2026-09-23T00:00:00.000Z"),
};

function metric(value: number, deltaPct: number): BranchListMetricValue {
  return {
    comparison: {
      deltaPct: { state: BranchMetricAvailability.Complete, value: deltaPct },
      label: BranchMetricComparisonLabel.WeekOverWeek,
      priorWindow: PRIOR_WINDOW,
    },
    current: { state: BranchMetricAvailability.Complete, value },
  };
}

const totalSpend = branchesListRowsFixture.reduce(
  (sum, row) => sum + (row.estimatedCostUsd ?? 0),
  0
);

export const branchesAnalyticsFixture: BranchAnalytics = makeBranchAnalytics({
  activeBranchCount: kpi(BranchKpiState.Available, 8),
  activePrCount: kpi(BranchKpiState.Available, 4),
  buildVsReworkSplit: {
    buildPct: 78,
    reworkPct: 22,
    state: BranchKpiState.Available,
  },
  canonicalMetrics: makeBranchListMetrics({
    activeBranches: metric(8, 14),
    aiSpendUsd: metric(Number(totalSpend.toFixed(2)), 9),
    cohortSize: branchesListRowsFixture.length,
    label: BranchMetricComparisonLabel.WeekOverWeek,
    lastActiveAt: {
      state: BranchMetricAvailability.Complete,
      value: fixtureInstant("2026-10-06T09:24:00.000Z"),
    },
    canonicalLocPerDollar: metric(118, 6),
    locPerDollar: metric(118, 6),
    medianPrSize: metric(233, -12),
    mergeRatePct: metric(60, 20),
    period: BranchMetricPeriod.SevenDays,
    totalLocPushed: metric(2179, 31),
    window: WINDOW,
  }),
  leadTimeForChangeMs: kpi(BranchKpiState.Available, 19 * 60 * 60 * 1000),
  locPerDollar: kpi(BranchKpiState.Available, 118),
  medianPrSize: kpi(BranchKpiState.Available, 233),
  medianTimeToMergeMs: kpi(BranchKpiState.Available, 6 * 60 * 60 * 1000),
  mergeRate: kpi(BranchKpiState.Available, 0.6),
  mergedCount: kpi(BranchKpiState.Available, 3),
  totalSpendUsd: kpi(BranchKpiState.Available, totalSpend),
  viewerScope: BranchViewerScope.Organization,
});

/** A workspace with no branch activity: every summary metric has no data. */
export const branchesEmptyAnalytics: BranchAnalytics = makeBranchAnalytics({
  viewerScope: BranchViewerScope.Organization,
});

/** The routes the live Branches list reads, answered with `rows`. */
export function branchesListRoutes(
  rows: BranchRow[] = branchesListRowsFixture,
  analytics: BranchAnalytics = branchesAnalyticsFixture
): FixtureRoute[] {
  return [
    ...liveAppShellRoutes,
    { method: "GET", path: "/branches/analytics", respond: () => analytics },
    // A filtered view asks for the cohort recompute; a 404 is the answer the
    // data source reads as "recompute the filtered cohort client-side".
    {
      method: "POST",
      path: "/branches/analytics/cohort",
      respond: () => null,
      status: 404,
    },
    {
      method: "GET",
      path: "/branches",
      respond: () => branchListResponse(rows),
    },
  ];
}

export const branchesListApiRoutes = branchesListRoutes();
