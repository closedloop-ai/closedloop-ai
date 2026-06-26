import { GitHubPRState } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import {
  getPullRequestLifecycle,
  PullRequestLifecycle,
  PullRequestLifecycleLabels,
} from "../pull-request-lifecycle";

describe("getPullRequestLifecycle", () => {
  it.each([
    {
      expected: PullRequestLifecycle.Open,
      name: "OPEN/isDraft=false",
      pullRequest: { isDraft: false, prState: GitHubPRState.Open },
    },
    {
      expected: PullRequestLifecycle.Draft,
      name: "OPEN/isDraft=true",
      pullRequest: { isDraft: true, prState: GitHubPRState.Open },
    },
    {
      expected: PullRequestLifecycle.Closed,
      name: "CLOSED/isDraft=false",
      pullRequest: { isDraft: false, prState: GitHubPRState.Closed },
    },
    {
      expected: PullRequestLifecycle.Closed,
      name: "CLOSED/isDraft=true",
      pullRequest: { isDraft: true, prState: GitHubPRState.Closed },
    },
    {
      expected: PullRequestLifecycle.Merged,
      name: "MERGED/isDraft=false",
      pullRequest: { isDraft: false, prState: GitHubPRState.Merged },
    },
    {
      expected: PullRequestLifecycle.Merged,
      name: "MERGED/isDraft=true",
      pullRequest: { isDraft: true, prState: GitHubPRState.Merged },
    },
    {
      expected: PullRequestLifecycle.Closed,
      name: "state field wins over stale draft/open prState",
      pullRequest: {
        isDraft: true,
        prState: GitHubPRState.Open,
        state: GitHubPRState.Closed,
      },
    },
    {
      expected: PullRequestLifecycle.Closed,
      fallbackState: GitHubPRState.Closed,
      name: "fallback terminal state wins over stale draft metadata",
      pullRequest: { isDraft: true, prState: null },
    },
    {
      expected: PullRequestLifecycle.Open,
      fallbackState: GitHubPRState.Open,
      name: "null PR detail uses open fallback without draft metadata",
      pullRequest: null,
    },
    {
      expected: null,
      name: "missing PR state without fallback",
      pullRequest: { isDraft: true, prState: null },
    },
    {
      expected: null,
      fallbackState: "UNKNOWN",
      name: "unknown fallback state",
      pullRequest: null,
    },
  ] as const)("derives $name as $expected", ({
    expected,
    fallbackState = null,
    pullRequest,
  }) => {
    expect(getPullRequestLifecycle(pullRequest, fallbackState)).toBe(expected);
  });

  it("keeps the Draft label canonical", () => {
    expect(PullRequestLifecycleLabels[PullRequestLifecycle.Draft]).toBe(
      "Draft"
    );
  });
});
