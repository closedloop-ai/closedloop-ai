/**
 * @file pull-request-lifecycle-observation.test.ts
 * @description Pins the two "was this row actually measured" predicates:
 * the narrow lifecycle check and the broader evidence check that subsumes it.
 */
import { describe, expect, it } from "vitest";
import { ReviewDecision } from "./branch-checks.ts";
import { GitHubPRState } from "./github-status.ts";
import {
  hasObservedPullRequestEvidence,
  hasObservedPullRequestLifecycle,
} from "./pull-request-lifecycle-observation.ts";

describe("hasObservedPullRequestLifecycle", () => {
  it("returns false for a bare default row with no lifecycle evidence", () => {
    expect(hasObservedPullRequestLifecycle({})).toBe(false);
  });

  it("returns false for an explicit Open state with all timestamps absent", () => {
    expect(
      hasObservedPullRequestLifecycle({
        prState: GitHubPRState.Open,
        mergedAt: null,
        closedAt: null,
        githubCreatedAt: null,
      })
    ).toBe(false);
  });

  it("returns true when mergedAt is set", () => {
    expect(hasObservedPullRequestLifecycle({ mergedAt: new Date() })).toBe(
      true
    );
  });

  it("returns true when closedAt is set", () => {
    expect(
      hasObservedPullRequestLifecycle({ closedAt: "2026-01-01T00:00:00Z" })
    ).toBe(true);
  });

  it("returns true when prState is Merged even without a terminal timestamp", () => {
    expect(
      hasObservedPullRequestLifecycle({ prState: GitHubPRState.Merged })
    ).toBe(true);
  });

  it("returns true when prState is Closed even without a terminal timestamp", () => {
    expect(
      hasObservedPullRequestLifecycle({ prState: GitHubPRState.Closed })
    ).toBe(true);
  });

  it("returns true when only githubCreatedAt is set", () => {
    expect(
      hasObservedPullRequestLifecycle({ githubCreatedAt: new Date() })
    ).toBe(true);
  });
});

describe("hasObservedPullRequestEvidence", () => {
  it("returns false for a bare default row with no evidence at all", () => {
    expect(hasObservedPullRequestEvidence({})).toBe(false);
  });

  it("returns true whenever the lifecycle predicate is true (delegates)", () => {
    expect(hasObservedPullRequestEvidence({ mergedAt: new Date() })).toBe(true);
  });

  it("returns true when isDraft is true even with no lifecycle evidence", () => {
    expect(hasObservedPullRequestEvidence({ isDraft: true })).toBe(true);
  });

  it("returns false when isDraft is false, since false is the column default", () => {
    expect(hasObservedPullRequestEvidence({ isDraft: false })).toBe(false);
  });

  it("returns true when a title is present", () => {
    expect(hasObservedPullRequestEvidence({ title: "Fix the bug" })).toBe(true);
  });

  it("returns true when a reviewDecision is present", () => {
    expect(
      hasObservedPullRequestEvidence({
        reviewDecision: ReviewDecision.Approved,
      })
    ).toBe(true);
  });

  it("returns true when additions is present, including zero", () => {
    expect(hasObservedPullRequestEvidence({ additions: 0 })).toBe(true);
  });

  it("returns true when deletions is present, including zero", () => {
    expect(hasObservedPullRequestEvidence({ deletions: 0 })).toBe(true);
  });

  it("returns true when changedFiles is present, including zero", () => {
    expect(hasObservedPullRequestEvidence({ changedFiles: 0 })).toBe(true);
  });

  it("returns false when every evidence field is null or absent", () => {
    expect(
      hasObservedPullRequestEvidence({
        prState: GitHubPRState.Open,
        isDraft: null,
        title: null,
        reviewDecision: null,
        additions: null,
        deletions: null,
        changedFiles: null,
        mergedAt: null,
        closedAt: null,
        githubCreatedAt: null,
      })
    ).toBe(false);
  });
});
