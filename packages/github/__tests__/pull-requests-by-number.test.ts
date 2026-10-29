import type { Octokit } from "@octokit/rest";
import { log } from "@repo/observability/log";
import { describe, expect, it, vi } from "vitest";
import { GitHubProviderResultStatus } from "../provider-result";
import { queryPullRequestsByNumberWithProviderResult } from "../pull-requests-by-number";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * ISS-7892. The self-heal batch is read by number now, so its failure modes are
 * the ones that decide whether a target can ever be filled.
 */

const OWNER = "acme";
const REPO = "widgets";

/**
 * The shape GitHub actually returns for an alias it cannot resolve, written out
 * by hand from a live probe against `closedloop-ai/closedloop-ai` rather than
 * derived from the code under test: HTTP 200, every other alias populated, plus
 * an `errors[]` entry — which octokit raises as a throw.
 */
/**
 * The same partial shape, but the unresolved alias failed because the query hit
 * the rate limit rather than because the PR is gone. GitHub still answers 200
 * with the resolved aliases populated, so this is indistinguishable from the
 * case above by data shape alone — only `errors[].type` separates them.
 */
function rateLimitedPartialResponseError() {
  const error = partialResponseError();
  error.errors = [
    {
      type: "RATE_LIMITED",
      path: ["repository", "pr_999999"],
      message: "API rate limit exceeded",
    },
  ];
  return error;
}

function partialResponseError() {
  return Object.assign(new Error("Could not resolve to a PullRequest"), {
    errors: [
      {
        type: "NOT_FOUND",
        path: ["repository", "pr_999999"],
        message:
          "Could not resolve to a PullRequest with the number of 999999.",
      },
    ],
    data: {
      rateLimit: { cost: 1, remaining: 4677, resetAt: "2026-08-26T17:34:40Z" },
      repository: {
        pr_7: {
          id: "PR_7",
          number: 7,
          url: "https://github.com/acme/widgets/pull/7",
          state: "MERGED",
          additions: 377,
          deletions: 14,
          changedFiles: 11,
          updatedAt: "2026-08-01T00:00:00Z",
        },
        pr_999999: null,
      },
    },
  });
}

describe("queryPullRequestsByNumberWithProviderResult", () => {
  it("keeps the pull requests GitHub did resolve when one number is gone", async () => {
    const graphql = vi.fn().mockRejectedValue(partialResponseError());
    const octokit = { graphql } as unknown as Octokit;

    const result = await queryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 999_999]
    );

    // Failing the batch here is the starvation bug: one deleted PR would block
    // every other target in it, forever, on every tick.
    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.pullRequests.map((pr) => pr.number)).toEqual([7]);
      expect(result.value.pullRequests[0]).toMatchObject({
        additions: 377,
        deletions: 14,
        changedFiles: 11,
      });
    }
  });

  // ISS-10489: a nested `response.data.data` payload keeps its errors at
  // `response.data.errors`, so counting `error.errors` logged 0 for it.
  it("logs the error count of the envelope it salvaged", async () => {
    vi.mocked(log.warn).mockClear();
    const { data, errors } = partialResponseError();
    const graphql = vi.fn().mockRejectedValue(
      Object.assign(new Error("Could not resolve to a PullRequest"), {
        response: { data: { data, errors } },
      })
    );
    const octokit = { graphql } as unknown as Octokit;

    const result = await queryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 999_999]
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("recovered from partial data"),
      expect.objectContaining({ graphqlErrorCount: 1 })
    );
  });

  it("classifies a repo-rooted NOT_FOUND through the production seam", async () => {
    // Not a direct helper test: a deleted call site here has to redden this.
    const graphql = vi.fn().mockRejectedValue(
      Object.assign(new Error("Could not resolve to a Repository"), {
        errors: [
          {
            type: "NOT_FOUND",
            path: ["repository"],
            message: "Could not resolve to a Repository with the name.",
          },
        ],
        data: { repository: null },
      })
    );
    const octokit = { graphql } as unknown as Octokit;

    const result = await queryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7]
    );

    expect(result.status).toBe(GitHubProviderResultStatus.ProviderRepoNotFound);
  });

  it("reports a failure when the error carries no data at all", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const octokit = { graphql } as unknown as Octokit;

    const result = await queryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7]
    );

    expect(result.status).not.toBe(GitHubProviderResultStatus.Success);
  });

  it("does not reach the provider when there is nothing to heal", async () => {
    const graphql = vi.fn();
    const octokit = { graphql } as unknown as Octokit;

    const result = await queryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      []
    );

    expect(graphql).not.toHaveBeenCalled();
    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.pullRequests).toEqual([]);
    }
  });

  it("asks for every requested number in one round trip", async () => {
    const graphql = vi.fn().mockResolvedValue({
      rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-08-26T08:00:00Z" },
      repository: {},
    });
    const octokit = { graphql } as unknown as Octokit;

    await queryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 12, 30]
    );

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql.mock.calls[0][1]).toEqual({ owner: OWNER, repo: REPO });
    const query = graphql.mock.calls[0][0] as string;
    expect(query).toContain("pullRequest(number: 7)");
    expect(query).toContain("pullRequest(number: 12)");
    expect(query).toContain("pullRequest(number: 30)");
  });

  // tamsinb review. Partial recovery used to run BEFORE the failure was
  // classified, so a RATE_LIMITED alias came back as a plain Success. The
  // caller then treated every requested number as attempted and stamped the
  // debounce over the ones the rate limit had stopped it from resolving, which
  // then waited out the window before anything retried them.
  it("reports a rate limit rather than recovering it as partial success", async () => {
    const graphql = vi
      .fn()
      .mockRejectedValue(rateLimitedPartialResponseError());
    const octokit = { graphql } as unknown as Octokit;

    const result = await queryPullRequestsByNumberWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [7, 999_999]
    );

    expect(result.status).toBe(GitHubProviderResultStatus.ProviderRateLimit);
  });
});
