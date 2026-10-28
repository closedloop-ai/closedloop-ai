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
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import {
  keepPreviousData,
  type QueryClient,
  useQueryClient,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type {
  BranchesDataSource,
  BranchQueryFilters,
} from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import {
  BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS,
  BRANCH_DETAIL_REFRESH_FOLLOW_UP_LIMIT,
} from "../use-branch-detail-refresh-follow-up";
import {
  branchesKeys,
  useBranchAnalytics,
  useBranchCohortAnalytics,
  useBranchComments,
  useBranchDetail,
  useBranchesPageData,
  useBranchTrace,
  useBranchUsage,
} from "../use-branches";

const EMPTY_KPI: BranchKpi = {
  value: null,
  state: "unavailable",
  baseline30d: null,
  deltaPct: null,
};

const USAGE_FIXTURE: BranchUsageSummary = {
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

const ANALYTICS_FIXTURE: BranchAnalytics = {
  viewerScope: "self",
  medianPrSize: EMPTY_KPI,
  mergeRate: EMPTY_KPI,
  medianTimeToMergeMs: EMPTY_KPI,
  activePrCount: EMPTY_KPI,
  mergedCount: EMPTY_KPI,
  leadTimeForChangeMs: EMPTY_KPI,
  locPerDollar: EMPTY_KPI,
  totalSpendUsd: EMPTY_KPI,
  activeBranchCount: EMPTY_KPI,
  buildVsReworkSplit: { buildPct: null, reworkPct: null, state: "unavailable" },
};

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

type SpyingSource = BranchesDataSource & {
  listSpy: ReturnType<typeof vi.fn>;
  detailSpy: ReturnType<typeof vi.fn>;
  commentsSpy: ReturnType<typeof vi.fn>;
  traceSpy: ReturnType<typeof vi.fn>;
  usageSpy: ReturnType<typeof vi.fn>;
  analyticsSpy: ReturnType<typeof vi.fn>;
  listStatusOrderingSpy: ReturnType<typeof vi.fn>;
  cohortAnalyticsSpy: ReturnType<typeof vi.fn>;
  pageDataSpy: ReturnType<typeof vi.fn>;
};

function spyingSource(scope = "local"): SpyingSource {
  const listSpy = vi.fn((_filters: BranchQueryFilters) =>
    Promise.resolve({ items: [], total: 0, viewerScope: "self" as const })
  );
  const detailSpy = vi.fn((id: string) => Promise.resolve(makeDetail(id)));
  const commentsSpy = vi.fn((id: string) =>
    Promise.resolve(makeCommentsResponse(id))
  );
  const traceSpy = vi.fn((_id: string, _options?: { signal?: AbortSignal }) =>
    Promise.resolve(unavailableBranchTraceResult())
  );
  const usageSpy = vi.fn((_filters: BranchQueryFilters) =>
    Promise.resolve(USAGE_FIXTURE)
  );
  const analyticsSpy = vi.fn((_filters: BranchQueryFilters) =>
    Promise.resolve(ANALYTICS_FIXTURE)
  );
  const listStatusOrderingSpy = vi.fn(() => Promise.resolve({}));
  const cohortAnalyticsSpy = vi.fn(() => Promise.resolve(null));
  const pageDataSpy = vi.fn((_filters: BranchQueryFilters) =>
    Promise.resolve({
      list: { items: [], total: 0, viewerScope: "self" as const },
      analytics: ANALYTICS_FIXTURE,
    })
  );
  return {
    scope,
    list: listSpy,
    detail: detailSpy,
    comments: commentsSpy,
    trace: traceSpy,
    usage: usageSpy,
    analytics: analyticsSpy,
    listStatusOrdering: listStatusOrderingSpy,
    cohortAnalytics: cohortAnalyticsSpy,
    pageData: pageDataSpy,
    listSpy,
    detailSpy,
    commentsSpy,
    traceSpy,
    usageSpy,
    analyticsSpy,
    listStatusOrderingSpy,
    cohortAnalyticsSpy,
    pageDataSpy,
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

describe("branchesKeys", () => {
  it("places scope between the read-type prefix and the filters/id", () => {
    expect(branchesKeys.pageData("local", { owner: "alice" })).toEqual([
      "branches",
      "page-data",
      "local",
      "default",
      { owner: "alice" },
    ]);
    expect(branchesKeys.list("local", { owner: "alice" })).toEqual([
      "branches",
      "list",
      "local",
      "default",
      { owner: "alice" },
    ]);
    expect(branchesKeys.detail("local", "b1")).toEqual([
      "branches",
      "detail",
      "local",
      "default",
      "b1",
      null,
    ]);
    expect(branchesKeys.comments("local", "b1")).toEqual([
      "branches",
      "comments",
      "local",
      "default",
      "b1",
      null,
    ]);
    expect(branchesKeys.trace("local", "b1")).toEqual([
      "branches",
      "trace",
      "local",
      "default",
      "b1",
    ]);
    expect(branchesKeys.usage("local", {})).toEqual([
      "branches",
      "usage",
      "local",
      "default",
      {},
    ]);
    expect(branchesKeys.analytics("local", {})).toEqual([
      "branches",
      "analytics",
      "local",
      "default",
      {},
    ]);
    expect(
      branchesKeys.cohortAnalytics("local", { branchIds: ["b1"] })
    ).toEqual([
      "branches",
      "cohort-analytics",
      "local",
      "default",
      { branchIds: ["b1"] },
    ]);
  });

  it("accepts caller-owned cache identity for org-scoped HTTP reads", () => {
    const identity = { cacheScope: "org:acme" };
    expect(branchesKeys.pageData("http", {}, identity)).toEqual([
      "branches",
      "page-data",
      "http",
      "org:acme",
      {},
    ]);
    expect(branchesKeys.detail("http", "b1", identity)).toEqual([
      "branches",
      "detail",
      "http",
      "org:acme",
      "b1",
      null,
    ]);
    expect(branchesKeys.comments("http", "b1", identity)).toEqual([
      "branches",
      "comments",
      "http",
      "org:acme",
      "b1",
      null,
    ]);
    expect(branchesKeys.trace("http", "b1", identity)).toEqual([
      "branches",
      "trace",
      "http",
      "org:acme",
      "b1",
    ]);
    expect(branchesKeys.usage("http", {}, identity)).toEqual([
      "branches",
      "usage",
      "http",
      "org:acme",
      {},
    ]);
    expect(branchesKeys.analytics("http", {}, identity)).toEqual([
      "branches",
      "analytics",
      "http",
      "org:acme",
      {},
    ]);
  });

  it("separates selected pull requests by exact repository-qualified identity", () => {
    const selection = {
      repositoryFullName: "closedloop-ai/closedloop-ai",
      pullRequestNumber: 4473,
    };
    expect(branchesKeys.detail("http", "b1", undefined, selection)).toEqual([
      "branches",
      "detail",
      "http",
      "default",
      "b1",
      selection,
    ]);
    expect(branchesKeys.comments("http", "b1", undefined, selection)).toEqual([
      "branches",
      "comments",
      "http",
      "default",
      "b1",
      selection,
    ]);
  });

  it("keeps the unscoped prefixes matching every scope for batch invalidation", () => {
    expect(branchesKeys.pageDataRoot()).toEqual(["branches", "page-data"]);
    expect(branchesKeys.details()).toEqual(["branches", "detail"]);
    expect(branchesKeys.commentsRoot()).toEqual(["branches", "comments"]);
    expect(branchesKeys.traces()).toEqual(["branches", "trace"]);
    expect(branchesKeys.usages()).toEqual(["branches", "usage"]);
    expect(branchesKeys.analyticsRoot()).toEqual(["branches", "analytics"]);
    expect(branchesKeys.cohortAnalyticsRoot()).toEqual([
      "branches",
      "cohort-analytics",
    ]);
  });
});

function ReadProbe({ source }: { source: BranchesDataSource }) {
  const pageData = useBranchesPageData({ owner: "alice" });
  const usage = useBranchUsage({ owner: "alice" });
  const analytics = useBranchAnalytics({ owner: "alice" });
  const cohortAnalytics = useBranchCohortAnalytics({ branchIds: ["b1"] });
  return (
    <div>
      <span data-testid="pageData">
        {pageData.isSuccess ? `pageData:${source.scope}` : "pageData:loading"}
      </span>
      <span data-testid="usage">
        {usage.isSuccess ? "usage:ok" : "usage:loading"}
      </span>
      <span data-testid="analytics">
        {analytics.isSuccess ? "analytics:ok" : "analytics:loading"}
      </span>
      <span data-testid="cohortAnalytics">
        {cohortAnalytics.isSuccess ? "cohort:ok" : "cohort:loading"}
      </span>
    </div>
  );
}

describe("branch read hooks", () => {
  // ISS-9725: `error` is returned from TWO independent sites — the combined
  // path and the split path — and web's real HTTP source takes the SPLIT one.
  // The Branches failed-read monitor classifies a 401/403 apart from a
  // transport failure by reading this field, so wiring it to the analytics
  // query (or dropping it) would silently report every web failure as
  // `fetch_failed`. Both paths are pinned here because neither host's own
  // suite reaches this module with a rejecting source.
  it("surfaces the list rejection as `error` on the split path", async () => {
    const source = spyingSource("http");
    source.supportsSplitPageData = true;
    source.listSpy.mockImplementation(() =>
      Promise.reject(new ApiError("branches forbidden", 403))
    );

    function SplitErrorProbe() {
      // `retry: false` is pinned rather than inherited so this case settles on
      // the first rejection whatever the ambient client does — the harness
      // client above pins `retry: false` as a default anyway, so nothing here
      // observes the policy. ISS-9789 fixed the clobber that used to make the
      // distinction matter (`commonQueryOptions` no longer spreads an
      // `undefined` `retry` over `shouldRetryQuery`); the policy itself is
      // pinned over the PRODUCTION client in `use-branches-split-retry.test.tsx`.
      const { error } = useBranchesPageData(
        { owner: "alice", limit: 25, offset: 0 },
        { enabled: true, retry: false }
      );
      return (
        <span data-testid="split-error-status">
          {error instanceof ApiError ? String(error.status) : "none"}
        </span>
      );
    }

    render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <SplitErrorProbe />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(
      () =>
        expect(screen.getByTestId("split-error-status")).toHaveTextContent(
          "403"
        ),
      { timeout: 5000 }
    );
    // The analytics half is held closed while the list is failing, so a wiring
    // that read `analyticsQuery.error` would render "none" here.
    expect(source.analyticsSpy).not.toHaveBeenCalled();
  });

  // The paired positive: the same source RESOLVING leaves `error` null, so the
  // "403" above proves the rejection was carried, not that the probe renders a
  // status unconditionally.
  it("leaves `error` null when the split list resolves", async () => {
    const source = spyingSource("http");
    source.supportsSplitPageData = true;
    source.listSpy.mockResolvedValue({
      items: [makeBranchRow("resolved-branch")],
      total: 1,
      viewerScope: "self",
    });

    function ResolvedErrorProbe() {
      const { data, error } = useBranchesPageData(
        { owner: "alice", limit: 25, offset: 0 },
        { enabled: true }
      );
      return (
        <div>
          <span data-testid="resolved-rows">
            {data?.list.items[0]?.id ?? "none"}
          </span>
          <span data-testid="resolved-error">
            {error === null ? "null" : "present"}
          </span>
        </div>
      );
    }

    render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <ResolvedErrorProbe />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(
      () =>
        expect(screen.getByTestId("resolved-rows")).toHaveTextContent(
          "resolved-branch"
        ),
      { timeout: 5000 }
    );
    expect(screen.getByTestId("resolved-error")).toHaveTextContent("null");
  });

  it("surfaces the list rejection as `error` on the combined path", async () => {
    const source = spyingSource("local");
    source.pageDataSpy.mockImplementation(() =>
      Promise.reject(new ApiError("branches unavailable", 503))
    );

    function CombinedErrorProbe() {
      const { error } = useBranchesPageData({ owner: "alice" });
      return (
        <span data-testid="combined-error-status">
          {error instanceof ApiError ? String(error.status) : "none"}
        </span>
      );
    }

    render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <CombinedErrorProbe />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(
      () =>
        expect(screen.getByTestId("combined-error-status")).toHaveTextContent(
          "503"
        ),
      { timeout: 5000 }
    );
  });

  it("renders the current list while split analytics is still pending", async () => {
    let resolveAnalytics: ((value: BranchAnalytics) => void) | undefined;
    const analyticsPending = new Promise<BranchAnalytics>((resolve) => {
      resolveAnalytics = resolve;
    });
    const source = spyingSource("http");
    source.supportsSplitPageData = true;
    source.listSpy.mockResolvedValue({
      items: [makeBranchRow("current-branch")],
      total: 1,
      viewerScope: "self",
    });
    source.analyticsSpy.mockReturnValue(analyticsPending);

    function SplitProbe() {
      const result = useBranchesPageData(
        {
          owner: "alice",
          limit: 25,
          offset: 0,
        },
        { enabled: true }
      );
      return (
        <div>
          <span data-testid="split-row">
            {result.data?.list.items[0]?.id ?? "none"}
          </span>
          <span data-testid="split-analytics">
            {result.analyticsPending ? "analytics:pending" : "analytics:done"}
          </span>
        </div>
      );
    }

    render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <SplitProbe />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() =>
      expect(screen.getByTestId("split-row")).toHaveTextContent(
        "current-branch"
      )
    );
    expect(screen.getByTestId("split-analytics")).toHaveTextContent(
      "analytics:pending"
    );
    expect(source.pageDataSpy).not.toHaveBeenCalled();
    expect(source.analyticsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "alice" })
    );
    expect(source.analyticsSpy.mock.calls[0][0]).not.toMatchObject({
      limit: 25,
      offset: 0,
      forceRefresh: expect.anything(),
    });

    resolveAnalytics?.(ANALYTICS_FIXTURE);
  });

  it("waits for current-key list data before split analytics on filter changes", async () => {
    let resolveBobList: ((value: BranchListResponse) => void) | undefined;
    const source = spyingSource("http");
    source.supportsSplitPageData = true;
    source.listSpy.mockImplementation((filters: BranchQueryFilters) => {
      if (filters.owner === "bob") {
        return new Promise<BranchListResponse>((resolve) => {
          resolveBobList = resolve;
        });
      }
      return Promise.resolve({
        items: [makeBranchRow("alice-branch")],
        total: 1,
        viewerScope: "self" as const,
      });
    });
    source.analyticsSpy.mockResolvedValue(ANALYTICS_FIXTURE);

    function SplitProbe({ owner }: { owner: string }) {
      const result = useBranchesPageData(
        { owner },
        { placeholderData: keepPreviousData }
      );
      return (
        <span data-testid="split-row">
          {result.data?.list.items[0]?.id ?? "none"}
        </span>
      );
    }

    const { rerender } = render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <SplitProbe owner="alice" />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() =>
      expect(screen.getByTestId("split-row")).toHaveTextContent("alice-branch")
    );
    await waitFor(() =>
      expect(source.analyticsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "alice" })
      )
    );
    source.analyticsSpy.mockClear();

    rerender(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <SplitProbe owner="bob" />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() =>
      expect(screen.getByTestId("split-row")).toHaveTextContent("alice-branch")
    );
    await waitFor(() =>
      expect(source.listSpy).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "bob" })
      )
    );
    expect(source.analyticsSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ owner: "bob" })
    );

    resolveBobList?.({
      items: [makeBranchRow("bob-branch")],
      total: 1,
      viewerScope: "self",
    });

    await waitFor(() =>
      expect(screen.getByTestId("split-row")).toHaveTextContent("bob-branch")
    );
    expect(source.analyticsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "bob" })
    );
  });

  it("drops stale split analytics when a refetch fails after prior data", async () => {
    const source = spyingSource("http");
    source.supportsSplitPageData = true;
    source.listSpy.mockResolvedValue({
      items: [makeBranchRow("branch-1")],
      total: 1,
      viewerScope: "self",
    });
    source.analyticsSpy.mockResolvedValueOnce(ANALYTICS_FIXTURE);
    let refetchAnalytics: (() => Promise<unknown>) | undefined;

    function SplitProbe() {
      const result = useBranchesPageData({ owner: "alice" }, { retry: false });
      refetchAnalytics = result.refetchAnalytics;
      return (
        <div>
          <span data-testid="split-analytics-state">
            {result.data?.analytics ? "analytics:present" : "analytics:missing"}
          </span>
          <span data-testid="split-analytics-error">
            {result.analyticsError ? "analytics:error" : "analytics:ok"}
          </span>
        </div>
      );
    }

    render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <SplitProbe />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() =>
      expect(screen.getByTestId("split-analytics-state")).toHaveTextContent(
        "analytics:present"
      )
    );

    source.analyticsSpy.mockRejectedValueOnce(new Error("analytics failed"));
    await act(async () => {
      await refetchAnalytics?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId("split-analytics-state")).toHaveTextContent(
        "analytics:missing"
      );
      expect(screen.getByTestId("split-analytics-error")).toHaveTextContent(
        "analytics:error"
      );
    });
  });

  it("delegate pageData/usage/analytics to the injected source with the given filters", async () => {
    const source = spyingSource("local");
    render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <ReadProbe source={source} />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() => {
      expect(screen.getByTestId("pageData")).toHaveTextContent(
        "pageData:local"
      );
      expect(screen.getByTestId("usage")).toHaveTextContent("usage:ok");
      expect(screen.getByTestId("analytics")).toHaveTextContent("analytics:ok");
      expect(screen.getByTestId("cohortAnalytics")).toHaveTextContent(
        "cohort:ok"
      );
    });

    expect(source.pageDataSpy).toHaveBeenCalledWith({ owner: "alice" });
    expect(source.usageSpy).toHaveBeenCalledWith({ owner: "alice" });
    expect(source.analyticsSpy).toHaveBeenCalledWith({ owner: "alice" });
    expect(source.cohortAnalyticsSpy).toHaveBeenCalledWith({
      branchIds: ["b1"],
    });
  });

  it("does not read cohort analytics when the filtered cohort request is absent", () => {
    const source = spyingSource("local");

    function DisabledCohortProbe() {
      const cohortAnalytics = useBranchCohortAnalytics(null);
      return (
        <span data-testid="disabledCohort">{cohortAnalytics.fetchStatus}</span>
      );
    }

    render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <DisabledCohortProbe />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    expect(screen.getByTestId("disabledCohort")).toHaveTextContent("idle");
    expect(source.cohortAnalyticsSpy).not.toHaveBeenCalled();
  });

  it("disables the detail query for an empty id and delegates for a present id", async () => {
    const source = spyingSource("local");

    function DetailProbe({ id }: { id: string }) {
      const detail = useBranchDetail(id);
      return (
        <span data-testid="detail">
          {detail.data ? `detail:${detail.data.id}` : "detail:none"}
        </span>
      );
    }

    const { rerender } = render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <DetailProbe id="" />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    expect(screen.getByTestId("detail")).toHaveTextContent("detail:none");
    expect(source.detailSpy).not.toHaveBeenCalled();

    rerender(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <DetailProbe id="repo%2Fowner::main" />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() =>
      expect(screen.getByTestId("detail")).toHaveTextContent(
        "detail:repo%2Fowner::main"
      )
    );
    expect(source.detailSpy).toHaveBeenCalledWith("repo%2Fowner::main");
  });

  describe("ISS-12278 stale-PR refresh follow-up", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("caps follow-up refetches while every read reports a PR refresh", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const source = spyingSource("http");
      source.detailSpy.mockImplementation((id: string) =>
        Promise.resolve({
          ...makeDetail(id),
          pullRequestRefreshPending: true as const,
        })
      );

      function RefreshProbe() {
        useBranchDetail("branch-1");
        return null;
      }

      render(
        <AppCoreStoryProviders>
          <BranchesDataSourceProvider dataSource={source}>
            <RefreshProbe />
          </BranchesDataSourceProvider>
        </AppCoreStoryProviders>
      );

      await waitFor(() => expect(source.detailSpy).toHaveBeenCalledTimes(1));
      for (
        let followUp = 1;
        followUp <= BRANCH_DETAIL_REFRESH_FOLLOW_UP_LIMIT;
        followUp++
      ) {
        await vi.advanceTimersByTimeAsync(
          BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS
        );
        await waitFor(() =>
          expect(source.detailSpy).toHaveBeenCalledTimes(followUp + 1)
        );
      }
      await vi.advanceTimersByTimeAsync(
        BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS * 2
      );
      expect(source.detailSpy).toHaveBeenCalledTimes(
        BRANCH_DETAIL_REFRESH_FOLLOW_UP_LIMIT + 1
      );
    });
  });

  it("disables the trace query for an empty id and delegates for a present id", async () => {
    const source = spyingSource("local");

    function TraceProbe({ id }: { id: string }) {
      const trace = useBranchTrace(id);
      return (
        <span data-testid="trace">
          {trace.isSuccess ? `trace:${trace.data.items.length}` : "trace:none"}
        </span>
      );
    }

    const { rerender } = render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <TraceProbe id="" />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    expect(screen.getByTestId("trace")).toHaveTextContent("trace:none");
    expect(source.traceSpy).not.toHaveBeenCalled();

    rerender(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <TraceProbe id="repo%2Fowner::main" />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() =>
      expect(screen.getByTestId("trace")).toHaveTextContent("trace:0")
    );
    expect(source.traceSpy).toHaveBeenCalledWith(
      "repo%2Fowner::main",
      expect.objectContaining({ signal: expect.any(Object) })
    );
    expect(source.traceSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it("disables the comments query for an empty id and delegates for a present id", async () => {
    const source = spyingSource("local");

    function CommentsProbe({ id }: { id: string }) {
      const comments = useBranchComments(id);
      return (
        <span data-testid="comments">
          {comments.data
            ? `comments:${comments.data.branchId}`
            : "comments:none"}
        </span>
      );
    }

    const { rerender } = render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <CommentsProbe id="" />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    expect(screen.getByTestId("comments")).toHaveTextContent("comments:none");
    expect(source.commentsSpy).not.toHaveBeenCalled();

    rerender(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <CommentsProbe id="repo%2Fowner::main" />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() =>
      expect(screen.getByTestId("comments")).toHaveTextContent(
        "comments:repo%2Fowner::main"
      )
    );
    expect(source.commentsSpy).toHaveBeenCalledWith("repo%2Fowner::main");
  });

  /**
   * PLN-1535 M3.3 — the pull half of the freshness model (D8). Whether a hidden
   * tab actually pauses a poll is React Query's own focus-manager behavior and
   * is not reliably drivable from jsdom, so the contract is asserted where this
   * change makes it: the options on the resulting query observer.
   */
  describe("interval refetch (PLN-1535 M3.3)", () => {
    async function captureQueryOptions(
      probe: ReactNode,
      queryKey: readonly unknown[],
      configureSource?: (source: SpyingSource) => void
    ) {
      const source = spyingSource("http");
      configureSource?.(source);
      let client: QueryClient | undefined;
      function ClientProbe() {
        client = useQueryClient();
        return null;
      }
      render(
        <AppCoreStoryProviders>
          <BranchesDataSourceProvider dataSource={source}>
            <ClientProbe />
            {probe}
          </BranchesDataSourceProvider>
        </AppCoreStoryProviders>
      );
      await waitFor(() =>
        expect(client?.getQueryCache().find({ queryKey })).toBeDefined()
      );
      return client?.getQueryCache().find({ queryKey })?.observers[0]?.options;
    }

    function PageDataProbe() {
      useBranchesPageData({ owner: "alice" });
      return null;
    }

    function SplitPageDataProbe() {
      useBranchesPageData({ owner: "alice" });
      return null;
    }

    function DetailProbe({ intervalMs }: { intervalMs?: number }) {
      useBranchDetail(
        "branch-1",
        intervalMs === undefined ? undefined : { refetchInterval: intervalMs }
      );
      return null;
    }

    it("polls the branches list clear of the 90s hydration TTL", async () => {
      // 120s, not 90s: `LIST_TTL_MS` is also 90s and TanStack restarts the
      // interval on settle, so an equal interval cleared expiry only by the
      // previous fetch's round-trip. Losing that race re-rendered the identical
      // cached overlay — a refresh cycle where nothing changed.
      const options = await captureQueryOptions(
        <PageDataProbe />,
        branchesKeys.pageData("http", { owner: "alice" })
      );

      expect(options?.refetchInterval).toBe(120_000);
      // The whole point is VISIBLE-tab: a hidden window must not poll the cloud
      // on a timer. Opposite of the desktop Sessions poll, where background
      // polling is load-bearing.
      expect(options?.refetchIntervalInBackground).not.toBe(true);
    });

    it("polls split analytics on the same visible-tab cadence as rows", async () => {
      const options = await captureQueryOptions(
        <SplitPageDataProbe />,
        branchesKeys.analytics("http", { owner: "alice" }),
        (source) => {
          source.supportsSplitPageData = true;
        }
      );

      expect(options?.refetchInterval).toBe(120_000);
      expect(options?.refetchIntervalInBackground).not.toBe(true);
    });

    it("polls an open branch detail on the approved five-minute visible-tab cadence", async () => {
      const options = await captureQueryOptions(
        <DetailProbe />,
        branchesKeys.detail("http", "branch-1")
      );

      expect(options?.refetchInterval).toBe(300_000);
      expect(options?.refetchIntervalInBackground).not.toBe(true);
    });

    it("lets a caller override the default cadence", async () => {
      const options = await captureQueryOptions(
        <DetailProbe intervalMs={5000} />,
        branchesKeys.detail("http", "branch-1")
      );

      expect(options?.refetchInterval).toBe(5000);
    });
  });

  it("isolates lazy trace reads by caller-owned cache identity", async () => {
    const source = spyingSource("http");

    function TraceProbe({ cacheScope }: { cacheScope: string }) {
      const trace = useBranchTrace("branch-1", undefined, { cacheScope });
      return (
        <span data-testid="trace">
          {trace.isSuccess ? `trace:${cacheScope}` : "trace:none"}
        </span>
      );
    }

    const { rerender } = render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <TraceProbe cacheScope="org:acme" />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() =>
      expect(screen.getByTestId("trace")).toHaveTextContent("trace:org:acme")
    );

    rerender(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <TraceProbe cacheScope="org:globex" />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() =>
      expect(screen.getByTestId("trace")).toHaveTextContent("trace:org:globex")
    );
    expect(source.traceSpy).toHaveBeenCalledTimes(2);
  });
});
