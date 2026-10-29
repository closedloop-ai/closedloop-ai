import type {
  BranchAnalytics,
  BranchesPageData,
  BranchListResponse,
  BranchPageDetail,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import type { BranchAnalyticsCohortResponse } from "@repo/api/src/types/branch-analytics-cohort";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListCapability,
  BranchListFacetAvailability,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchTraceCompletenessState,
  BranchTraceUnavailableReason,
  unavailableBranchTraceResult,
} from "@repo/api/src/types/branch-trace";
import { GitHubDirtyScopeKind } from "@repo/api/src/types/github-dirty-scope-constants";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  ListFilterOperator,
} from "@repo/api/src/types/list-query-expression";
import { BranchListField } from "@repo/api/src/types/list-query-fields";
import { ReadSource } from "@repo/api/src/types/read-source";
import { ApiError } from "@repo/app/shared/api/api-error";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_BRANCH_READ,
  SHARED_BRANCHES_NOT_FOUND_CODE,
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
} from "../../../shared/shared-branches-contract";
import type { DesktopApi } from "../../types/desktop-api";
import { createLocalBranchesDataSource } from "../local-branches-data-source";

const LIST: BranchListResponse = { items: [], total: 3, viewerScope: "self" };
const USAGE = { totalBranches: 3 } as unknown as BranchUsageSummary;
const ANALYTICS = { viewerScope: "self" } as unknown as BranchAnalytics;
const DETAIL = { id: "repo%2Fowner::main" } as unknown as BranchPageDetail;
const PAGE_DATA: BranchesPageData = { list: LIST, analytics: ANALYTICS };

type BranchesApi = DesktopApi["branchesApi"];

function fakeDesktopApi(
  overrides: Partial<BranchesApi> = {},
  onDbChanged?: DesktopApi["onDbChanged"],
  onGitHubResyncNudge?: DesktopApi["onGitHubResyncNudge"]
): Parameters<typeof createLocalBranchesDataSource>[0] {
  return {
    branchesApi: {
      list: vi.fn(async () => LIST),
      detail: vi.fn(async () => DETAIL),
      trace: vi.fn(async () => []),
      usage: vi.fn(async () => USAGE),
      analytics: vi.fn(async () => ANALYTICS),
      pageData: vi.fn(async () => PAGE_DATA),
      ...overrides,
    },
    onDbChanged,
    onGitHubResyncNudge,
  };
}

