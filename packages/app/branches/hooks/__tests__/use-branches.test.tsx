import type {
  BranchAnalytics,
  BranchKpi,
  BranchPageDetail,
  BranchRow,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import {
  BranchCommentsState,
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type {
  BranchesDataSource,
  BranchQueryFilters,
} from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import {
  branchesKeys,
  useBranchAnalytics,
  useBranchCohortAnalytics,
  useBranchComments,
  useBranchDetail,
  useBranchesPageData,
  useBranchList,
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
    cohortAnalytics: cohortAnalyticsSpy,
    pageData: pageDataSpy,
    listSpy,
    detailSpy,
    commentsSpy,
    traceSpy,
    usageSpy,
    analyticsSpy,
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
      repositoryFullName: "closedloop-ai/symphony-alpha",
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
  const list = useBranchList({ owner: "alice" });
  const pageData = useBranchesPageData({ owner: "alice" });
  const usage = useBranchUsage({ owner: "alice" });
  const analytics = useBranchAnalytics({ owner: "alice" });
  const cohortAnalytics = useBranchCohortAnalytics({ branchIds: ["b1"] });
  return (
    <div>
      <span data-testid="pageData">
        {pageData.isSuccess ? `pageData:${source.scope}` : "pageData:loading"}
      </span>
      <span data-testid="list">
        {list.isSuccess ? "list:ok" : "list:loading"}
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
      expect(screen.getByTestId("list")).toHaveTextContent("list:ok");
      expect(screen.getByTestId("usage")).toHaveTextContent("usage:ok");
      expect(screen.getByTestId("analytics")).toHaveTextContent("analytics:ok");
      expect(screen.getByTestId("cohortAnalytics")).toHaveTextContent(
        "cohort:ok"
      );
    });

    expect(source.listSpy).toHaveBeenCalledWith({ owner: "alice" });
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
      queryKey: readonly unknown[]
    ) {
      const source = spyingSource("http");
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

    it("polls an open branch detail on the 60s visible-tab cadence", async () => {
      const options = await captureQueryOptions(
        <DetailProbe />,
        branchesKeys.detail("http", "branch-1")
      );

      expect(options?.refetchInterval).toBe(60_000);
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
