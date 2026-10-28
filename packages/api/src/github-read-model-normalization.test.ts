import { describe, expect, it } from "vitest";
import {
  bundledPullRequestsFoundAllTargets,
  mapBundledPullRequestsResponse,
  mergeBundledPullRequestsResults,
  normalizeBundledPullRequestsPageOptions,
} from "./github-read-model";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubProviderBudgetState,
} from "./types/github-read-model";

describe("mergeBundledPullRequestsResults edge cases", () => {
  it("produces empty page info and an unknown rate limit budget when merging zero pages", () => {
    const result = mergeBundledPullRequestsResults([], {});

    expect(result.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
    expect(result.rateLimit).toEqual({
      cost: null,
      remaining: null,
      resetAt: null,
      state: GitHubProviderBudgetState.Unknown,
    });
    expect(result.fetchedPages).toBe(0);
    expect(result.missingTargetNumbers).toEqual([]);
  });

  it("keeps only the first occurrence of a pull request number repeated across merged pages", () => {
    const first = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-a" },
          nodes: [
            {
              id: "PR_90",
              number: 90,
              url: "https://github.com/acme/repo/pull/90",
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
              id: "PR_90_dup",
              number: 90,
              url: "https://github.com/acme/repo/pull/90",
            },
          ],
        },
      },
    });

    const merged = mergeBundledPullRequestsResults([first, second], {
      maxPages: 2,
    });

    expect(merged.pullRequests).toHaveLength(1);
    expect(merged.pullRequests[0]?.githubId).toBe("PR_90");
  });

  it("marks the merged result untruncated when an explicit TargetFound stop reason is supplied", () => {
    const page = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "PR_100",
              number: 100,
              url: "https://github.com/acme/repo/pull/100",
            },
          ],
        },
      },
    });

    const merged = mergeBundledPullRequestsResults(
      [page],
      {},
      GitHubBundledPullRequestsStopReason.TargetFound
    );

    expect(merged.stopReason).toBe(
      GitHubBundledPullRequestsStopReason.TargetFound
    );
    expect(merged.truncated).toBe(false);
  });

  it("resolves TargetFound when more pages remain but every target number was already found", () => {
    const page = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-b" },
          nodes: [
            {
              id: "PR_110",
              number: 110,
              url: "https://github.com/acme/repo/pull/110",
            },
          ],
        },
      },
    });

    const merged = mergeBundledPullRequestsResults([page], {
      targetNumbers: [110],
    });

    expect(merged.stopReason).toBe(
      GitHubBundledPullRequestsStopReason.TargetFound
    );
    expect(merged.truncated).toBe(true);
  });

  it("resolves PageLimit once more pages remain and the max page ceiling is reached", () => {
    const page = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-c" },
          nodes: [
            {
              id: "PR_120",
              number: 120,
              url: "https://github.com/acme/repo/pull/120",
            },
          ],
        },
      },
    });

    const merged = mergeBundledPullRequestsResults([page], {
      maxPages: 1,
      maxItems: 100,
    });

    expect(merged.stopReason).toBe(
      GitHubBundledPullRequestsStopReason.PageLimit
    );
  });

  it("resolves ItemLimit once the merged pull request count reaches the max item ceiling", () => {
    const page = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-d" },
          nodes: [
            {
              id: "PR_130",
              number: 130,
              url: "https://github.com/acme/repo/pull/130",
            },
          ],
        },
      },
    });

    const merged = mergeBundledPullRequestsResults([page], {
      maxItems: 1,
      maxPages: 5,
    });

    expect(merged.stopReason).toBe(
      GitHubBundledPullRequestsStopReason.ItemLimit
    );
  });
});

describe("bundledPullRequestsFoundAllTargets", () => {
  it("returns true once every target number is present in the pull request list", () => {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_140",
              number: 140,
              url: "https://github.com/acme/repo/pull/140",
            },
            {
              id: "PR_141",
              number: 141,
              url: "https://github.com/acme/repo/pull/141",
            },
          ],
        },
      },
    });

    expect(
      bundledPullRequestsFoundAllTargets(result.pullRequests, [140, 141])
    ).toBe(true);
  });

  it("returns false while a target number is still missing from the pull request list", () => {
    const result = mapBundledPullRequestsResponse({
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_150",
              number: 150,
              url: "https://github.com/acme/repo/pull/150",
            },
          ],
        },
      },
    });

    expect(
      bundledPullRequestsFoundAllTargets(result.pullRequests, [150, 151])
    ).toBe(false);
  });
});

describe("normalizeBundledPullRequestsPageOptions target numbers", () => {
  it("drops duplicate, non-integer, and non-positive target numbers while preserving first-seen order", () => {
    const normalized = normalizeBundledPullRequestsPageOptions({
      targetNumbers: [5, 5, -1, 0, 1.5, 6],
    });

    expect(normalized.targetNumbers).toEqual([5, 6]);
  });
});
