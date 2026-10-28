import { ProjectArtifactPlacementPosition } from "@repo/api/src/types/project-artifact-placement";
import { artifactManualMoveTarget } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-hierarchy-view";
import { genericArtifacts } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { resolveHierarchyKeyboardPlacement } from "@repo/app/shared/lib/hierarchy-placement";
import { describe, expect, it } from "vitest";

const ROWS = [
  { id: "root-a", parentId: null, depth: 0 },
  { id: "child-a", parentId: "root-a", depth: 1 },
  { id: "leaf-a", parentId: "child-a", depth: 2 },
  { id: "child-b", parentId: "root-a", depth: 1 },
  { id: "root-b", parentId: null, depth: 0 },
];

describe("hierarchy keyboard placement", () => {
  it("AC-003 resolves modifier-arrow placement from painted hierarchy order", () => {
    expect(resolveHierarchyKeyboardPlacement(ROWS, "root-a", "down")).toEqual({
      position: ProjectArtifactPlacementPosition.After,
      targetArtifactId: "root-b",
    });
    expect(resolveHierarchyKeyboardPlacement(ROWS, "child-b", "up")).toEqual({
      position: ProjectArtifactPlacementPosition.Before,
      targetArtifactId: "child-a",
    });
    expect(resolveHierarchyKeyboardPlacement(ROWS, "child-b", "in")).toEqual({
      position: ProjectArtifactPlacementPosition.Inside,
      targetArtifactId: "child-a",
    });
    expect(resolveHierarchyKeyboardPlacement(ROWS, "child-b", "out")).toEqual({
      position: ProjectArtifactPlacementPosition.After,
      targetArtifactId: "root-a",
    });
  });

  it("AC-003 refuses directions without a valid sibling or parent", () => {
    expect(resolveHierarchyKeyboardPlacement(ROWS, "root-a", "up")).toBeNull();
    expect(
      resolveHierarchyKeyboardPlacement(ROWS, "root-b", "down")
    ).toBeNull();
    expect(resolveHierarchyKeyboardPlacement(ROWS, "root-a", "out")).toBeNull();
    expect(resolveHierarchyKeyboardPlacement(ROWS, "missing", "in")).toBeNull();
  });

  it("AC-005 keeps the prototype adapter on the mastered keyboard resolver", () => {
    const fixture = genericArtifacts[0];
    if (!fixture) {
      throw new Error("Expected a generic artifact fixture");
    }
    const prototypeRows = ROWS.map((row) => ({
      artifact: {
        ...fixture,
        id: row.id,
        parentArtifactId: row.parentId,
      },
      depth: row.depth,
      hasChildren: ROWS.some((candidate) => candidate.parentId === row.id),
    }));
    expect(artifactManualMoveTarget(prototypeRows, "child-b", "out")).toEqual({
      placement: "after",
      targetId: "root-a",
    });
  });
});
