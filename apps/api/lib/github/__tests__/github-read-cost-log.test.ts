import { GitHubProviderBudgetState } from "@repo/api/src/types/github-read-model";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubReadCostObserver,
  GITHUB_READ_COST_EVENT,
  GitHubReadCostRoute,
} from "@/lib/github/github-read-cost-log";

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const logInfo = vi.mocked(log.info);

beforeEach(() => {
  logInfo.mockReset();
});

describe("createGitHubReadCostObserver (PLN-1535 M0)", () => {
  const context = {
    route: GitHubReadCostRoute.RepositoryPullRequests,
    organizationId: "org-1",
    repositoryId: "repo-1",
    repositoryFullName: "acme/repo",
  };

  it("logs one structured line per page carrying the discarded cost + route facet", () => {
    const observer = createGitHubReadCostObserver(context);

    observer({
      page: 0,
      itemCount: 30,
      rateLimit: {
        cost: 7,
        remaining: 4993,
        resetAt: "2026-08-03T12:00:00Z",
        state: GitHubProviderBudgetState.Available,
      },
    });

    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(GITHUB_READ_COST_EVENT, {
      route: GitHubReadCostRoute.RepositoryPullRequests,
      organizationId: "org-1",
      repositoryId: "repo-1",
      repositoryFullName: "acme/repo",
      page: 0,
      itemCount: 30,
      cost: 7,
      remaining: 4993,
      resetAt: "2026-08-03T12:00:00Z",
      budgetState: GitHubProviderBudgetState.Available,
    });
  });

  it("preserves a null cost as null (unobserved), never coerced to zero", () => {
    const observer = createGitHubReadCostObserver(context);

    observer({
      page: 0,
      itemCount: 0,
      rateLimit: {
        cost: null,
        remaining: null,
        resetAt: null,
        state: GitHubProviderBudgetState.Unknown,
      },
    });

    expect(logInfo).toHaveBeenCalledWith(
      GITHUB_READ_COST_EVENT,
      expect.objectContaining({ cost: null, remaining: null, resetAt: null })
    );
  });

  it("defaults a missing repositoryId to null rather than dropping the field", () => {
    const observer = createGitHubReadCostObserver({
      route: GitHubReadCostRoute.Backfill,
      organizationId: "org-2",
      repositoryFullName: "acme/other",
    });

    observer({
      page: 2,
      itemCount: 5,
      rateLimit: {
        cost: 1,
        remaining: 10,
        resetAt: null,
        state: GitHubProviderBudgetState.Available,
      },
    });

    expect(logInfo).toHaveBeenCalledWith(
      GITHUB_READ_COST_EVENT,
      expect.objectContaining({
        route: GitHubReadCostRoute.Backfill,
        repositoryId: null,
        page: 2,
      })
    );
  });
});
