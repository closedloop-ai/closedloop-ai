import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubProviderBudgetState,
} from "@repo/api/src/types/github-read-model";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFetchReviewThreadMetadataByCommentId,
  mockGetInstallationOctokit,
  mockLogWarn,
} = vi.hoisted(() => ({
  mockFetchReviewThreadMetadataByCommentId: vi.fn(),
  mockGetInstallationOctokit: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock("../installation-auth", () => ({
  getInstallationAccessToken: vi.fn(),
  getInstallationOctokit: mockGetInstallationOctokit,
}));

vi.mock("../review-thread-lookup", () => ({
  MAX_PR_METADATA_PAGES: 10,
  fetchReviewThreadMetadataByCommentId:
    mockFetchReviewThreadMetadataByCommentId,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: mockLogWarn,
  },
}));

import {
  classifyGitHubProviderError,
  compareBranchFileChanges,
  compareBranchFileChangesWithProviderResult,
  GitHubProviderResultStatus,
  getGitHubRetryAfterSeconds,
  getRepositoryPullRequests,
  getRepositoryPullRequestsWithMetadata,
  getSinglePullRequest,
  getSinglePullRequestWithProviderResult,
  listPullRequestIssueComments,
  listPullRequestIssueCommentsWithProviderResult,
  listPullRequestReviewComments,
  listPullRequestReviewCommentsWithProviderResult,
  listPullRequestReviews,
  listPullRequestReviewsWithProviderResult,
  queryBundledPullRequestsWithProviderResult,
  queryStatusCheckRollup,
  queryStatusCheckRollupWithProviderResult,
} from "../index";

const mockOctokit = {
  graphql: vi.fn(),
  issues: {
    listComments: vi.fn(),
  },
  paginate: vi.fn(),
  pulls: {
    listReviewComments: vi.fn(),
    listReviews: vi.fn(),
  },
  rest: {
    pulls: {
      get: vi.fn(),
    },
    repos: {
      compareCommitsWithBasehead: vi.fn(),
    },
  },
};

const INSTALLATION_ID = "12345";
const OWNER = "acme";
const REPO = "repo";
const PULL_NUMBER = 42;
const COMMIT_SHA = "a".repeat(40);

function partialRateLimitedStatusRollupError() {
  return Object.assign(new Error("GraphQL execution failed"), {
    status: 403,
    data: {
      repository: {
        object: {
          __typename: "Commit",
          statusCheckRollup: {
            state: "FAILURE",
            contexts: {
              totalCount: 1,
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  __typename: "CheckRun",
                  id: "node-failing-e2e",
                  name: "e2e",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                  detailsUrl: "https://github.com/acme/repo/actions/runs/1",
                  url: "https://github.com/acme/repo/runs/1",
                },
              ],
            },
          },
        },
      },
    },
    errors: [{ type: "RATE_LIMITED", message: "GraphQL execution failed" }],
  });
}

