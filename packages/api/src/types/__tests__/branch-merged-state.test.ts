import { describe, expect, it } from "vitest";
import {
  BranchMergedState,
  deriveBranchMergedState,
} from "../branch-merged-state";
import { GitHubPRState } from "../github-status";

describe("deriveBranchMergedState", () => {
  it("uses connected PR merged evidence before local artifact status", () => {
    expect(
      deriveBranchMergedState({
        connectedPrState: GitHubPRState.Merged,
        localArtifactStatus: GitHubPRState.Open,
        hasConnectedPrEvidence: true,
      })
    ).toBe(BranchMergedState.Merged);
  });

  it("keeps connected non-merged evidence conservative when artifact status is stale merged", () => {
    expect(
      deriveBranchMergedState({
        connectedPrState: GitHubPRState.Open,
        localArtifactStatus: GitHubPRState.Merged,
        hasConnectedPrEvidence: true,
      })
    ).toBe(BranchMergedState.NotMerged);
  });

  it("falls back to local artifact status only when connected evidence is absent", () => {
    expect(
      deriveBranchMergedState({ localArtifactStatus: GitHubPRState.Merged })
    ).toBe(BranchMergedState.Merged);
  });

  it("returns unknown for unsupported or missing persisted states", () => {
    expect(deriveBranchMergedState({ localArtifactStatus: "STALE" })).toBe(
      BranchMergedState.Unknown
    );
  });
});
