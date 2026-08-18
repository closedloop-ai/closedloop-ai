import type {
  BranchAnalytics,
  BranchesPageData,
  BranchListResponse,
  BranchPageDetail,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import type { BranchAnalyticsCohortResponse } from "@repo/api/src/types/branch-analytics-cohort";
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
import { ReadSource } from "@repo/api/src/types/read-source";
import { ApiError } from "@repo/app/shared/api/api-error";
import { describe, expect, it, vi } from "vitest";
import {
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
      repo: "x/y",
      owner: "alice",
    });
    expect(api.branchesApi.usage).toHaveBeenCalledWith({ status: "merged" });
    expect(api.branchesApi.analytics).toHaveBeenCalledWith({});
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
    expect(cohortAnalytics).toHaveBeenCalledWith({ branchIds: ["branch-1"] });

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
    expect(cohortAnalytics).toHaveBeenCalledWith({ branchIds });
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
    expect(api.branchesApi.pageData).toHaveBeenCalledWith({ repo: "x/y" });
  });

  it("forwards forced list refresh requests to the IPC contract", async () => {
    const api = fakeDesktopApi();
    const source = createLocalBranchesDataSource(api);

    await expect(
      source.list({ repo: "x/y", forceRefresh: true })
    ).resolves.toEqual({ ...LIST, readSource: ReadSource.Local });

    expect(api.branchesApi.list).toHaveBeenCalledWith({
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
    const source = createLocalBranchesDataSource(fakeDesktopApi());
    await expect(source.detail("repo%2Fowner::main")).resolves.toBe(DETAIL);
  });

  it("forwards forced detail refresh requests to the IPC contract", async () => {
    const api = fakeDesktopApi();
    const source = createLocalBranchesDataSource(api);

    await expect(
      source.detail("repo%2Fowner::main", { forceRefresh: true })
    ).resolves.toBe(DETAIL);

    expect(api.branchesApi.detail).toHaveBeenCalledWith({
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
            repositoryFullName: "closedloop-ai/symphony-alpha",
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
            repositoryFullName: "closedloop-ai/symphony-alpha",
            branchName: "feat/nudge",
          },
        ],
      },
    });
    expect(onChange).toHaveBeenCalledWith({
      branchId: "closedloop-ai%2Fsymphony-alpha::feat%2Fnudge",
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
