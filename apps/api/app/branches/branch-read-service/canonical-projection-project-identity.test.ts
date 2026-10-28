import { describe, expect, it } from "vitest";
import {
  branchRow,
  ORGANIZATION_ID,
} from "@/__tests__/support/branches/canonical-projection.test-fixtures";
import { projectCanonicalCloudBranchRow } from "./canonical-projection";

/**
 * ISS-12453 — the Branch artifact's project, carried from the joined `project`
 * relation onto the wire `BranchRow` the Branches list renders. Split out of
 * `canonical-projection.test.ts` (ISS-12453 also added the canonical-row
 * coverage for it) to keep that file under the repo's 1,000-line ceiling.
 */
describe("project identity on the canonical list projection", () => {
  it("carries the joined project's id and name onto the wire row", () => {
    const row = branchRow({
      projectId: "project-xyz",
      project: { name: "Platform" },
    });

    const listRow = projectCanonicalCloudBranchRow(row, ORGANIZATION_ID);

    expect(listRow.projectId).toBe("project-xyz");
    expect(listRow.projectName).toBe("Platform");
  });

  it("reports both as null for a branch with no project, rather than inventing a name", () => {
    const row = branchRow({ projectId: null, project: null });

    const listRow = projectCanonicalCloudBranchRow(row, ORGANIZATION_ID);

    expect(listRow.projectId).toBeNull();
    expect(listRow.projectName).toBeNull();
  });
});
