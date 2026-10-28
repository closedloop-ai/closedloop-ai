import { artifactColumnDefinitions } from "@repo/app/shared/components/generic-artifact-surface/fixtures";
import { describe, expect, it } from "vitest";
import { APPROVED_BRANCH_COLUMN_SPECS } from "../approved-branches-grid-adapter";

/**
 * ISS-12117 §2 (from ISS-11364): the Branches list shows branch-specific
 * columns, distinct from the generic artifact columns
 * (`artifactColumnDefinitions`, the template the other artifact lists build
 * from). The Surfaces Branches List Default story checks the same split on
 * the rendered headers.
 */
const branchColumnIds = APPROVED_BRANCH_COLUMN_SPECS.map((spec) => spec.id);
const branchLabels = APPROVED_BRANCH_COLUMN_SPECS.map((spec) => spec.label);
const genericColumnIds = artifactColumnDefinitions.map((column) => column.id);

describe("the Branches list columns", () => {
  it("carry what only a branch has, under the approved headers", () => {
    expect(
      APPROVED_BRANCH_COLUMN_SPECS.filter((spec) =>
        ["sessions", "changes", "pr", "lastActivity", "repo"].includes(spec.id)
      ).map((spec) => [spec.id, spec.label])
    ).toEqual([
      ["sessions", "Linked sessions"],
      ["changes", "Changes"],
      ["pr", "Pull request"],
      ["lastActivity", "Last active"],
      ["repo", "Repository"],
    ]);
  });

  it("name the pull request, linked sessions and last activity, which the generic set does not", () => {
    for (const id of ["pr", "sessions", "lastActivity"]) {
      expect(branchColumnIds).toContain(id);
      expect(genericColumnIds).not.toContain(id);
    }
  });

  it("leave out generic columns a branch has no value for", () => {
    // A branch is not versioned, not produced by one model and has no creation
    // cost; its comments live on its pull request; "Last active" replaces the
    // generic "Updated".
    const genericOnly = [
      "comments",
      "updated",
      "currentVersion",
      "model",
      "creationCost",
    ];
    for (const id of genericOnly) {
      expect(genericColumnIds).toContain(id);
      expect(branchColumnIds as readonly string[]).not.toContain(id);
    }
    for (const label of [
      "Comments",
      "Updated",
      "Current version",
      "Model",
      "Creation cost",
    ]) {
      expect(branchLabels).not.toContain(label);
    }
  });
});
