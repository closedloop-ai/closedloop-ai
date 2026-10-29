import { describe, expect, it } from "vitest";
import { ArtifactFlag } from "../artifact-flags";

describe("ArtifactFlag", () => {
  it("defines exactly the four canonical artifact flag keys", () => {
    expect(Object.keys(ArtifactFlag).sort()).toEqual(
      ["Branches", "BranchDetail", "Documents", "Issues"].sort()
    );
  });

  it("has a non-empty string value for every key", () => {
    for (const value of Object.values(ArtifactFlag)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("pins the exact PostHog flag keys", () => {
    expect(ArtifactFlag).toEqual({
      Documents: "documents-nav",
      Issues: "issues-nav",
      Branches: "branches-nav",
      BranchDetail: "branch-detail-page",
    });
  });

  it("has no duplicate flag keys across artifacts", () => {
    const values = Object.values(ArtifactFlag);
    expect(new Set(values).size).toBe(values.length);
  });
});
