import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import { resolveRepositoryFromBranchRefs } from "./persist-session-children";

function branchRef(repositoryFullName: string, branchParticipation: string) {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName,
    branchName: "feat/test",
    method: "git_push",
    relation: "created" as const,
    branchParticipation,
  };
}

describe("resolveRepositoryFromBranchRefs (ISS-4431)", () => {
  it("returns null when artifactRefs is undefined", () => {
    expect(resolveRepositoryFromBranchRefs(undefined)).toBeNull();
  });

  it("returns null when artifactRefs is empty", () => {
    expect(resolveRepositoryFromBranchRefs([])).toBeNull();
  });

  it("returns null when no branch-kind refs exist", () => {
    const refs = [
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: "acme/web",
        prNumber: 42,
        method: "git_push",
        relation: "created" as const,
        branchParticipation: BranchParticipationKind.Wrote,
      },
    ];
    expect(resolveRepositoryFromBranchRefs(refs as never[])).toBeNull();
  });

  it("resolves repo from a single branch ref", () => {
    const refs = [branchRef("acme/web", BranchParticipationKind.Wrote)];
    expect(resolveRepositoryFromBranchRefs(refs as never[])).toBe("acme/web");
  });

  it("prefers Wrote participation over Reviewed", () => {
    const refs = [
      branchRef("acme/reviewed", BranchParticipationKind.Reviewed),
      branchRef("acme/wrote", BranchParticipationKind.Wrote),
    ];
    expect(resolveRepositoryFromBranchRefs(refs as never[])).toBe("acme/wrote");
  });

  it("falls back to first non-Wrote branch ref when no Wrote exists", () => {
    const refs = [
      branchRef("acme/reviewed", BranchParticipationKind.Reviewed),
      branchRef("acme/second", BranchParticipationKind.Reviewed),
    ];
    expect(resolveRepositoryFromBranchRefs(refs as never[])).toBe(
      "acme/reviewed"
    );
  });

  it("applies normalizeRepoFullName (strips trailing .git)", () => {
    const refs = [branchRef("acme/web.git", BranchParticipationKind.Wrote)];
    expect(resolveRepositoryFromBranchRefs(refs as never[])).toBe("acme/web");
  });

  it("applies normalizeRepoFullName (lowercases)", () => {
    const refs = [branchRef("Acme/Web", BranchParticipationKind.Wrote)];
    expect(resolveRepositoryFromBranchRefs(refs as never[])).toBe("acme/web");
  });

  it("skips slash-only repositoryFullName carrying no identity (ISS-4996)", () => {
    const refs = [branchRef("/", BranchParticipationKind.Wrote)];
    expect(resolveRepositoryFromBranchRefs(refs as never[])).toBeNull();
  });

  it("skips slash-only ref and falls back to a valid sibling (ISS-4996)", () => {
    const refs = [
      branchRef("/", BranchParticipationKind.Wrote),
      branchRef("acme/web", BranchParticipationKind.Reviewed),
    ];
    expect(resolveRepositoryFromBranchRefs(refs as never[])).toBe("acme/web");
  });
});
