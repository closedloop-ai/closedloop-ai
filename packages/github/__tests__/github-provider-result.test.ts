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
  getSinglePullRequest,
  getSinglePullRequestWithProviderResult,
  listPullRequestIssueComments,
  listPullRequestIssueCommentsWithProviderResult,
  listPullRequestReviewComments,
  listPullRequestReviewCommentsWithProviderResult,
  listPullRequestReviews,
  listPullRequestReviewsWithProviderResult,
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
    ).resolves.toMatchObject({ status: GitHubProviderResultStatus.Success });
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
});
