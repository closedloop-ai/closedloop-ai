import type {
  BranchAnalytics,
  BranchListResponse,
  BranchPageDetail,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import { BranchViewerScope } from "@repo/api/src/types/branch";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { BranchVisibleLifecyclePhase } from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../types/desktop-api";
import { createLocalBranchesDataSource } from "../local-branches-data-source";

const BRANCH_ID = "repo%2Fowner::main";

describe("local Branch selected-PR version skew", () => {
  it("forwards selection and suppresses an older main's default PR evidence", async () => {
    const legacyDefault = legacyDefaultDetail();
    const api = fakeDesktopApi(legacyDefault);
    const source = createLocalBranchesDataSource(api);

    const result = await source.detail(BRANCH_ID, {
      repositoryFullName: "owner/repo",
      pullRequestNumber: 2,
    });

    expect(api.branchesApi.detail).toHaveBeenCalledWith({
      id: BRANCH_ID,
      repositoryFullName: "owner/repo",
      pullRequestNumber: 2,
    });
    expect(result).toMatchObject({
      id: BRANCH_ID,
      selectedPullRequest: null,
      prNumber: null,
      prTitle: null,
      additions: null,
      deletions: null,
      filesChanged: null,
      sessions: legacyDefault.sessions,
      estimatedCostUsd: legacyDefault.estimatedCostUsd,
      selectedPullRequestChecks: {
        status: "unavailable",
        source: "evidence",
        reason: "malformed_response",
      },
      canonicalMetrics: {
        locPerDollar: { state: "unavailable", value: null },
        phaseCostUsd: legacyDefault.canonicalMetrics?.phaseCostUsd,
        totalCostUsd: legacyDefault.canonicalMetrics?.totalCostUsd,
        leadTimeMs: { state: "unavailable", value: null },
        abandonmentTimeMs: { state: "unavailable", value: null },
        idleTimeMs: { state: "unavailable", value: null },
      },
    });
  });

  it("preserves a new main response whose selected identity matches", async () => {
    const selected = {
      ...legacyDefaultDetail(),
      selectedPullRequest: {
        repositoryFullName: "owner/repo",
        number: 2,
      },
    } as unknown as BranchPageDetail;
    const source = createLocalBranchesDataSource(fakeDesktopApi(selected));

    await expect(
      source.detail(BRANCH_ID, {
        repositoryFullName: "owner/repo",
        pullRequestNumber: 2,
      })
    ).resolves.toBe(selected);
  });

  it("does not invent canonical metric authority for an older response without metrics", async () => {
    const legacyWithoutMetrics = {
      ...legacyDefaultDetail(),
      canonicalMetrics: undefined,
    } as unknown as BranchPageDetail;
    const source = createLocalBranchesDataSource(
      fakeDesktopApi(legacyWithoutMetrics)
    );

    const result = await source.detail(BRANCH_ID, {
      repositoryFullName: "owner/repo",
      pullRequestNumber: 2,
    });

    expect(result.canonicalMetrics).toBeUndefined();
    expect(result.prNumber).toBeNull();
    expect(result.selectedPullRequest).toBeNull();
  });
});

function legacyDefaultDetail(): BranchPageDetail {
  return {
    id: BRANCH_ID,
    prNumber: 1,
    prTitle: "Default PR",
    prUrl: "https://github.com/owner/repo/pull/1",
    additions: 10,
    deletions: 2,
    filesChanged: 3,
    sessions: [{ sessionId: "session-1" }],
    estimatedCostUsd: 4,
    canonicalMetrics: {
      locPerDollar: { state: BranchMetricAvailability.Complete, value: 3 },
      phaseCostUsd: {
        [BranchVisibleLifecyclePhase.Build]: {
          state: BranchMetricAvailability.Complete,
          value: 2,
        },
        [BranchVisibleLifecyclePhase.Review]: {
          state: BranchMetricAvailability.Complete,
          value: 1,
        },
        [BranchVisibleLifecyclePhase.Rework]: {
          state: BranchMetricAvailability.Complete,
          value: 1,
        },
      },
      totalCostUsd: { state: BranchMetricAvailability.Complete, value: 4 },
      leadTimeMs: { state: BranchMetricAvailability.Complete, value: 100 },
      abandonmentTimeMs: {
        state: BranchMetricAvailability.NotApplicable,
        value: null,
      },
      idleTimeMs: { state: BranchMetricAvailability.Complete, value: 20 },
    },
  } as unknown as BranchPageDetail;
}

function fakeDesktopApi(detail: BranchPageDetail) {
  return {
    branchesApi: {
      list: vi.fn(
        async () =>
          ({
            items: [],
            total: 0,
            viewerScope: BranchViewerScope.Self,
          }) as BranchListResponse
      ),
      detail: vi.fn(async () => detail),
      trace: vi.fn(async () => []),
      usage: vi.fn(async () => ({}) as BranchUsageSummary),
      analytics: vi.fn(async () => ({}) as BranchAnalytics),
      pageData: vi.fn(async () => ({
        list: {
          items: [],
          total: 0,
          viewerScope: BranchViewerScope.Self,
        },
        analytics: {},
      })),
    },
  } as unknown as Pick<DesktopApi, "branchesApi">;
}
