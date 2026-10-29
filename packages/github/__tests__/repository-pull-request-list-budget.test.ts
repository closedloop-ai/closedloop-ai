import type { Octokit } from "@octokit/rest";
import {
  GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_MAX_ITEMS,
  GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_MAX_PAGES,
  GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE,
} from "@repo/api/src/github-read-model";
import { describe, expect, it, vi } from "vitest";
import { getRepositoryPullRequestsWithMetadata } from "../index";

/**
 * #5898 review: the live repository PR list forwards `maxItems`/`maxPages` but
 * never a `pageSize`, so it takes the shared default. While a page held 100 a
 * single page satisfied the default 100-item budget; at 25 it stopped, and a
 * `limit: 30` request quietly returned 25 rows.
 *
 * The list's own limit is applied AFTER the fetch, so nothing downstream can
 * notice the shortfall — the read simply had fewer rows to choose from.
 */

const OWNER = "acme";
const REPO = "widgets";

function pageOf(startNumber: number, count: number, hasNextPage: boolean) {
  return {
    rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-08-24T08:00:00Z" },
    repository: {
      pullRequests: {
        pageInfo: {
          hasNextPage,
          endCursor: hasNextPage ? `cursor-${startNumber + count}` : null,
        },
        nodes: Array.from({ length: count }, (_, index) => ({
          id: `PR_${startNumber + index}`,
          number: startNumber + index,
          title: `PR ${startNumber + index}`,
          url: `https://github.com/${OWNER}/${REPO}/pull/${startNumber + index}`,
          state: "OPEN",
          updatedAt: "2026-08-24T00:00:00Z",
        })),
      },
    },
  };
}

describe("live repository PR list page budget", () => {
  it("returns the requested limit even when it exceeds one page", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        pageOf(1, GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE, true)
      )
      .mockResolvedValueOnce(
        pageOf(
          1 + GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE,
          GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE,
          false
        )
      );
    const octokit = { graphql } as unknown as Octokit;

    const result = await getRepositoryPullRequestsWithMetadata(
      octokit,
      OWNER,
      REPO,
      { limit: 30 }
    );

    // The failure this pins: one page of 25 satisfies neither the 30 asked for
    // nor the 100-item default budget, and the caller cannot tell.
    expect(result.pullRequests).toHaveLength(30);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({
        pageSize: GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE,
      })
    );
  });

  it("budgets enough pages to reach the default item count", () => {
    expect(
      GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_MAX_PAGES *
        GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE
    ).toBeGreaterThanOrEqual(GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_MAX_ITEMS);
  });
});
