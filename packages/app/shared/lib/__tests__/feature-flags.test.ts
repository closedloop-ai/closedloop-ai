import { describe, expect, it } from "vitest";
import {
  ArtifactFlag,
  GRID_TABLE_V2_FEATURE_FLAG_KEY,
  PROJECT_ARTIFACTS_PAGINATION_FEATURE_FLAG_KEY,
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

describe("PROJECT_ARTIFACTS_PAGINATION_FEATURE_FLAG_KEY", () => {
  it("keeps the provisioned PostHog key", () => {
    // Pinned because this is a live PostHog key: it moved out of
    // `packages/api/src/types` (wongk) into this app-owned module, and a
    // relocation that also changed the string would silently un-gate the
    // surface for everyone it was rolled out to.
    expect(PROJECT_ARTIFACTS_PAGINATION_FEATURE_FLAG_KEY).toBe(
      "project-artifacts-pagination"
    );
    expect(PROJECT_ARTIFACTS_PAGINATION_FEATURE_FLAG_KEY).toMatch(KEBAB_CASE);
  });

  it("is its own key, not a fold into the shared grid-table rollout", () => {
    // The project artifact table is `DocumentsView`, not `GridTable`; sharing
    // `grid-table-v2` would flip Sessions, Branches, Agents, Routines and Packs
    // the moment anyone enabled paging on this page.
    expect(PROJECT_ARTIFACTS_PAGINATION_FEATURE_FLAG_KEY).not.toBe(
      GRID_TABLE_V2_FEATURE_FLAG_KEY
    );
  });
});
