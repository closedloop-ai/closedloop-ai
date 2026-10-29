import type { Octokit } from "@octokit/rest";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubProviderBudgetState,
} from "@repo/api/src/types/github-read-model";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubProviderResultStatus } from "../provider-result";
import {
  GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE,
  getRepositoryPullRequestsByNumber,
  getRepositoryPullRequestsByNumberWithProviderResult,
} from "../pull-request-point-read";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const OWNER = "acme";
const REPO = "widgets";

const mockOctokit = {
  graphql: vi.fn(),
};
const octokit = mockOctokit as unknown as Octokit;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getRepositoryPullRequestsByNumberWithProviderResult", () => {
  it("fetches only the requested PR numbers through repository point reads", async () => {
    mockOctokit.graphql.mockResolvedValue({
      rateLimit: {
        cost: 1,
        remaining: 100,
        resetAt: "2026-07-06T08:00:00Z",
      },
      repository: {
        pr0: buildRepositoryPullRequestNode(7),
        pr1: null,
      },
    });

    const result = await getRepositoryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 8, 7, 0]
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.pullRequests.map((pr) => pr.number)).toEqual([7]);
      expect(result.value.attemptedNumbers).toEqual([7, 8]);
      expect(result.value.missingNumbers).toEqual([8]);
      expect(result.value.missingTargetNumbers).toEqual([8]);
    }
    const [query, variables] = mockOctokit.graphql.mock.calls[0];
    expect(query).toContain("pr0: pullRequest(number: $pr0)");
    expect(query).toContain("pr1: pullRequest(number: $pr1)");
    expect(query).not.toContain("pullRequests(first:");
    expect(variables).toMatchObject({
      owner: OWNER,
      repo: REPO,
      pr0: 7,
      pr1: 8,
    });
  });

  it("batches point reads and stops before unattempted targets when budget goes low", async () => {
    mockOctokit.graphql.mockResolvedValueOnce({
      rateLimit: {
        cost: 10,
        remaining: 1,
        resetAt: "2026-07-06T08:00:00Z",
      },
      repository: Object.fromEntries(
        Array.from(
          { length: GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE },
          (_, index) => [
            `pr${index}`,
            buildRepositoryPullRequestNode(index + 1),
          ]
        )
      ),
    });

    const result = await getRepositoryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      Array.from(
        { length: GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE + 1 },
        (_, index) => index + 1
      )
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.rateLimit.state).toBe(GitHubProviderBudgetState.Low);
      expect(result.value.stopReason).toBe(
        GitHubBundledPullRequestsStopReason.BudgetLow
      );
      expect(result.value.truncated).toBe(true);
      expect(result.value.unattemptedNumbers).toEqual([
        GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE + 1,
      ]);
      expect(result.value.missingNumbers).toEqual([]);
    }
    expect(mockOctokit.graphql).toHaveBeenCalledTimes(1);
  });

  // ISS-8287 (raised by davetho on #6073, adjudicated against `main`): one
  // deleted PR in the batch made GitHub throw with every OTHER alias already
  // populated in `error.data`, and the catch discarded the whole response. The
  // targeted reconciler batches up to 25 session-linked numbers through this
  // function, so a single gone PR blocked 24 healthy reads on every tick and
  // never recorded the gone one as missing.
  it("salvages the aliases GitHub did resolve when one PR is gone", async () => {
    mockOctokit.graphql.mockRejectedValueOnce({
      data: {
        rateLimit: {
          cost: 1,
          remaining: 100,
          resetAt: "2026-07-06T08:00:00Z",
        },
        repository: {
          pr0: buildRepositoryPullRequestNode(7),
          pr1: null,
          pr2: buildRepositoryPullRequestNode(9),
        },
      },
      errors: [
        {
          type: "NOT_FOUND",
          path: ["repository", "pr1"],
          message: "Could not resolve to a PullRequest with the number of 8.",
        },
      ],
    });

    const result = await getRepositoryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 8, 9]
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      // The co-batched healthy numbers are refreshed...
      expect(result.value.pullRequests.map((pr) => pr.number)).toEqual([7, 9]);
      // ...and the gone one is recorded as missing rather than left unattempted,
      // which is what lets the caller stop asking for it.
      expect(result.value.missingNumbers).toEqual([8]);
      expect(result.value.attemptedNumbers).toEqual([7, 8, 9]);
      expect(result.value.unattemptedNumbers).toEqual([]);
    }
  });

  // Review finding (MEDIUM): `INTERNAL`, `SERVICE_UNAVAILABLE` and a per-node
  // `FORBIDDEN` produce the SAME 200 + populated-`data` + `errors[]` shape as a
  // deleted PR, and the alias is null in `data` either way. Calling one of those
  // "missing" makes `stampMissingTargetAttempts` write `lastRefreshAttemptAt` on
  // a PR nothing was read for, debouncing its next refresh.
  it("does not call a transiently failed alias missing", async () => {
    mockOctokit.graphql.mockRejectedValueOnce({
      data: {
        rateLimit: {
          cost: 1,
          remaining: 100,
          resetAt: "2026-07-06T08:00:00Z",
        },
        repository: {
          pr0: buildRepositoryPullRequestNode(7),
          pr1: null,
          pr2: buildRepositoryPullRequestNode(9),
        },
      },
      errors: [
        {
          type: "INTERNAL",
          path: ["repository", "pr1"],
          message: "Something went wrong while executing your query.",
        },
      ],
    });

    const result = await getRepositoryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 8, 9]
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.pullRequests.map((pr) => pr.number)).toEqual([7, 9]);
      // 8 was NOT proven absent — it was never read.
      expect(result.value.missingNumbers).toEqual([]);
      expect(result.value.attemptedNumbers).toEqual([7, 9]);
      // So it stays retryable rather than being stamped and debounced.
      expect(result.value.unattemptedNumbers).toEqual([8]);
      expect(result.value.truncated).toBe(true);
    }
  });

  // whitlockk on #8018: GraphQL error paths are optional, so a path-less entry
  // attributed to no alias and the null alias was reported missing — and
  // debounced — although GitHub never read it.
  it("keeps every null alias unattempted when an error names no alias", async () => {
    mockOctokit.graphql.mockRejectedValueOnce({
      data: {
        repository: {
          pr0: buildRepositoryPullRequestNode(7),
          pr1: null,
          pr2: buildRepositoryPullRequestNode(9),
        },
      },
      errors: [
        {
          type: "INTERNAL",
          message: "Something went wrong while executing your query.",
        },
      ],
    });

    const result = await getRepositoryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 8, 9]
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.pullRequests.map((pr) => pr.number)).toEqual([7, 9]);
      expect(result.value.missingNumbers).toEqual([]);
      expect(result.value.attemptedNumbers).toEqual([7, 9]);
      expect(result.value.unattemptedNumbers).toEqual([8]);
    }
  });

  // ISS-10489: a nested `response.data.data` payload keeps its errors at
  // `response.data.errors`, not `error.errors`. Reading the latter found none,
  // so the INTERNAL alias was reported missing and debounced unread.
  it("classifies a nested envelope's aliases by that envelope's errors", async () => {
    mockOctokit.graphql.mockRejectedValueOnce(
      Object.assign(
        new Error("Request failed due to following response errors"),
        {
          response: {
            data: {
              data: {
                repository: {
                  pr0: buildRepositoryPullRequestNode(7),
                  pr1: null,
                  pr2: null,
                },
              },
              errors: [
                { type: "INTERNAL", path: ["repository", "pr1"] },
                { type: "NOT_FOUND", path: ["repository", "pr2"] },
              ],
            },
          },
        }
      )
    );

    const result = await getRepositoryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 8, 9]
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.pullRequests.map((pr) => pr.number)).toEqual([7]);
      expect(result.value.unattemptedNumbers).toEqual([8]);
      expect(result.value.missingNumbers).toEqual([9]);
      expect(result.value.attemptedNumbers).toEqual([7, 9]);
    }
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("recovered from partial data"),
      expect.objectContaining({ graphqlErrorCount: 2 })
    );
  });

  // ISS-10489 review: a page-shaped wrapper whose errors live on a DIFFERENT
  // wrapper would classify with none, reporting the INTERNAL alias missing.
  it("does not salvage a payload whose own wrapper carries no errors", async () => {
    mockOctokit.graphql.mockRejectedValueOnce({
      errors: [{ type: "INTERNAL", path: ["repository", "pr1"] }],
      response: {
        data: {
          repository: { pr0: buildRepositoryPullRequestNode(7), pr1: null },
        },
      },
    });

    const result = await getRepositoryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 8]
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
  });

  // Review finding (LOW): a recovered partial can carry the aliases without the
  // `rateLimit` root; overwriting a real measurement with `Unknown` loses the
  // budget this call observed and stops the BudgetLow break firing.
  it("keeps the budget it observed when a recovered payload carries none", async () => {
    const firstBatch = Array.from(
      { length: GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE },
      (_, index) => index + 1
    );
    mockOctokit.graphql.mockResolvedValueOnce({
      rateLimit: { cost: 1, remaining: 300, resetAt: "2026-07-06T08:00:00Z" },
      repository: Object.fromEntries(
        firstBatch.map((number, index) => [
          `pr${index}`,
          buildRepositoryPullRequestNode(number),
        ])
      ),
    });
    mockOctokit.graphql.mockRejectedValueOnce({
      data: { repository: { pr0: null } },
      errors: [{ type: "NOT_FOUND", path: ["repository", "pr0"] }],
    });

    const result = await getRepositoryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [...firstBatch, GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE + 1]
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.rateLimit.remaining).toBe(300);
      // The second batch's gone PR is still reported as genuinely missing.
      expect(result.value.missingNumbers).toEqual([
        GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE + 1,
      ]);
    }
  });

  it("still fails the batch when the error carries no partial data", async () => {
    mockOctokit.graphql.mockRejectedValueOnce(new Error("socket hang up"));

    const result = await getRepositoryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 8]
    );

    // A transport failure resolved nothing, so reporting a Success with two
    // missing numbers would be a measurement nobody made.
    expect(result.status).not.toBe(GitHubProviderResultStatus.Success);
  });

  it("reports a rate limit rather than recovering its partial payload", async () => {
    mockOctokit.graphql.mockRejectedValueOnce({
      data: {
        repository: {
          pr0: buildRepositoryPullRequestNode(7),
          pr1: null,
        },
      },
      errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
    });

    const result = await getRepositoryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 8]
    );

    // Recovering this as a plain Success would stamp 8 as attempted-and-missing
    // when the limit is what stopped it resolving, so the caller would debounce
    // a number it never actually read.
    expect(result.status).toBe(GitHubProviderResultStatus.ProviderRateLimit);
  });

  it("returns an empty success without calling GitHub when no valid number is requested", async () => {
    const result = await getRepositoryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [0, -3]
    );

    expect(mockOctokit.graphql).not.toHaveBeenCalled();
    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.pullRequests).toEqual([]);
      expect(result.value.attemptedNumbers).toEqual([]);
      expect(result.value.fetchedPages).toBe(0);
      expect(result.value.truncated).toBe(false);
      expect(result.value.stopReason).toBe(
        GitHubBundledPullRequestsStopReason.Complete
      );
    }
  });

  it("treats an error entry with a non-string type as transient, not as a missing PR", async () => {
    mockOctokit.graphql.mockRejectedValueOnce({
      data: {
        repository: {
          pr0: buildRepositoryPullRequestNode(7),
          pr1: null,
        },
      },
      errors: [{ type: 404, path: ["repository", "pr1"] }],
    });

    const result = await getRepositoryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 8]
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.missingNumbers).toEqual([]);
      expect(result.value.unattemptedNumbers).toEqual([8]);
    }
  });

  it("attributes an error to its alias when the path also holds non-string segments", async () => {
    mockOctokit.graphql.mockRejectedValueOnce({
      data: {
        repository: {
          pr0: buildRepositoryPullRequestNode(7),
          pr1: null,
          pr2: null,
        },
      },
      errors: [{ type: "INTERNAL", path: ["repository", "pr1", 0] }],
    });

    const result = await getRepositoryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 8, 9]
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      // Only 8 is blamed; 9's null alias is not swept in as unattempted.
      expect(result.value.unattemptedNumbers).toEqual([8]);
      expect(result.value.missingNumbers).toEqual([9]);
    }
  });

  it("falls back to every null alias when the error path names an alias index beyond the safe-integer range", async () => {
    mockOctokit.graphql.mockRejectedValueOnce({
      data: {
        repository: {
          pr0: buildRepositoryPullRequestNode(7),
          pr1: null,
          pr2: null,
        },
      },
      errors: [
        { type: "INTERNAL", path: ["repository", "pr99999999999999999999"] },
      ],
    });

    const result = await getRepositoryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 8, 9]
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.unattemptedNumbers).toEqual([8, 9]);
      expect(result.value.missingNumbers).toEqual([]);
    }
  });

  it("preserves repo-level GraphQL denial statuses", async () => {
    mockOctokit.graphql.mockRejectedValueOnce({
      data: { repository: null },
      errors: [{ type: "NOT_FOUND", path: ["repository"] }],
    });

    await expect(
      getRepositoryPullRequestsByNumberWithProviderResult(
        octokit,
        OWNER,
        REPO,
        [7]
      )
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderRepoNotFound,
    });
  });
});

describe("getRepositoryPullRequestsByNumber", () => {
  it("unwraps a successful read into its value", async () => {
    mockOctokit.graphql.mockResolvedValue({
      repository: { pr0: buildRepositoryPullRequestNode(7) },
    });

    const result = await getRepositoryPullRequestsByNumber(
      octokit,
      OWNER,
      REPO,
      [7]
    );

    expect(result?.pullRequests.map((pr) => pr.number)).toEqual([7]);
  });

  it("returns null when the provider read fails", async () => {
    mockOctokit.graphql.mockRejectedValueOnce(new Error("socket hang up"));

    const result = await getRepositoryPullRequestsByNumber(
      octokit,
      OWNER,
      REPO,
      [7]
    );

    expect(result).toBeNull();
  });
});

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
