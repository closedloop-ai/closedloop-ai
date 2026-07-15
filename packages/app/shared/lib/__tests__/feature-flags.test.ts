import { describe, expect, it } from "vitest";
import {
  ArtifactFlag,
  STACK_RANK_PROJECT_PAGE_FEATURE_FLAG_KEY,
} from "../feature-flags";

// Kebab-case (lowercase alphanumerics joined by single hyphens), matching the
// PostHog key convention the rest of ArtifactFlag follows.
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("ArtifactFlag.BranchDetail", () => {
  it("retains the legacy kebab-case `branch-detail-page` key", () => {
    expect(ArtifactFlag.BranchDetail).toBe("branch-detail-page");
    expect(ArtifactFlag.BranchDetail).toMatch(KEBAB_CASE);
  });

  it("is distinct from the provisioned branches-nav rollout flag", () => {
    // `branch-detail-page` remains available for compatibility, but the web
    // Branches surface uses the provisioned `branches-nav` flag for list and
    // detail access.
    expect(ArtifactFlag.BranchDetail).not.toBe(ArtifactFlag.Branches);
    expect(ArtifactFlag.Branches).toBe("branches-nav");
  });

  it("is distinct from the unrelated stack-rank project page flag", () => {
    expect(ArtifactFlag.BranchDetail).not.toBe(
      STACK_RANK_PROJECT_PAGE_FEATURE_FLAG_KEY
    );
  });
});
