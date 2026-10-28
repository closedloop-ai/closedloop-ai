// ISS-7029 — the two PURE decisions `getRepositoryPullRequests` delegates to
// this module, pinned at the module boundary.
//
// `index.ts` reaches them only through an Octokit-backed read, so a package-lane
// suite that exercised them end to end would be asserting the mock, not the
// clamp or the state filter. Both are the kind of rule that fails silently: a
// clamp that stops flooring at 1 asks GitHub for `per_page=0`, and a state
// filter that drops MERGED hides every merged PR from a `closed` list.

import type { GitHubReadModelPullRequest } from "@repo/api/src/types/github-read-model";
import { GitHubReadModelSource } from "@repo/api/src/types/github-read-model";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { describe, expect, it } from "vitest";
import {
  mapRepositoryPullRequest,
  normalizeRepositoryPullRequestListLimit,
  repositoryPullRequestMatchesState,
} from "../repository-pull-request-list";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function readModelPullRequest(
  state: GitHubPRState
): GitHubReadModelPullRequest {
  return {
    githubId: "PR_kwDO",
    number: 5165,
    title: "Align the e2e spec-name sets",
    htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/5165",
    headBranch: "feat/iss-6415",
    baseBranch: "main",
    headSha: "0b606aa84",
    state,
    isDraft: false,
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: "2026-08-17T10:00:00Z",
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: "2026-08-17T11:00:00Z",
    author: "tamsinb",
    source: GitHubReadModelSource.Provider,
  };
}

function matches(
  state: GitHubPRState,
  filter: Parameters<typeof repositoryPullRequestMatchesState>[1]
): boolean {
  return repositoryPullRequestMatchesState(readModelPullRequest(state), filter);
}

describe("normalizeRepositoryPullRequestListLimit", () => {
  it("falls back to the default when the caller passed no limit", () => {
    expect(normalizeRepositoryPullRequestListLimit(undefined)).toBe(
      DEFAULT_LIMIT
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "falls back to the default for the non-finite limit %p",
    (limit) => {
      expect(normalizeRepositoryPullRequestListLimit(limit)).toBe(
        DEFAULT_LIMIT
      );
    }
  );

  it("keeps a limit already inside the bounded window", () => {
    expect(normalizeRepositoryPullRequestListLimit(7)).toBe(7);
  });

  it("caps at the page maximum rather than forwarding it to GitHub", () => {
    expect(normalizeRepositoryPullRequestListLimit(5000)).toBe(MAX_LIMIT);
  });

  it.each([0, -1])(
    "floors %p at 1, because Math.min alone would forward a page size GitHub rejects",
    (limit) => {
      expect(normalizeRepositoryPullRequestListLimit(limit)).toBe(1);
    }
  );

  it("truncates a fractional limit toward zero before clamping", () => {
    expect(normalizeRepositoryPullRequestListLimit(7.9)).toBe(7);
  });

  it("floors a fraction below 1 rather than truncating it to 0", () => {
    expect(normalizeRepositoryPullRequestListLimit(0.5)).toBe(1);
  });
});

describe("repositoryPullRequestMatchesState", () => {
  it.each([GitHubPRState.Open, GitHubPRState.Closed, GitHubPRState.Merged])(
    "admits a %s pull request under the all filter",
    (state) => {
      expect(matches(state, "all")).toBe(true);
    }
  );

  it("admits only OPEN under the open filter", () => {
    expect(matches(GitHubPRState.Open, "open")).toBe(true);
    expect(matches(GitHubPRState.Closed, "open")).toBe(false);
    expect(matches(GitHubPRState.Merged, "open")).toBe(false);
  });

  it("admits MERGED as well as CLOSED under the closed filter", () => {
    // GitHub models a merged PR as its own state, so a closed list that tested
    // for CLOSED alone would hide every PR that actually landed.
    expect(matches(GitHubPRState.Merged, "closed")).toBe(true);
    expect(matches(GitHubPRState.Closed, "closed")).toBe(true);
  });

  it("rejects an OPEN pull request under the closed filter", () => {
    expect(matches(GitHubPRState.Open, "closed")).toBe(false);
  });
});

// ISS-12344 decision record (thread th_1__bTDiF9jNPx9ebLHmn0): the live lane
// marks the same GitHub-confirmed head the projection lane does, so the
// desktop takes the same head whichever lane served the repository.
describe("mapRepositoryPullRequest gitHubHeadBranch", () => {
  const REPOSITORY = "closedloop-ai/closedloop-ai";

  function withHeadRepository(fullName: string): GitHubReadModelPullRequest {
    return {
      ...readModelPullRequest(GitHubPRState.Open),
      headRepository: {
        repository: { fullName },
      } as GitHubReadModelPullRequest["headRepository"],
    };
  }

  it("marks the head as GitHub-confirmed when it lives in the listed repository", () => {
    expect(
      mapRepositoryPullRequest(
        withHeadRepository("Closedloop-AI/ClosedLoop-AI"),
        REPOSITORY
      ).gitHubHeadBranch
    ).toBe("feat/iss-6415");
  });

  it("omits it for a head in a fork", () => {
    expect(
      mapRepositoryPullRequest(
        withHeadRepository("contributor/closedloop-ai"),
        REPOSITORY
      )
    ).not.toHaveProperty("gitHubHeadBranch");
  });

  it("omits it when the read reported no head repository", () => {
    expect(
      mapRepositoryPullRequest(
        readModelPullRequest(GitHubPRState.Open),
        REPOSITORY
      )
    ).not.toHaveProperty("gitHubHeadBranch");
  });
});
