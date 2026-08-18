import { BranchStatus } from "@repo/api/src/types/branch";
import { BranchMergedState } from "@repo/api/src/types/branch-merged-state";
import { GitHubPRState } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import {
  deriveBranchRowStatus,
  toBranchStatus,
} from "./branch-status-derivation";

describe("toBranchStatus", () => {
  it("FEA-4333: merge evidence wins over a stale isDraft flag (merged draft → Merged, not Draft)", () => {
    // A stale capture: GitHub reports the PR merged (mergedState resolved via
    // merge evidence) yet the row still carries isDraft=true. Before the fix
    // isDraft was checked first, so this branch classified as Draft and fell into
    // activeBranchCount while its PR was also counted merged — a double-count.
    expect(
      toBranchStatus(
        GitHubPRState.Merged,
        GitHubPRState.Open,
        true,
        BranchMergedState.Merged
      )
    ).toBe(BranchStatus.Merged);
  });

  it("a genuine draft with no merge evidence is Draft", () => {
    expect(
      toBranchStatus(
        GitHubPRState.Open,
        GitHubPRState.Open,
        true,
        BranchMergedState.NotMerged
      )
    ).toBe(BranchStatus.Draft);
  });

  it("a closed-unmerged PR is Closed", () => {
    expect(
      toBranchStatus(
        GitHubPRState.Closed,
        GitHubPRState.Closed,
        false,
        BranchMergedState.NotMerged
      )
    ).toBe(BranchStatus.Closed);
  });

  it("an open non-draft PR with no terminal evidence is Open", () => {
    expect(
      toBranchStatus(
        GitHubPRState.Open,
        GitHubPRState.Open,
        false,
        BranchMergedState.Unknown
      )
    ).toBe(BranchStatus.Open);
  });
});

describe("deriveBranchRowStatus", () => {
  function makeRow(
    prOverrides: Partial<{
      prState: GitHubPRState | null;
      isDraft: boolean;
      mergedAt: Date | null;
    }> = {}
  ) {
    const pr = {
      branchArtifactId: "b1",
      isCurrent: true,
      repositoryId: "repo1",
      prState: GitHubPRState.Open as GitHubPRState | null,
      isDraft: false,
      mergedAt: null as Date | null,
      ...prOverrides,
    };
    return {
      id: "b1",
      status: "OPEN",
      branch: {
        repositoryId: "repo1",
        currentPullRequestDetail: pr,
      },
      pullRequestDetails: [pr],
    };
  }

  it("FEA-4333: a stale-open PR carrying mergedAt derives Merged (merge evidence via mergedAt)", () => {
    const { status } = deriveBranchRowStatus(
      makeRow({
        prState: GitHubPRState.Open,
        mergedAt: new Date("2026-05-20T10:00:00Z"),
      })
    );
    expect(status).toBe(BranchStatus.Merged);
  });

  it("FEA-4333: a merged-but-still-draft PR derives Merged, not Draft", () => {
    const { status } = deriveBranchRowStatus(
      makeRow({
        prState: GitHubPRState.Merged,
        isDraft: true,
        mergedAt: new Date("2026-05-20T10:00:00Z"),
      })
    );
    expect(status).toBe(BranchStatus.Merged);
  });

  it("a genuinely-open draft PR (no merge evidence) derives Draft", () => {
    const { status } = deriveBranchRowStatus(
      makeRow({ prState: GitHubPRState.Open, isDraft: true, mergedAt: null })
    );
    expect(status).toBe(BranchStatus.Draft);
  });
});
