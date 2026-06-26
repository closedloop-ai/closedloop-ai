import { describe, expect, expectTypeOf, it } from "vitest";
import type { BranchDetail as ArtifactBranchDetail } from "../artifact";
import {
  BranchKpiState,
  type BranchPageDetail,
  BranchPhase,
  type BranchPrState,
  BranchStatus,
  BranchViewerScope,
  decodeBranchId,
  encodeBranchId,
} from "../branch";
import type { GitHubPRState } from "../github";

describe("branch enums", () => {
  it("exposes the documented BranchStatus value set", () => {
    expect(Object.values(BranchStatus).sort()).toEqual(
      ["blocked", "closed", "draft", "merged", "open", "review"].sort()
    );
  });

  it("exposes the documented BranchPhase value set", () => {
    expect(Object.values(BranchPhase).sort()).toEqual(
      ["implement", "plan", "review", "rework", "verify"].sort()
    );
  });

  it("re-exports GitHubPRState as BranchPrState (no redefinition)", () => {
    // Compile-time: the two types are identical. A redefinition would diverge
    // here and fail typecheck.
    expectTypeOf<BranchPrState>().toEqualTypeOf<GitHubPRState>();
  });

  it("pins the BranchViewerScope wire values (drift guard)", () => {
    expect(BranchViewerScope.Organization).toBe("organization");
    expect(BranchViewerScope.Self).toBe("self");
  });

  it("pins the BranchKpiState wire values (drift guard)", () => {
    expect(BranchKpiState.Available).toBe("available");
    expect(BranchKpiState.Gated).toBe("gated");
    expect(BranchKpiState.Unavailable).toBe("unavailable");
  });
});

describe("encodeBranchId / decodeBranchId", () => {
  it("round-trips a slash-bearing repoFullName and a slash-bearing branch name", () => {
    const parts = {
      repoFullName: "repo/owner",
      branchName: "branch-with/slash",
    };
    const id = encodeBranchId(parts);
    // The delimiter survives because each component is encodeURIComponent'd.
    expect(id).toBe("repo%2Fowner::branch-with%2Fslash");
    expect(decodeBranchId(id)).toEqual(parts);
  });

  it("round-trips a null repoFullName through the 'local' sentinel", () => {
    const id = encodeBranchId({ repoFullName: null, branchName: "main" });
    expect(id).toBe("local::main");
    expect(decodeBranchId(id)).toEqual({
      repoFullName: null,
      branchName: "main",
    });
  });

  it("round-trips a branch name that itself contains the delimiter", () => {
    const parts = { repoFullName: "a/b", branchName: "weird::name" };
    expect(decodeBranchId(encodeBranchId(parts))).toEqual(parts);
  });

  it("degrades a malformed (delimiter-less) id to a repo-less branch instead of throwing", () => {
    expect(decodeBranchId("just-a-branch")).toEqual({
      repoFullName: null,
      branchName: "just-a-branch",
    });
  });
});

describe("BranchPageDetail vs artifact.ts BranchDetail (collision guard)", () => {
  it("keeps the two same-package detail types distinct and unshadowed", () => {
    // The surface detail type carries list fields (id/status/branchName); the
    // artifact-table detail carries repositoryId/headShaSource. If branch.ts
    // had reused the name `BranchDetail`, the artifact consumers would shadow or
    // collide and this file would fail to typecheck.
    expectTypeOf<BranchPageDetail>().toHaveProperty("status");
    expectTypeOf<BranchPageDetail>().toHaveProperty("mergedTrace");
    expectTypeOf<ArtifactBranchDetail>().toHaveProperty("repositoryId");
    expectTypeOf<ArtifactBranchDetail>().not.toHaveProperty("mergedTrace");
  });
});
