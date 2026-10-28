import type { Octokit } from "@octokit/rest";
import { GitHubBundledPullRequestsStopReason } from "@repo/api/src/types/github-read-model";
import { describe, expect, it, vi } from "vitest";
import { queryBundledPullRequestsWithProviderResult } from "../bundled-pull-requests";
import { GitHubProviderResultStatus } from "../provider-result";

/**
 * ISS-7892. The window read used to page its whole budget on every tick no
 * matter how little had changed, because the loop had no way to know it had
 * reached already-processed rows. These pin the two things that stop it.
 */

const OWNER = "acme";
const REPO = "widgets";
const WATERMARK = "2026-08-20T00:00:00Z";

/**
 * A page whose rows are all MERGED and OLDER than the watermark except the
 * first `freshCount` — the real steady-state shape, where the changed set is a
 * handful of rows sitting on top of a large frozen tail.
 */
function pageOf(startNumber: number, freshCount: number, hasNextPage: boolean) {
  return {
    rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-08-26T08:00:00Z" },
    repository: {
      pullRequests: {
        pageInfo: {
          hasNextPage,
          endCursor: hasNextPage ? `cursor-${startNumber + 25}` : null,
        },
        nodes: Array.from({ length: 25 }, (_, index) => ({
          id: `PR_${startNumber + index}`,
          number: startNumber + index,
          title: `PR ${startNumber + index}`,
          url: `https://github.com/${OWNER}/${REPO}/pull/${startNumber + index}`,
          state: index < freshCount ? "OPEN" : "MERGED",
          updatedAt:
            index < freshCount
              ? "2026-08-25T12:00:00Z"
              : "2026-08-01T00:00:00Z",
        })),
      },
    },
  };
}

function octokitReturning(pages: number): {
  octokit: Octokit;
  graphql: ReturnType<typeof vi.fn>;
} {
  const graphql = vi.fn();
  for (let page = 0; page < pages; page++) {
    graphql.mockResolvedValueOnce(pageOf(1 + page * 25, 4, true));
  }
  return { octokit: { graphql } as unknown as Octokit, graphql };
}

describe("bundled pull request read scoping", () => {
  it("stops at the first page that reaches the watermark instead of spending the page budget", async () => {
    const { octokit, graphql } = octokitReturning(8);

    const result = await queryBundledPullRequestsWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [],
      { maxPages: 8, maxItems: 200, stopAtUpdatedAt: WATERMARK }
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    // ONE round trip, not eight: page 1 already carries rows we have seen, and
    // an UPDATED_AT DESC connection cannot hide a newer one behind them.
    expect(graphql).toHaveBeenCalledTimes(1);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.stopReason).toBe(
        GitHubBundledPullRequestsStopReason.WatermarkReached
      );
      expect(result.value.pullRequests).toHaveLength(25);
    }
  });

  it("still spends the page budget when every fetched row is newer than the watermark", async () => {
    const graphql = vi.fn();
    for (let page = 0; page < 4; page++) {
      graphql.mockResolvedValueOnce(pageOf(1 + page * 25, 25, true));
    }
    const octokit = { graphql } as unknown as Octokit;

    const result = await queryBundledPullRequestsWithProviderResult(
      octokit,
      OWNER,
      REPO,
      [],
      { maxPages: 4, maxItems: 200, stopAtUpdatedAt: WATERMARK }
    );

    // A genuine burst past the window must NOT be truncated by the stop.
    expect(graphql).toHaveBeenCalledTimes(4);
    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status === GitHubProviderResultStatus.Success) {
      expect(result.value.stopReason).toBe(
        GitHubBundledPullRequestsStopReason.PageLimit
      );
    }
  });

  it("pages the full budget when no watermark is supplied", async () => {
    const { octokit, graphql } = octokitReturning(8);

    await queryBundledPullRequestsWithProviderResult(octokit, OWNER, REPO, [], {
      maxPages: 8,
      maxItems: 200,
    });

    expect(graphql).toHaveBeenCalledTimes(8);
  });

  it("drops the statusCheckRollup selection when the caller does not want it", async () => {
    const { octokit, graphql } = octokitReturning(1);

    await queryBundledPullRequestsWithProviderResult(octokit, OWNER, REPO, [], {
      maxPages: 1,
      includeStatusCheckRollup: false,
    });

    expect(graphql.mock.calls[0][0]).not.toContain("statusCheckRollup");
    expect(graphql.mock.calls[0][0]).toContain("changedFiles");
  });

  it("keeps the statusCheckRollup selection by default", async () => {
    const { octokit, graphql } = octokitReturning(1);

    await queryBundledPullRequestsWithProviderResult(octokit, OWNER, REPO, [], {
      maxPages: 1,
    });

    expect(graphql.mock.calls[0][0]).toContain("statusCheckRollup");
  });
});