function buildRepositoryPullRequestNode(number: number) {
  return {
    id: `PR_${number}`,
    databaseId: 42_000 + number,
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/acme/repo/pull/${number}`,
    state: GitHubPRState.Open,
    isDraft: false,
    baseRefName: "main",
    headRefName: `feature/${number}`,
    headRefOid: `head-sha-${number}`,
    closedAt: null,
    mergedAt: null,
    mergeCommit: null,
    updatedAt: "2026-07-06T07:00:00Z",
    author: { login: "octocat" },
    reviewDecision: null,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: null,
          },
        },
      ],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetInstallationOctokit.mockResolvedValue(mockOctokit);
  mockFetchReviewThreadMetadataByCommentId.mockResolvedValue(new Map());
  mockOctokit.graphql.mockReset();
  mockOctokit.issues.listComments.mockReset();
  mockOctokit.paginate.mockReset();
  mockOctokit.pulls.listReviewComments.mockReset();
  mockOctokit.pulls.listReviews.mockReset();
  mockOctokit.rest.pulls.get.mockReset();
});

describe("getRepositoryPullRequests", () => {
  it("preserves bundled check and review summaries on repository PR list rows", async () => {
    mockOctokit.graphql.mockResolvedValue({
      rateLimit: {
        cost: 1,
        remaining: 100,
        resetAt: "2026-07-06T08:00:00Z",
      },
      repository: {
        pullRequests: {
          nodes: [
            {
              id: "PR_kwDO1",
              databaseId: 42_042,
              number: 42,
              title: "Ship cloud PR data",
              url: "https://github.com/acme/repo/pull/42",
              state: GitHubPRState.Open,
              isDraft: false,
              additions: 22,
              deletions: 5,
              changedFiles: 3,
              baseRefName: "main",
              headRefName: "feature/cloud-pr-data",
              headRefOid: "head-sha",
              closedAt: null,
              mergedAt: null,
              mergeCommit: null,
              updatedAt: "2026-07-06T07:00:00Z",
              author: { login: "octocat" },
              reviewDecision: ReviewDecision.Approved,
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

    await expect(
      getRepositoryPullRequests(INSTALLATION_ID, OWNER, REPO, {
        state: "all",
        limit: 100,
      })
    ).resolves.toEqual([
      expect.objectContaining({
        number: 42,
        additions: 22,
        deletions: 5,
        changedFiles: 3,
        checksStatus: ChecksStatus.Passing,
        reviewDecision: ReviewDecision.Approved,
      }),
    ]);
  });

  it("keeps requested target PRs beyond the normal limited window", async () => {
    mockOctokit.graphql.mockResolvedValue({
      rateLimit: {
        cost: 1,
        remaining: 100,
        resetAt: "2026-07-06T08:00:00Z",
      },
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            ...Array.from({ length: 31 }, (_, index) =>
              buildRepositoryPullRequestNode(index + 1)
            ),
            buildRepositoryPullRequestNode(150),
          ],
        },
      },
    });

    const result = await getRepositoryPullRequestsWithMetadata(
      INSTALLATION_ID,
      OWNER,
      REPO,
      {
        state: "all",
        limit: 30,
        targetNumbers: [150],
      }
    );

    expect(result.pullRequests.map((pr) => pr.number)).toEqual([
      ...Array.from({ length: 30 }, (_, index) => index + 1),
      150,
    ]);
  });
});

describe("queryBundledPullRequestsWithProviderResult", () => {
  it("pages until a requested target PR outside the first page is found", async () => {
    mockOctokit.graphql
      .mockResolvedValueOnce({
        rateLimit: {
          cost: 1,
          remaining: 5000,
          resetAt: "2026-07-06T08:00:00Z",
        },
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            nodes: [
              {
                id: "PR_first",
                number: 1,
                title: "First page",
                url: "https://github.com/acme/repo/pull/1",
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        rateLimit: {
          cost: 1,
          remaining: 4999,
          resetAt: "2026-07-06T08:00:00Z",
        },
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PR_target",
                number: 150,
                title: "Target page",
                url: "https://github.com/acme/repo/pull/150",
              },
            ],
          },
        },
      });

    const result = await queryBundledPullRequestsWithProviderResult(
      INSTALLATION_ID,
      OWNER,
      REPO,
      [150],
      { maxItems: 300, maxPages: 3, targetNumbers: [150] }
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.pullRequests.map((pr) => pr.number)).toEqual([
        1, 150,
      ]);
      expect(result.value.stopReason).toBe(
        GitHubBundledPullRequestsStopReason.TargetFound
      );
      expect(result.value.truncated).toBe(false);
    }
    expect(mockOctokit.graphql).toHaveBeenCalledTimes(2);
    expect(mockOctokit.graphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ after: "cursor-1", pageSize: 100 })
    );
  });

  it("stops target paging on low provider budget and marks the result truncated", async () => {
    mockOctokit.graphql.mockResolvedValueOnce({
      rateLimit: {
        cost: 10,
        remaining: 1,
        resetAt: "2026-07-06T08:00:00Z",
      },
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          nodes: [
            {
              id: "PR_first",
              number: 1,
              title: "First page",
              url: "https://github.com/acme/repo/pull/1",
            },
          ],
        },
      },
    });

    const result = await queryBundledPullRequestsWithProviderResult(
      INSTALLATION_ID,
      OWNER,
      REPO,
      [150],
      { maxItems: 300, maxPages: 3, targetNumbers: [150] }
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.rateLimit.state).toBe(GitHubProviderBudgetState.Low);
      expect(result.value.stopReason).toBe(
        GitHubBundledPullRequestsStopReason.BudgetLow
      );
      expect(result.value.missingTargetNumbers).toEqual([150]);
      expect(result.value.truncated).toBe(true);
    }
    expect(mockOctokit.graphql).toHaveBeenCalledTimes(1);
  });
});

describe("getGitHubRetryAfterSeconds", () => {
  const nowMs = Date.parse("2026-06-01T12:00:00Z");

  it("prefers numeric Retry-After over x-ratelimit-reset", () => {
    const error = {
      status: 429,
      response: {
        headers: {
          "retry-after": "37",
          "x-ratelimit-reset": String(Math.floor(nowMs / 1000) + 300),
        },
      },
    };

    expect(getGitHubRetryAfterSeconds(error, nowMs)).toBe(37);
  });

  it("normalizes future HTTP-date Retry-After values", () => {
    const error = {
      status: 429,
      headers: {
        "Retry-After": "Mon, 01 Jun 2026 12:00:42 GMT",
      },
    };

    expect(getGitHubRetryAfterSeconds(error, nowMs)).toBe(42);
  });

  it("uses future x-ratelimit-reset when Retry-After is unavailable", () => {
    const error = {
      status: 403,
      headers: {
        "x-ratelimit-reset": String(Math.floor(nowMs / 1000) + 15),
      },
    };

    expect(getGitHubRetryAfterSeconds(error, nowMs)).toBe(15);
  });

  it("rejects malformed, non-positive, and past retry metadata", () => {
    expect(
      getGitHubRetryAfterSeconds(
        { status: 429, headers: { "retry-after": "0" } },
        nowMs
      )
    ).toBeNull();
    expect(
      getGitHubRetryAfterSeconds(
        { status: 429, headers: { "retry-after": "not-a-date" } },
        nowMs
      )
    ).toBeNull();
    expect(
      getGitHubRetryAfterSeconds(
        {
          status: 429,
          headers: {
            "x-ratelimit-reset": String(Math.floor(nowMs / 1000) - 1),
          },
        },
        nowMs
      )
    ).toBeNull();
  });
});

describe("classifyGitHubProviderError", () => {
  it("classifies 429 and 403 rate-limit evidence as provider rate limits", () => {
    expect(
      classifyGitHubProviderError(
        { status: 429, headers: { "retry-after": "5" } },
        Date.parse("2026-06-01T12:00:00Z")
      )
    ).toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 5,
    });

    expect(
      classifyGitHubProviderError({
        status: 403,
        message: "API rate limit exceeded",
      })
    ).toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: null,
    });
  });

  it("classifies GraphQL rate-limit errors without raw provider data", () => {
    expect(
      classifyGitHubProviderError({
        errors: [{ type: "RATE_LIMITED", message: "GraphQL execution failed" }],
      })
    ).toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: null,
    });

    expect(
      classifyGitHubProviderError({
        errors: [
          { reason: "rate_limited", message: "GraphQL execution failed" },
        ],
      })
    ).toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: null,
    });
  });

  it("classifies unrelated provider failures as unavailable", () => {
    expect(classifyGitHubProviderError({ status: 500 })).toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
  });
});

describe("provider-result wrappers", () => {
  it("returns success discriminants for each wrapped GitHub helper", async () => {
    mockOctokit.rest.pulls.get.mockResolvedValue({
      data: {
        id: 1001,
        number: PULL_NUMBER,
        title: "Feature",
        html_url: "https://github.com/acme/repo/pull/42",
        state: "open",
        merged_at: null,
        closed_at: null,
        draft: false,
        head: { ref: "feature", sha: "head-sha" },
        base: { ref: "main", sha: "base-sha" },
        merge_commit_sha: null,
        user: { login: "octocat" },
        additions: 33,
        deletions: 7,
        changed_files: 4,
      },
    });
    mockOctokit.paginate.mockImplementation((_method, _params, map) => {
      map(
        {
          data: {
            files: [
              {
                filename: "src/app.ts",
                status: "modified",
                additions: 1,
                deletions: 0,
                changes: 1,
              },
            ],
          },
        },
        vi.fn()
      );
    });
    mockOctokit.graphql.mockResolvedValue({
      repository: {
        object: {
          __typename: "Commit",
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: {
              totalCount: 0,
              pageInfo: { hasNextPage: false },
              nodes: [],
            },
          },
        },
      },
    });
    mockOctokit.pulls.listReviewComments.mockResolvedValue({ data: [] });
    mockOctokit.issues.listComments.mockResolvedValue({ data: [] });
    mockOctokit.pulls.listReviews.mockResolvedValue({ data: [] });

    await expect(
      getSinglePullRequestWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        PULL_NUMBER
      )
    ).resolves.toMatchObject({
      status: GitHubProviderResultStatus.Success,
      value: {
        additions: 33,
        deletions: 7,
        changedFiles: 4,
      },
    });
    await expect(
      compareBranchFileChangesWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        "main",
        "feature"
      )
    ).resolves.toMatchObject({
      status: GitHubProviderResultStatus.Success,
      value: [expect.objectContaining({ filename: "src/app.ts" })],
    });
    await expect(
      queryStatusCheckRollupWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        COMMIT_SHA
      )
    ).resolves.toMatchObject({ status: GitHubProviderResultStatus.Success });
    await expect(
      listPullRequestReviewCommentsWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        PULL_NUMBER
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.Success,
      value: [],
    });
    await expect(
      listPullRequestIssueCommentsWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        PULL_NUMBER
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.Success,
      value: [],
    });
    await expect(
      listPullRequestReviewsWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        PULL_NUMBER
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.Success,
      value: [],
    });
  });

  it("preserves status-check retry metadata while legacy rollup remains compatible", async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 120;
    const error = Object.assign(new Error("rate limit"), {
      status: 403,
      headers: { "x-ratelimit-reset": String(resetEpoch) },
    });
    mockOctokit.graphql.mockRejectedValue(error);

    await expect(
      queryStatusCheckRollupWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        COMMIT_SHA
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: expect.any(Number),
    });
    await expect(
      queryStatusCheckRollup(INSTALLATION_ID, OWNER, REPO, COMMIT_SHA)
    ).resolves.toMatchObject({
      ok: false,
      reason: "rate_limited",
    });
  });

  it("keeps status-check provider rate limits authoritative over partial GraphQL data", async () => {
    mockOctokit.graphql.mockRejectedValueOnce(
      partialRateLimitedStatusRollupError()
    );

    await expect(
      queryStatusCheckRollupWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        COMMIT_SHA
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: null,
    });

    mockOctokit.graphql.mockRejectedValueOnce(
      partialRateLimitedStatusRollupError()
    );
    await expect(
      queryStatusCheckRollup(INSTALLATION_ID, OWNER, REPO, COMMIT_SHA)
    ).resolves.toMatchObject({
      ok: true,
      state: "FAILURE",
      totalCount: 1,
    });
  });

  it("returns provider rate limits from wrapper and nested review-thread metadata failures", async () => {
    const rateLimitError = Object.assign(new Error("rate limit"), {
      status: 429,
      headers: { "retry-after": "33" },
    });
    mockOctokit.rest.pulls.get.mockRejectedValueOnce(rateLimitError);

    await expect(
      getSinglePullRequestWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        PULL_NUMBER
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 33,
    });

    mockOctokit.paginate.mockRejectedValueOnce(rateLimitError);
    await expect(
      compareBranchFileChangesWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        "main",
        "feature"
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 33,
    });

    mockOctokit.pulls.listReviewComments.mockResolvedValueOnce({ data: [] });
    mockFetchReviewThreadMetadataByCommentId.mockRejectedValueOnce(
      rateLimitError
    );
    await expect(
      listPullRequestReviewCommentsWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        PULL_NUMBER
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 33,
    });

    mockOctokit.issues.listComments.mockRejectedValueOnce(rateLimitError);
    await expect(
      listPullRequestIssueCommentsWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        PULL_NUMBER
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 33,
    });

    mockOctokit.pulls.listReviews.mockRejectedValueOnce(rateLimitError);
    await expect(
      listPullRequestReviewsWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        PULL_NUMBER
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 33,
    });
  });

  it("returns provider_unavailable discriminants and preserves legacy null shapes without raw logs", async () => {
    const providerError = Object.assign(new Error("token ghp_secret leaked"), {
      status: 500,
    });
    mockOctokit.rest.pulls.get.mockRejectedValue(providerError);
    mockOctokit.paginate.mockRejectedValue(providerError);
    mockOctokit.pulls.listReviewComments.mockRejectedValue(providerError);
    mockOctokit.issues.listComments.mockRejectedValue(providerError);
    mockOctokit.pulls.listReviews.mockRejectedValue(providerError);

    await expect(
      getSinglePullRequestWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        PULL_NUMBER
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
    await expect(
      compareBranchFileChangesWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        "main",
        "feature"
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
    await expect(
      listPullRequestIssueCommentsWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        PULL_NUMBER
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
    await expect(
      listPullRequestReviewsWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        PULL_NUMBER
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    await expect(
      getSinglePullRequest(INSTALLATION_ID, OWNER, REPO, PULL_NUMBER)
    ).resolves.toBeNull();
    await expect(
      compareBranchFileChanges(INSTALLATION_ID, OWNER, REPO, "main", "feature")
    ).resolves.toBeNull();
    await expect(
      listPullRequestReviewComments(INSTALLATION_ID, OWNER, REPO, PULL_NUMBER)
    ).resolves.toBeNull();
    await expect(
      listPullRequestIssueComments(INSTALLATION_ID, OWNER, REPO, PULL_NUMBER)
    ).resolves.toBeNull();
    await expect(
      listPullRequestReviews(INSTALLATION_ID, OWNER, REPO, PULL_NUMBER)
    ).resolves.toBeNull();
    expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain("ghp_secret");
  });

  it("bounds review-comment provider page sizes by the remaining limit", async () => {
    mockOctokit.pulls.listReviewComments.mockImplementation(
      ({ per_page: perPage }: { per_page: number }) =>
        Promise.resolve({
          data: makeReviewComments(perPage),
        })
    );

    await expect(
      listPullRequestReviewCommentsWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        PULL_NUMBER,
        { limit: 101, pageSize: 50, includeReviewThreadMetadata: false }
      )
    ).resolves.toMatchObject({
      status: GitHubProviderResultStatus.Success,
      value: expect.arrayContaining([expect.objectContaining({ id: 1 })]),
    });

    expect(
      mockOctokit.pulls.listReviewComments.mock.calls.map(
        ([params]) => params.per_page
      )
    ).toEqual([50, 50, 1]);
    expect(mockFetchReviewThreadMetadataByCommentId).not.toHaveBeenCalled();
  });

  it("bounds issue-comment provider page sizes by the remaining limit", async () => {
    mockOctokit.issues.listComments.mockImplementation(
      ({ per_page: perPage }: { per_page: number }) =>
        Promise.resolve({
          data: makeIssueComments(perPage),
        })
    );

    await expect(
      listPullRequestIssueCommentsWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        PULL_NUMBER,
        { limit: 101, pageSize: 50 }
      )
    ).resolves.toMatchObject({
      status: GitHubProviderResultStatus.Success,
      value: expect.arrayContaining([expect.objectContaining({ id: 1 })]),
    });

    expect(
      mockOctokit.issues.listComments.mock.calls.map(
        ([params]) => params.per_page
      )
    ).toEqual([50, 50, 1]);
  });

  it("bounds review-body provider page sizes by the remaining limit", async () => {
    mockOctokit.pulls.listReviews.mockImplementation(
      ({ per_page: perPage }: { per_page: number }) =>
        Promise.resolve({
          data: makeReviews(perPage),
        })
    );

    await expect(
      listPullRequestReviewsWithProviderResult(
        INSTALLATION_ID,
        OWNER,
        REPO,
        PULL_NUMBER,
        { limit: 101, pageSize: 50 }
      )
    ).resolves.toMatchObject({
      status: GitHubProviderResultStatus.Success,
      value: expect.arrayContaining([expect.objectContaining({ id: 1 })]),
    });

    expect(
      mockOctokit.pulls.listReviews.mock.calls.map(
        ([params]) => params.per_page
      )
    ).toEqual([50, 50, 1]);
  });
});

function makeIssueComments(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    node_id: `IC_${index + 1}`,
    user: null,
    body: "issue body",
    author_association: "CONTRIBUTOR",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/acme/repo/pull/42#issuecomment-${index + 1}`,
  }));
}

function makeReviewComments(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    node_id: `PRRC_${index + 1}`,
    path: "src/index.ts",
    line: 20,
    side: "RIGHT",
    start_line: null,
    start_side: null,
    original_line: 20,
    original_start_line: null,
    body: "review body",
    user: null,
    author_association: "MEMBER",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/acme/repo/pull/42#discussion_r${index + 1}`,
    commit_id: "abc123",
    pull_request_review_id: 456,
    in_reply_to_id: null,
  }));
}

function makeReviews(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    user: null,
    state: "COMMENTED",
    body: "review body",
    submitted_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/acme/repo/pull/42#pullrequestreview-${index + 1}`,
  }));
}