describe("createLocalBranchesDataSource", () => {
  it("identifies as the local scope", () => {
    expect(createLocalBranchesDataSource(fakeDesktopApi()).scope).toBe("local");
  });

  it("normalizes a legacy raw trace array without inferring complete membership", async () => {
    const source = createLocalBranchesDataSource(fakeDesktopApi());

    await expect(source.trace("branch-1")).resolves.toMatchObject({
      items: [],
      qualifyingSessionCount: null,
      completeness: {
        state: BranchTraceCompletenessState.Unavailable,
        reason: BranchTraceUnavailableReason.LegacyResponse,
      },
    });
  });

  it("preserves a current typed trace result and degrades IPC failure explicitly", async () => {
    const current = unavailableBranchTraceResult(
      [],
      BranchTraceUnavailableReason.Permission
    );
    const currentSource = createLocalBranchesDataSource(
      fakeDesktopApi({ trace: vi.fn(async () => current) })
    );
    await expect(currentSource.trace("branch-1")).resolves.toEqual(current);

    const failedSource = createLocalBranchesDataSource(
      fakeDesktopApi({
        trace: vi.fn(() => Promise.reject(new Error("private path"))),
      })
    );
    await expect(failedSource.trace("branch-1")).resolves.toMatchObject({
      items: [],
      completeness: {
        state: BranchTraceCompletenessState.Unavailable,
        reason: BranchTraceUnavailableReason.Unknown,
      },
    });
  });

  it("propagates request cancellation without serializing the signal over IPC", async () => {
    const abortError = Object.assign(new Error("cancelled"), {
      name: "AbortError",
    });
    const trace = vi.fn(() => Promise.reject(abortError));
    const source = createLocalBranchesDataSource(fakeDesktopApi({ trace }));
    const controller = new AbortController();

    await expect(
      source.trace("branch-1", { signal: controller.signal })
    ).rejects.toBe(abortError);
    expect(trace).toHaveBeenCalledWith("branch-1");
  });

  it("forwards filters to the IPC reads and returns their payloads", async () => {
    const api = fakeDesktopApi();
    const source = createLocalBranchesDataSource(api);

    // FEA-3120: the local source stamps `readSource: local` at the boundary, so
    // the returned envelope carries the local rows *plus* the source tag.
    await expect(source.list({ repo: "x/y", owner: "alice" })).resolves.toEqual(
      { ...LIST, readSource: ReadSource.Local }
    );
    await expect(source.usage({ status: "merged" })).resolves.toBe(USAGE);
    await expect(source.analytics({})).resolves.toBe(ANALYTICS);

    expect(api.branchesApi.list).toHaveBeenCalledWith({
      ...LOCAL_BRANCH_READ,
      repo: "x/y",
      owner: "alice",
    });
    expect(api.branchesApi.usage).toHaveBeenCalledWith({
      ...LOCAL_BRANCH_READ,
      status: "merged",
    });
    expect(api.branchesApi.analytics).toHaveBeenCalledWith(LOCAL_BRANCH_READ);
  });

  it("forwards exact cohorts and degrades an older preload without the method", async () => {
    const cohortResponse = cohortAnalyticsResponse();
    const cohortAnalytics = vi.fn(async () => cohortResponse);
    const current = createLocalBranchesDataSource(
      fakeDesktopApi({ cohortAnalytics })
    );

    await expect(
      current.cohortAnalytics?.({ branchIds: ["branch-1"] })
    ).resolves.toEqual(cohortResponse);
    expect(cohortAnalytics).toHaveBeenCalledWith({
      ...LOCAL_BRANCH_READ,
      branchIds: ["branch-1"],
    });

    const legacy = createLocalBranchesDataSource(fakeDesktopApi());
    await expect(
      legacy.cohortAnalytics?.({ branchIds: ["branch-1"] })
    ).resolves.toBeNull();
  });

  it("forwards and parses the complete 101-branch cohort over IPC", async () => {
    const branchIds = makeBranchIds(101);
    const response = cohortAnalyticsResponse(branchIds);
    const cohortAnalytics = vi.fn(async () => response);
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({ cohortAnalytics })
    );

    await expect(source.cohortAnalytics?.({ branchIds })).resolves.toEqual(
      response
    );
    expect(cohortAnalytics).toHaveBeenCalledWith({
      ...LOCAL_BRANCH_READ,
      branchIds,
    });
  });

  it("maps a cohort IPC rejection to the sanitized source error", async () => {
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({
        cohortAnalytics: vi.fn(() => Promise.reject(new Error("ipc failed"))),
      })
    );

    await expect(
      source.cohortAnalytics?.({ branchIds: ["branch-1"] })
    ).rejects.toMatchObject({
      code: SHARED_BRANCHES_SOURCE_ERROR_CODE,
      status: 500,
    });
  });

  it("rejects a malformed cohort IPC success payload", async () => {
    const api = fakeDesktopApi();
    Object.defineProperty(api.branchesApi, "cohortAnalytics", {
      value: vi.fn(() => Promise.resolve({ matchedBranchIds: [] })),
    });
    const source = createLocalBranchesDataSource(api);

    await expect(
      source.cohortAnalytics?.({ branchIds: ["branch-1"] })
    ).rejects.toMatchObject({
      code: SHARED_BRANCHES_SOURCE_ERROR_CODE,
      status: 500,
    });
  });

  it("degrades a newer AI-spend state without discarding understood IPC metrics", async () => {
    const response = cohortAnalyticsResponse();
    const api = fakeDesktopApi();
    Object.defineProperty(api.branchesApi, "cohortAnalytics", {
      value: vi.fn(() =>
        Promise.resolve({
          ...response,
          canonicalMetrics: {
            ...response.canonicalMetrics,
            aiSpendUsd: {
              current: { state: "future_pending", value: null },
            },
          },
        })
      ),
    });
    const source = createLocalBranchesDataSource(api);

    await expect(
      source.cohortAnalytics?.({ branchIds: ["branch-1"] })
    ).resolves.toEqual({
      ...response,
      canonicalMetrics: {
        ...response.canonicalMetrics,
        aiSpendUsd: {
          current: {
            state: BranchMetricAvailability.Unavailable,
            value: null,
          },
        },
      },
    });
  });

  // FEA-3056 follow-up: the combined list + analytics read forwards through,
  // same as the standalone `list`/`analytics` reads above — including the
  // FEA-3120 `readSource: local` stamp on the nested list (same contract as
  // the standalone `list` read, so the ReadSourceBadge still renders).
  it("forwards filters to the combined page-data read and stamps the nested list local", async () => {
    const api = fakeDesktopApi();
    const source = createLocalBranchesDataSource(api);

    await expect(source.pageData({ repo: "x/y" })).resolves.toEqual({
      ...PAGE_DATA,
      list: { ...LIST, readSource: ReadSource.Local },
    });
    expect(api.branchesApi.pageData).toHaveBeenCalledWith({
      ...LOCAL_BRANCH_READ,
      repo: "x/y",
    });
  });

  it("refetches the legacy complete corpus when an older main omits capability", async () => {
    const api = fakeDesktopApi();
    const source = createLocalBranchesDataSource(api);
    const request = {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 20,
      startDate: "2026-08-01T00:00:00.000Z",
      sortKey: BranchListSortKey.LastActivity,
      sortDir: BranchListSortDirection.Desc,
    };

    await source.pageData(request);

    // PRD-721: the window and sort travel as the `listQuery` expression main
    // compiles back to them; paging stays beside it.
    expect(api.branchesApi.pageData).toHaveBeenNthCalledWith(1, {
      ...LOCAL_BRANCH_READ,
      pageMode: request.pageMode,
      limit: request.limit,
      offset: request.offset,
      [LIST_QUERY_EXPRESSION_PARAM]: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          {
            field: BranchListField.LastActivity,
            operator: ListFilterOperator.IsBetween,
            min: request.startDate,
          },
        ],
        sorts: [{ field: request.sortKey, direction: request.sortDir }],
      },
    });
    expect(api.branchesApi.pageData).toHaveBeenNthCalledWith(2, {
      ...LOCAL_BRANCH_READ,
      startDate: request.startDate,
    });
  });

  it("keeps one IPC read when the current main returns the complete v1 envelope", async () => {
    const currentPageData: BranchesPageData = {
      ...PAGE_DATA,
      list: currentServerList(),
    };
    const pageData = vi.fn(async () => currentPageData);
    const api = fakeDesktopApi({ pageData });
    const source = createLocalBranchesDataSource(api);

    await source.pageData(serverPageRequest());

    expect(pageData).toHaveBeenCalledOnce();
  });

  it("keeps a capability-bearing IPC response whose nested objects carry additive fields (ISS-8884)", async () => {
    const list = currentServerList();
    const facets = list.facets;
    if (!facets) {
      throw new Error("fixture must carry facets");
    }
    // Built loosely on purpose: the point is keys the consumer type does not know.
    const skewedList: Record<string, unknown> = {
      ...list,
      pageInfo: { ...list.pageInfo, generatedBy: "newer-main" },
      facets: {
        ...facets,
        phases: facets.names,
        names: {
          ...facets.names,
          note: "additive",
          options: [{ id: "a", label: "A", count: 1, description: "x" }],
        },
      },
    };
    const current = {
      ...PAGE_DATA,
      list: skewedList as unknown as BranchListResponse,
    };
    const pageData = vi.fn(async () => current);
    const source = createLocalBranchesDataSource(fakeDesktopApi({ pageData }));

    await expect(source.pageData(serverPageRequest())).resolves.toMatchObject({
      list: { items: [], total: 3 },
    });
    expect(pageData).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "null facets", override: { facets: null } },
    {
      name: "partial page info",
      override: {
        pageInfo: { capability: BranchListCapability.ServerPaginationV1 },
      },
    },
    {
      name: "invalid optional map",
      override: { sessionBranchCount: { broken: 0 } },
    },
  ])(
    "rejects a capability-bearing IPC response with $name",
    async ({ override }) => {
      const current = {
        ...PAGE_DATA,
        list: { ...currentServerList(), ...override },
      } as BranchesPageData;
      const pageData = vi.fn(async () => current);
      const source = createLocalBranchesDataSource(
        fakeDesktopApi({ pageData })
      );

      await expect(source.pageData(serverPageRequest())).rejects.toMatchObject({
        status: 500,
        code: SHARED_BRANCHES_SOURCE_ERROR_CODE,
      });
      expect(pageData).toHaveBeenCalledOnce();
    }
  );

  it("forwards forced list refresh requests to the IPC contract", async () => {
    const api = fakeDesktopApi();
    const source = createLocalBranchesDataSource(api);

    await expect(
      source.list({ repo: "x/y", forceRefresh: true })
    ).resolves.toEqual({ ...LIST, readSource: ReadSource.Local });

    expect(api.branchesApi.list).toHaveBeenCalledWith({
      ...LOCAL_BRANCH_READ,
      repo: "x/y",
      forceRefresh: true,
    });
  });

  // FEA-3120: an explicit source the IPC layer already reported wins — the
  // boundary never clobbers it back to `local`.
  it("preserves an explicit readSource from the IPC list payload", async () => {
    const api = fakeDesktopApi({
      list: vi.fn(async () => ({ ...LIST, readSource: ReadSource.Fallback })),
    });
    const source = createLocalBranchesDataSource(api);

    await expect(source.list({})).resolves.toMatchObject({
      readSource: ReadSource.Fallback,
    });
  });

  it("returns a present detail unchanged", async () => {
    const api = fakeDesktopApi();
    const source = createLocalBranchesDataSource(api);
    await expect(source.detail("repo%2Fowner::main")).resolves.toBe(DETAIL);
    expect(api.branchesApi.detail).toHaveBeenCalledWith({
      ...LOCAL_BRANCH_READ,
      id: "repo%2Fowner::main",
    });
  });

  it("forwards forced detail refresh requests to the IPC contract", async () => {
    const api = fakeDesktopApi();
    const source = createLocalBranchesDataSource(api);

    await expect(
      source.detail("repo%2Fowner::main", { forceRefresh: true })
    ).resolves.toBe(DETAIL);

    expect(api.branchesApi.detail).toHaveBeenCalledWith({
      ...LOCAL_BRANCH_READ,
      id: "repo%2Fowner::main",
      forceRefresh: true,
    });
  });

  it("rejects a missing detail as a 404 ApiError instead of resolving null", async () => {
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({ detail: vi.fn(async () => null) })
    );

    const error = await source.detail("missing").catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe(SHARED_BRANCHES_NOT_FOUND_CODE);
  });

  it("maps a source failure to a sanitized 500 ApiError without leaking the raw error", async () => {
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({
        list: vi.fn(() =>
          Promise.reject(new Error("sql error reading /Users/secret/cwd"))
        ),
      })
    );

    const error = await source.list({}).catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.code).toBe(SHARED_BRANCHES_SOURCE_ERROR_CODE);
    expect(error.message).toBe("Branches source failed.");
    expect(error.message).not.toContain("secret");
  });

  it("maps a detail source failure to a 500 (not a 404)", async () => {
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({ detail: vi.fn(() => Promise.reject(new Error("boom"))) })
    );

    const error = await source.detail("x").catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.code).toBe(SHARED_BRANCHES_SOURCE_ERROR_CODE);
  });

  it("wires subscribe to onDbChanged as a broad change (branchId undefined)", () => {
    const unsubscribe = vi.fn();
    const onDbChanged = vi.fn(
      (_cb: (payload: { sessionId?: string }) => void) => unsubscribe
    );
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({}, onDbChanged)
    );

    const onChange = vi.fn();
    const stop = source.subscribe?.(onChange);
    expect(onDbChanged).toHaveBeenCalledTimes(1);

    // Any session DB change maps to a BROAD branch change ({} — no branchId).
    const forward = onDbChanged.mock.calls[0]?.[0];
    forward?.({ sessionId: "session-9" });
    expect(onChange).toHaveBeenCalledWith({});

    stop?.();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("wires subscribe to GitHub resync nudges as scoped branch changes", () => {
    const unsubscribe = vi.fn();
    const onGitHubResyncNudge = vi.fn(
      (_cb: GitHubResyncNudgeCallback) => unsubscribe
    );
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({}, undefined, onGitHubResyncNudge)
    );

    const onChange = vi.fn();
    const stop = source.subscribe?.(onChange);
    expect(onGitHubResyncNudge).toHaveBeenCalledTimes(1);

    const forward = onGitHubResyncNudge.mock.calls[0]?.[0];
    forward?.({
      body: {
        scopes: [
          {
            kind: GitHubDirtyScopeKind.Comment,
            repositoryFullName: "closedloop-ai/closedloop-ai",
            pullRequestNumber: 42,
          },
        ],
      },
      branchIds: ["branch-artifact-42"],
    });
    expect(onChange).toHaveBeenCalledWith({ branchId: "branch-artifact-42" });

    stop?.();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("derives branch ids from nudge branch scopes when main sends no branch id", () => {
    const onGitHubResyncNudge = vi.fn(
      (_cb: GitHubResyncNudgeCallback) => () => undefined
    );
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({}, undefined, onGitHubResyncNudge)
    );

    const onChange = vi.fn();
    source.subscribe?.(onChange);

    const forward = onGitHubResyncNudge.mock.calls[0]?.[0];
    forward?.({
      body: {
        scopes: [
          {
            kind: GitHubDirtyScopeKind.Branch,
            repositoryFullName: "closedloop-ai/closedloop-ai",
            branchName: "feat/nudge",
          },
        ],
      },
    });
    expect(onChange).toHaveBeenCalledWith({
      branchId: "closedloop-ai%2Fclosedloop-ai::feat%2Fnudge",
    });
  });

  it("maps malformed GitHub resync nudge events to broad branch changes", () => {
    const onGitHubResyncNudge = vi.fn(
      (_cb: GitHubResyncNudgeCallback) => () => undefined
    );
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({}, undefined, onGitHubResyncNudge)
    );

    const onChange = vi.fn();
    source.subscribe?.(onChange);

    const forward = onGitHubResyncNudge.mock.calls[0]?.[0];
    forward?.({ body: { scopes: [{ kind: "future" }] } });
    expect(onChange).toHaveBeenCalledWith({});
  });

  it("omits subscribe when the preload exposes no live branch events", () => {
    const source = createLocalBranchesDataSource(fakeDesktopApi());
    expect(source.subscribe).toBeUndefined();
  });
});

