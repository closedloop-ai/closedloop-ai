import { describe, expect, it } from "vitest";
import {
  buildBundledPullRequestsVariables,
  GITHUB_BUNDLED_PULL_REQUESTS_QUERY,
  isPullRequestMerged,
  mapBundledPullRequestsResponse,
  mapRateLimitBudget,
  mergeBundledPullRequestsResults,
  normalizeGitHubFetchCredentialType,
  normalizeGitHubFetchMechanism,
  normalizeGitHubFetchTrigger,
  normalizeGitHubSyncResultReason,
} from "./github-read-model";
import { ChecksStatus, ReviewDecision } from "./types/branch-checks";
import { GitHubPRState } from "./types/github";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubProviderBudgetState,
  GitHubSyncResultReason,
} from "./types/github-read-model";

describe("github read model", () => {
  it("selects rateLimit budget metadata in the bundled query", () => {
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("rateLimit");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("cost");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("remaining");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("resetAt");
  });

  it("selects merged pull requests and REST database IDs in the bundled query", () => {
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain(
      "states: [OPEN, CLOSED, MERGED]"
    );
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("databaseId");
  });

  it("selects cursor pageInfo and builds bounded page variables", () => {
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("$pageSize: Int!");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("after: $after");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("pageInfo");
    expect(GITHUB_BUNDLED_PULL_REQUESTS_QUERY).toContain("hasNextPage");
    expect(buildBundledPullRequestsVariables("acme", "repo", [])).toEqual({
      owner: "acme",
      repo: "repo",
      pageSize: 100,
    });
    expect(
      buildBundledPullRequestsVariables("acme", "repo", [], {
        after: "cursor-1",
        pageSize: 500,
      })
    ).toEqual({
      owner: "acme",
      repo: "repo",
      pageSize: 100,
      after: "cursor-1",
    });
    expect(
      buildBundledPullRequestsVariables("acme", "repo", [], {
        after: null,
      })
    ).not.toHaveProperty("after");
  });

  it("maps PR lifecycle, review, check, LOC, and budget fields", () => {
    const result = mapBundledPullRequestsResponse({
      rateLimit: {
        cost: 3,
        remaining: 249,
        resetAt: "2026-07-03T01:00:00Z",
      },
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          nodes: [
            {
              id: "PR_kwDO1",
              databaseId: 424_242,
              number: 42,
              title: "Ship it",
              url: "https://github.com/acme/repo/pull/42",
              state: GitHubPRState.Closed,
              isDraft: false,
              additions: 10,
              deletions: 4,
              changedFiles: 2,
              reviewDecision: ReviewDecision.Approved,
              createdAt: "2026-07-01T12:00:00Z",
              mergedAt: "2026-07-02T01:00:00Z",
              closedAt: "2026-07-02T01:00:00Z",
              baseRefName: "main",
              headRefName: "feature",
              headRefOid: "abc123",
              mergeCommit: { oid: "merge-sha" },
              author: { login: "octo" },
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: { state: "SUCCESS" },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    });

    expect(result.rateLimit.state).toBe(GitHubProviderBudgetState.Low);
    expect(result).toEqual(
      expect.objectContaining({
        hasMore: true,
        nextCursor: "cursor-1",
        stopReason: GitHubBundledPullRequestsStopReason.PageLimit,
        truncated: true,
      })
    );
    expect(result.pullRequests).toEqual([
      expect.objectContaining({
        number: 42,
        githubId: "424242",
        state: GitHubPRState.Merged,
        checksStatus: ChecksStatus.Passing,
        reviewDecision: ReviewDecision.Approved,
        additions: 10,
        deletions: 4,
        changedFiles: 2,
        openedAt: "2026-07-01T12:00:00Z",
      }),
    ]);
  });

  it("normalizes zero-time PR creation timestamps from provider payloads", () => {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_zero",
              number: 44,
              url: "https://github.com/acme/repo/pull/44",
              createdAt: "0001-01-01T00:00:00Z",
            },
          ],
        },
      },
    });

    expect(result.pullRequests[0]?.openedAt).toBeNull();
  });

  it("falls back to the GraphQL node ID when a REST database ID is absent", () => {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_legacy",
              number: 45,
              url: "https://github.com/acme/repo/pull/45",
            },
          ],
        },
      },
    });

    expect(result.pullRequests[0]?.githubId).toBe("PR_legacy");
  });

  it("uses GitHub state first when connected and local state otherwise", () => {
    expect(
      isPullRequestMerged({
        connected: true,
        githubState: GitHubPRState.Merged,
        localState: GitHubPRState.Open,
      })
    ).toBe(true);
    expect(
      isPullRequestMerged({
        connected: false,
        githubState: GitHubPRState.Open,
        localState: GitHubPRState.Merged,
      })
    ).toBe(true);
  });

  it("falls back safely for unknown PR state, review decision, and check rollup", () => {
    const result = mapBundledPullRequestsResponse({
      rateLimit: null,
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_unknown",
              number: 43,
              url: "https://github.com/acme/repo/pull/43",
              state: "SURPRISE",
              reviewDecision: "CONFUSED",
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: { state: "MYSTERY" },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    });

    expect(result.rateLimit.state).toBe(GitHubProviderBudgetState.Unknown);
    expect(result.pullRequests).toEqual([
      expect.objectContaining({
        checksStatus: null,
        reviewDecision: null,
        state: GitHubPRState.Open,
      }),
    ]);
  });

  it("handles missing repository payloads and non-finite budget values", () => {
    const result = mapBundledPullRequestsResponse({
      rateLimit: { cost: Number.NaN, remaining: Number.POSITIVE_INFINITY },
      repository: null,
    });

    expect(result.pullRequests).toEqual([]);
    expect(result.rateLimit).toEqual({
      cost: null,
      remaining: null,
      resetAt: null,
      state: GitHubProviderBudgetState.Unknown,
    });
    expect(mapRateLimitBudget(null).state).toBe(
      GitHubProviderBudgetState.Unknown
    );
  });

  it("merges paged bundled PR results and reports missing target numbers", () => {
    const first = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          nodes: [
            {
              id: "PR_1",
              number: 1,
              url: "https://github.com/acme/repo/pull/1",
            },
          ],
        },
      },
    });
    const second = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "PR_101",
              number: 101,
              url: "https://github.com/acme/repo/pull/101",
            },
          ],
        },
      },
    });

    expect(
      mergeBundledPullRequestsResults([first, second], {
        maxPages: 2,
        targetNumbers: [101, 202],
      })
    ).toEqual(
      expect.objectContaining({
        fetchedPages: 2,
        hasMore: false,
        missingTargetNumbers: [202],
        stopReason: GitHubBundledPullRequestsStopReason.Complete,
        truncated: false,
      })
    );
  });

  it("throws when a paged bundled PR merge has no explicit or derived stop reason", () => {
    const page = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          nodes: [
            {
              id: "PR_1",
              number: 1,
              url: "https://github.com/acme/repo/pull/1",
            },
          ],
        },
      },
    });

    expect(() =>
      mergeBundledPullRequestsResults([page], {
        maxItems: 100,
        maxPages: 2,
        targetNumbers: [202],
      })
    ).toThrow("Unable to resolve bundled pull requests stop reason");
  });

  it("accepts known GitHub provenance values", () => {
    expect(
      normalizeGitHubFetchCredentialType(GitHubFetchCredentialType.GitHubApp)
    ).toBe(GitHubFetchCredentialType.GitHubApp);
    expect(normalizeGitHubFetchMechanism(GitHubFetchMechanism.Graphql)).toBe(
      GitHubFetchMechanism.Graphql
    );
    expect(normalizeGitHubFetchTrigger(GitHubFetchTrigger.Webhook)).toBe(
      GitHubFetchTrigger.Webhook
    );
    expect(
      normalizeGitHubSyncResultReason(GitHubSyncResultReason.Success)
    ).toBe(GitHubSyncResultReason.Success);
  });

  it("normalizes unknown, null, and absent GitHub provenance values", () => {
    expect(normalizeGitHubFetchCredentialType("future_credential")).toBe(
      GitHubFetchCredentialType.Unknown
    );
    expect(normalizeGitHubFetchMechanism(null)).toBe(
      GitHubFetchMechanism.Unknown
    );
    expect(normalizeGitHubFetchTrigger(undefined)).toBe(
      GitHubFetchTrigger.Unknown
    );
    expect(normalizeGitHubSyncResultReason({ reason: "future" })).toBe(
      GitHubSyncResultReason.Unknown
    );
  });
});
