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
import { render, screen, waitFor } from "@testing-library/react";
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
  useBranchComments,
  useBranchDetail,
  useBranches,
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
};

function spyingSource(scope = "local"): SpyingSource {
  const listSpy = vi.fn((_filters: BranchQueryFilters) =>
    Promise.resolve({ items: [], total: 0, viewerScope: "self" as const })
  );
  const detailSpy = vi.fn((id: string) => Promise.resolve(makeDetail(id)));
  const commentsSpy = vi.fn((id: string) =>
    Promise.resolve(makeCommentsResponse(id))
  );
  const traceSpy = vi.fn((_id: string) => Promise.resolve([] as const));
  const usageSpy = vi.fn((_filters: BranchQueryFilters) =>
    Promise.resolve(USAGE_FIXTURE)
  );
  const analyticsSpy = vi.fn((_filters: BranchQueryFilters) =>
    Promise.resolve(ANALYTICS_FIXTURE)
  );
  return {
    scope,
    list: listSpy,
    detail: detailSpy,
    comments: commentsSpy,
    trace: traceSpy,
    usage: usageSpy,
    analytics: analyticsSpy,
    listSpy,
    detailSpy,
    commentsSpy,
    traceSpy,
    usageSpy,
    analyticsSpy,
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
    ]);
    expect(branchesKeys.comments("local", "b1")).toEqual([
      "branches",
      "comments",
      "local",
      "default",
      "b1",
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
  });

  it("accepts caller-owned cache identity for org-scoped HTTP reads", () => {
    const identity = { cacheScope: "org:acme" };
    expect(branchesKeys.list("http", {}, identity)).toEqual([
      "branches",
      "list",
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
    ]);
    expect(branchesKeys.comments("http", "b1", identity)).toEqual([
      "branches",
      "comments",
      "http",
      "org:acme",
      "b1",
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

  it("keeps the unscoped prefixes matching every scope for batch invalidation", () => {
    expect(branchesKeys.lists()).toEqual(["branches", "list"]);
    expect(branchesKeys.details()).toEqual(["branches", "detail"]);
    expect(branchesKeys.commentsRoot()).toEqual(["branches", "comments"]);
    expect(branchesKeys.traces()).toEqual(["branches", "trace"]);
    expect(branchesKeys.usages()).toEqual(["branches", "usage"]);
    expect(branchesKeys.analyticsRoot()).toEqual(["branches", "analytics"]);
  });
});

function ReadProbe({ source }: { source: BranchesDataSource }) {
  const list = useBranches({ owner: "alice" });
  const usage = useBranchUsage({ owner: "alice" });
  const analytics = useBranchAnalytics({ owner: "alice" });
  return (
    <div>
      <span data-testid="list">
        {list.isSuccess ? `list:${source.scope}` : "list:loading"}
      </span>
      <span data-testid="usage">
        {usage.isSuccess ? "usage:ok" : "usage:loading"}
      </span>
      <span data-testid="analytics">
        {analytics.isSuccess ? "analytics:ok" : "analytics:loading"}
      </span>
    </div>
  );
}

describe("branch read hooks", () => {
  it("delegate list/usage/analytics to the injected source with the given filters", async () => {
    const source = spyingSource("local");
    render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <ReadProbe source={source} />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() => {
      expect(screen.getByTestId("list")).toHaveTextContent("list:local");
      expect(screen.getByTestId("usage")).toHaveTextContent("usage:ok");
      expect(screen.getByTestId("analytics")).toHaveTextContent("analytics:ok");
    });

    expect(source.listSpy).toHaveBeenCalledWith({ owner: "alice" });
    expect(source.usageSpy).toHaveBeenCalledWith({ owner: "alice" });
    expect(source.analyticsSpy).toHaveBeenCalledWith({ owner: "alice" });
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
          {trace.isSuccess ? `trace:${trace.data.length}` : "trace:none"}
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
    expect(source.traceSpy).toHaveBeenCalledWith("repo%2Fowner::main");
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