function currentServerList(): BranchListResponse {
  const emptyFacet = {
    availability: BranchListFacetAvailability.Complete,
    options: [],
  };
  return {
    ...LIST,
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      requestedOffset: 0,
      now: "2026-08-18T18:00:00.000Z",
    },
    facets: {
      names: emptyFacet,
      owners: emptyFacet,
      collaborators: emptyFacet,
      statuses: emptyFacet,
      pullRequests: emptyFacet,
      lastActiveRanges: emptyFacet,
      repositories: emptyFacet,
      tags: emptyFacet,
    },
  };
}

function serverPageRequest() {
  return {
    pageMode: BranchListPageMode.Server,
    limit: BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: 0,
    sortKey: BranchListSortKey.LastActivity,
    sortDir: BranchListSortDirection.Desc,
  };
}

function cohortAnalyticsResponse(
  branchIds: string[] = ["branch-1"]
): BranchAnalyticsCohortResponse {
  const noData = {
    state: BranchMetricAvailability.NoData,
    value: null,
  } as const;
  const value = { current: noData };
  return {
    matchedBranchIds: branchIds,
    canonicalMetrics: {
      period: BranchMetricPeriod.All,
      label: BranchMetricComparisonLabel.AllTime,
      window: { startAt: null, endAt: "2026-08-05T00:00:00.000Z" },
      cohortSize: branchIds.length,
      lastActiveAt: noData,
      activeBranches: value,
      locPerDollar: value,
      medianPrSize: value,
      aiSpendUsd: value,
      mergeRatePct: value,
    },
  };
}

function makeBranchIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `branch-${index + 1}`);
}

type GitHubResyncNudgeCallback = Parameters<
  NonNullable<DesktopApi["onGitHubResyncNudge"]>
>[0];

// PRD-721 / ISS-9346: the list read sends its filter and sort as the canonical
// `listQuery` expression, which main compiles back to the server-page params.
describe("createLocalBranchesDataSource listQuery", () => {
  it("sends the list read's facets and sort as one expression", async () => {
    const api = fakeDesktopApi();
    const source = createLocalBranchesDataSource(api);
    const page = {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
    };

    await source.list({
      ...page,
      owners: ["alice"],
      sortKey: BranchListSortKey.Owner,
      sortDir: BranchListSortDirection.Asc,
    });

    expect(api.branchesApi.list).toHaveBeenCalledWith({
      ...LOCAL_BRANCH_READ,
      ...page,
      [LIST_QUERY_EXPRESSION_PARAM]: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          {
            field: BranchListField.Owner,
            operator: ListFilterOperator.IsAnyOf,
            values: ["alice"],
          },
        ],
        sorts: [
          {
            field: BranchListSortKey.Owner,
            direction: BranchListSortDirection.Asc,
          },
        ],
      },
    });
  });

  // A legacy single-value spelling has no clause of its own.
  it("keeps the legacy params for a request the expression cannot state", async () => {
    const api = fakeDesktopApi();
    const source = createLocalBranchesDataSource(api);

    await source.list({ repo: "acme/web" });

    expect(api.branchesApi.list).toHaveBeenCalledWith({
      ...LOCAL_BRANCH_READ,
      repo: "acme/web",
    });
  });
});
