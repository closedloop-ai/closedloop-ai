import { describe, expect, it } from "vitest";
import { BranchStatus } from "./branch.ts";
import { BranchMergedState } from "./branch-merged-state.ts";
import { toBranchStatus } from "./branch-status-derivation.ts";
import { GitHubPRState } from "./github-status.ts";

describe("toBranchStatus", () => {
  it("ISS-9664: a branch with no PR evidence is Open on every surface", () => {
    // The desktop producer used to answer Draft here while the cloud answered
    // Open, so the same branch stated two different facts depending on which
    // surface the reader was looking at. `null` artifactStatus is the desktop
    // shape: that store has no branch-owned lifecycle column.
    expect(toBranchStatus(null, null, false, BranchMergedState.Unknown)).toBe(
      "open"
    );
  });

  it("ISS-9664: a closed DRAFT PR is Draft, not Closed", () => {
    // Draft precedes Closed. Desktop checked Closed first, so a closed draft
    // read Closed there and Draft on web.
    expect(
      toBranchStatus(
        GitHubPRState.Closed,
        GitHubPRState.Closed,
        true,
        BranchMergedState.NotMerged
      )
    ).toBe("draft");
  });

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
