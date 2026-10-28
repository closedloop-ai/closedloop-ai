import { describe, expect, it } from "vitest";
import {
  buildPullRequestsByNumberQuery,
  GITHUB_PULL_REQUESTS_BY_NUMBER_MAX_ALIASES,
  mapPullRequestsByNumberResponse,
  normalizePullRequestNumbers,
} from "./github-pull-requests-by-number.ts";

describe("buildPullRequestsByNumberQuery", () => {
  it("asks for each number directly rather than a window to scan", () => {
    const query = buildPullRequestsByNumberQuery([7, 12]);

    expect(query).toContain("pr_7: pullRequest(number: 7)");
    expect(query).toContain("pr_12: pullRequest(number: 12)");
    // A connection would reintroduce the scan the by-number read exists to avoid.
    expect(query).not.toContain("pullRequests(");
  });

  it("omits statusCheckRollup, which this lane never persists", () => {
    const query = buildPullRequestsByNumberQuery([7]);

    expect(query).not.toContain("statusCheckRollup");
    // …but still projects the fields the self-heal exists to fill.
    expect(query).toContain("additions");
    expect(query).toContain("deletions");
    expect(query).toContain("changedFiles");
  });

  it("drops numbers that could not name a pull request", () => {
    expect(normalizePullRequestNumbers([1, 0, -3, 2.5, Number.NaN, 4])).toEqual(
      [1, 4]
    );
    expect(buildPullRequestsByNumberQuery([1, -3])).not.toContain("-3");
  });

  it("dedupes and caps the alias count", () => {
    const many = Array.from({ length: 200 }, (_, index) => index + 1);

    expect(normalizePullRequestNumbers([5, 5, 5])).toEqual([5]);
    expect(normalizePullRequestNumbers(many)).toHaveLength(
      GITHUB_PULL_REQUESTS_BY_NUMBER_MAX_ALIASES
    );
  });
});

describe("mapPullRequestsByNumberResponse", () => {
  it("maps each alias back to a read-model pull request", () => {
    const result = mapPullRequestsByNumberResponse({
      rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-08-26T08:00:00Z" },
      repository: {
        pr_7: {
          id: "PR_7",
          number: 7,
          url: "https://github.com/acme/widgets/pull/7",
          state: "MERGED",
          mergedAt: "2026-08-01T00:00:00Z",
          additions: 12,
          deletions: 3,
          changedFiles: 2,
          updatedAt: "2026-08-01T00:00:00Z",
        },
      },
    });

    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0]).toMatchObject({
      number: 7,
      additions: 12,
      deletions: 3,
      changedFiles: 2,
    });
    expect(result.rateLimit.cost).toBe(1);
    // There is no next page to drain — the read asked for exactly what it needs.
    expect(result.truncated).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("ignores a repository field that is not one of our aliases", () => {
    // The response object carries whatever else the provider put there; only
    // the aliases this query minted may be read as pull requests.
    const result = mapPullRequestsByNumberResponse({
      repository: {
        __typename: "Repository",
        pr_7: {
          id: "PR_7",
          number: 7,
          url: "https://github.com/acme/widgets/pull/7",
          state: "MERGED",
        },
      } as never,
    });

    expect(result.pullRequests.map((pr) => pr.number)).toEqual([7]);
  });

  it("returns nothing for a pull request the provider could not resolve", () => {
    const result = mapPullRequestsByNumberResponse({
      repository: { pr_7: null },
    });

    expect(result.pullRequests).toEqual([]);
  });
});
