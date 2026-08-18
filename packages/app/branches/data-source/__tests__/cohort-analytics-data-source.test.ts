import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { createHttpBranchesDataSource } from "../branches-data-source";

describe("HTTP Branch cohort analytics", () => {
  it("posts the exact request to the additive route and parses the response", async () => {
    const postCalls: unknown[][] = [];
    const post = <T>(path: string, body?: unknown): Promise<T> => {
      postCalls.push([path, body]);
      return Promise.resolve(cohortResponse() as T);
    };
    const source = createHttpBranchesDataSource({ get: vi.fn(), post });

    await expect(
      source.cohortAnalytics?.({ branchIds: ["branch-1"] })
    ).resolves.toEqual(cohortResponse());
    expect(postCalls).toEqual([
      ["/branches/analytics/cohort", { branchIds: ["branch-1"] }],
    ]);
  });

  it("posts and parses the complete 101-branch cohort without truncation", async () => {
    const branchIds = makeBranchIds(101);
    const response = cohortResponse(branchIds);
    const post = vi.fn().mockResolvedValue(response);
    const source = createHttpBranchesDataSource({ get: vi.fn(), post });

    await expect(source.cohortAnalytics?.({ branchIds })).resolves.toEqual(
      response
    );
    expect(post).toHaveBeenCalledWith("/branches/analytics/cohort", {
      branchIds,
    });
  });

  it("normalizes api-client-revived metric instants to canonical strings", async () => {
    const source = createHttpBranchesDataSource({
      get: vi.fn(),
      post: <T>() => Promise.resolve(revivedCohortResponse() as T),
    });

    await expect(
      source.cohortAnalytics?.({ branchIds: ["branch-1"] })
    ).resolves.toEqual(canonicalDatedCohortResponse());
  });

  it("keeps understood metrics when a newer producer adds an AI-spend availability literal", async () => {
    const response = cohortResponse();
    const source = createHttpBranchesDataSource({
      get: vi.fn(),
      post: <T>() =>
        Promise.resolve({
          ...response,
          canonicalMetrics: {
            ...response.canonicalMetrics,
            aiSpendUsd: {
              current: { state: "future_pending", value: null },
            },
          },
        } as T),
    });

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

  it("degrades a legacy client without the additive method", async () => {
    const legacy = createHttpBranchesDataSource({ get: vi.fn() });
    await expect(
      legacy.cohortAnalytics?.({ branchIds: ["branch-1"] })
    ).resolves.toBeNull();
  });

  it.each([
    404, 410, 501,
  ])("degrades an explicitly unsupported peer returning HTTP %i", async (status) => {
    const missing = createHttpBranchesDataSource({
      get: vi.fn(),
      post: vi.fn(() => Promise.reject(new ApiError("unsupported", status))),
    });
    await expect(
      missing.cohortAnalytics?.({ branchIds: ["branch-1"] })
    ).resolves.toBeNull();
  });

  it("does not hide a current producer failure", async () => {
    const failed = new ApiError("failed", 500);
    const current = createHttpBranchesDataSource({
      get: vi.fn(),
      post: vi.fn(() => Promise.reject(failed)),
    });
    await expect(
      current.cohortAnalytics?.({ branchIds: ["branch-1"] })
    ).rejects.toBe(failed);
  });

  it("rejects a malformed successful response instead of fabricating no data", async () => {
    const source = createHttpBranchesDataSource({
      get: vi.fn(),
      post: <T>() => Promise.resolve({ matchedBranchIds: [] } as T),
    });

    await expect(
      source.cohortAnalytics?.({ branchIds: ["branch-1"] })
    ).rejects.toBeDefined();
  });
});

function cohortResponse(branchIds: string[] = []) {
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

function canonicalDatedCohortResponse() {
  const response = cohortResponse();
  return {
    ...response,
    canonicalMetrics: {
      ...response.canonicalMetrics,
      window: {
        startAt: "2026-07-29T00:00:00.000Z",
        endAt: "2026-08-05T00:00:00.000Z",
      },
      lastActiveAt: {
        state: BranchMetricAvailability.Complete,
        value: "2026-08-04T12:00:00.000Z",
      },
      activeBranches: {
        ...response.canonicalMetrics.activeBranches,
        comparison: {
          label: BranchMetricComparisonLabel.WeekOverWeek,
          priorWindow: {
            startAt: "2026-07-22T00:00:00.000Z",
            endAt: "2026-07-29T00:00:00.000Z",
          },
          deltaPct: {
            state: BranchMetricAvailability.NoData,
            value: null,
          },
        },
      },
    },
  };
}

function revivedCohortResponse() {
  const response = canonicalDatedCohortResponse();
  return {
    ...response,
    canonicalMetrics: {
      ...response.canonicalMetrics,
      window: {
        startAt: new Date(response.canonicalMetrics.window.startAt),
        endAt: new Date(response.canonicalMetrics.window.endAt),
      },
      lastActiveAt: {
        ...response.canonicalMetrics.lastActiveAt,
        value: new Date(response.canonicalMetrics.lastActiveAt.value),
      },
      activeBranches: {
        ...response.canonicalMetrics.activeBranches,
        comparison: {
          ...response.canonicalMetrics.activeBranches.comparison,
          priorWindow: {
            startAt: new Date(
              response.canonicalMetrics.activeBranches.comparison.priorWindow
                .startAt
            ),
            endAt: new Date(
              response.canonicalMetrics.activeBranches.comparison.priorWindow
                .endAt
            ),
          },
        },
      },
    },
  };
}
