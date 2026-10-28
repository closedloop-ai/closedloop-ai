import type {
  BranchAnalytics,
  BranchKpi,
  BranchListResponse,
  BranchPageDetail,
  BranchRow,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import {
  BranchCommentsState,
  BranchKpiState,
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListCapability,
  BranchListPageMode,
} from "@repo/api/src/types/branch-list-contract";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { keepPreviousData } from "@tanstack/react-query";
import { act, type RenderResult, render } from "@testing-library/react";
import { vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type {
  BranchesDataSource,
  BranchQueryFilters,
} from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { selectPresentedBranchPageData } from "../../lib/branch-page-state";
import { useBranchesPageData } from "../use-branches";

const emptyKpi: BranchKpi = {
  value: null,
  state: "unavailable",
  baseline30d: null,
  deltaPct: null,
};

export const ANALYTICS_FIXTURE: BranchAnalytics = {
  viewerScope: "self",
  medianPrSize: emptyKpi,
  mergeRate: emptyKpi,
  medianTimeToMergeMs: emptyKpi,
  activePrCount: emptyKpi,
  mergedCount: emptyKpi,
  leadTimeForChangeMs: emptyKpi,
  locPerDollar: emptyKpi,
  totalSpendUsd: emptyKpi,
  activeBranchCount: emptyKpi,
  buildVsReworkSplit: { buildPct: null, reworkPct: null, state: "unavailable" },
};

export const SEVEN_DAY_START = "2026-08-15T00:00:00.000Z";
export const THIRTY_DAY_START = "2026-07-23T00:00:00.000Z";

export type SpyingSource = BranchesDataSource & {
  listSpy: ReturnType<typeof vi.fn>;
  analyticsSpy: ReturnType<typeof vi.fn>;
  listStatusOrderingSpy: ReturnType<typeof vi.fn>;
  pageDataSpy: ReturnType<typeof vi.fn>;
};

export function renderServerPageProbe(
  source: SpyingSource,
  showAnalyticsState = false
): RenderResult {
  function ServerPageProbe() {
    const result = useBranchesPageData({
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
    });
    return (
      <div>
        <span data-testid="server-page-row">
          {result.data?.list.items[0]?.id ?? "none"}
        </span>
        {showAnalyticsState ? (
          <span data-testid="server-page-analytics">
            {result.analyticsPending ? "analytics:pending" : "analytics:idle"}
          </span>
        ) : null}
      </div>
    );
  }

  return render(
    <AppCoreStoryProviders>
      <BranchesDataSourceProvider dataSource={source}>
        <ServerPageProbe />
      </BranchesDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

export function renderServerPagePresentedProbe(
  source: SpyingSource,
  filters: BranchQueryFilters
): RenderResult {
  return render(serverPagePresentedProbeTree(source, filters));
}

export function serverPagePresentedProbeTree(
  source: SpyingSource,
  filters: BranchQueryFilters
) {
  return (
    <AppCoreStoryProviders>
      <BranchesDataSourceProvider dataSource={source}>
        <PresentedServerPageProbe filters={filters} />
      </BranchesDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

export function spyingSource(scope = "local"): SpyingSource {
  const listSpy = vi.fn((_filters: BranchQueryFilters) =>
    Promise.resolve({ items: [], total: 0, viewerScope: "self" as const })
  );
  const analyticsSpy = vi.fn((_filters: BranchQueryFilters) =>
    Promise.resolve(ANALYTICS_FIXTURE)
  );
  const listStatusOrderingSpy = vi.fn(() => Promise.resolve({}));
  const pageDataSpy = vi.fn((_filters: BranchQueryFilters) =>
    Promise.resolve({
      list: { items: [], total: 0, viewerScope: "self" as const },
      analytics: ANALYTICS_FIXTURE,
    })
  );
  return {
    scope,
    supportsSplitPageData: false,
    list: listSpy,
    detail: (id) => Promise.resolve(makeDetail(id)),
    comments: (id) => Promise.resolve(makeCommentsResponse(id)),
    trace: () => Promise.resolve(unavailableBranchTraceResult()),
    usage: () => Promise.resolve(usageFixture),
    analytics: analyticsSpy,
    listStatusOrdering: listStatusOrderingSpy,
    cohortAnalytics: () => Promise.resolve(null),
    pageData: pageDataSpy,
    listSpy,
    analyticsSpy,
    listStatusOrderingSpy,
    pageDataSpy,
  };
}

export function serverPageList(id: string): BranchListResponse {
  return {
    items: [makeBranchRow(id)],
    total: 1,
    viewerScope: "self",
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      requestedOffset: 0,
      now: "2026-08-22T18:00:01.000Z",
    },
  };
}

export function legacyServerPageList(id: string): BranchListResponse {
  return {
    items: [makeBranchRow(id)],
    total: 1,
    viewerScope: "self",
  };
}

export function analyticsFixture(activeBranchCount: number): BranchAnalytics {
  return {
    ...ANALYTICS_FIXTURE,
    activeBranchCount: {
      ...emptyKpi,
      value: activeBranchCount,
      state: BranchKpiState.Available,
    },
  };
}

export function rangeFilters(startDate: string): BranchQueryFilters {
  return {
    pageMode: BranchListPageMode.Server,
    limit: BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: 0,
    startDate,
  };
}

export async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const usageFixture: BranchUsageSummary = {
  viewerScope: "self",
  totalBranches: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  totalEstimatedCost: 0,
  subscriptionEstimatedCost: 0,
  apiEstimatedCost: 0,
  hourBuckets: [],
  phaseStacks: [],
  byActor: [],
};

function PresentedServerPageProbe({
  filters,
}: {
  filters: BranchQueryFilters;
}) {
  const result = useBranchesPageData(filters, {
    placeholderData: keepPreviousData,
    staleTime: 90_000,
  });
  const pageData = selectPresentedBranchPageData(result.data, {
    isPlaceholderData: result.isPlaceholderData,
    // This harness exercises the server-page query key, not the saved-view
    // restore, so the view is always settled here.
    isViewReady: true,
  });
  return (
    <div>
      <span data-testid="presented-row">
        {pageData?.list.items[0]?.id ?? "none"}
      </span>
      <span data-testid="presented-active-count">
        {pageData?.analytics?.activeBranchCount.value ?? "none"}
      </span>
    </div>
  );
}

function makeBranchRow(id: string): BranchRow {
  return {
    id,
    branchName: "main",
    baseBranch: null,
    repoFullName: null,
    owner: null,
    status: "open",
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    sessionIds: [],
  };
}

function makeDetail(id: string): BranchPageDetail {
  return {
    ...makeBranchRow(id),
    prBody: null,
    prBodyHtmlUrl: null,
    headSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    openedAt: null,
    commits: [],
    sessions: [],
    mergedTrace: [],
    leadTime: { firstActivityT: null, lastActivityT: null, idleSpans: [] },
    linkedPrNumbers: [],
    linkedArtifacts: [],
  };
}

function makeCommentsResponse(branchId: string): BranchPrCommentsResponse {
  return {
    branchId,
    state: BranchCommentsState.UnsyncedUnknown,
    comments: [],
    budget: {
      maxComments: 100,
      pageSize: 50,
      maxBodyBytes: 16_384,
      maxResponseBytes: 524_288,
      providerTruncated: false,
      responseTruncated: false,
      omittedComments: 0,
      bodyTruncatedCount: 0,
    },
    providerProofedAt: null,
    stale: false,
    mixedProjection: false,
    prNumber: null,
    prUrl: null,
  };
}
