import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { ProjectArtifactPlacementPosition } from "@repo/api/src/types/project-artifact-placement";
import { applyPlacementToProjectTree } from "@repo/api/src/types/project-artifact-placement-tree";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { makeRawArtifact } from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, it } from "vitest";

const PROJECT_ID = "00000000-0000-4000-8000-000000000010";

function artifact(id: string) {
  return makeRawArtifact(ArtifactType.Document, {
    id,
    organizationId: "00000000-0000-4000-8000-000000000011",
    projectId: PROJECT_ID,
    slug: id,
    name: id,
    createdAt: new Date("2026-10-19T12:00:00.000Z"),
    updatedAt: new Date("2026-10-19T12:00:00.000Z"),
  });
}

function tree(): ProjectTreeResponse {
  const rootA = artifact("root-a");
  const childA = artifact("child-a");
  const leafA = artifact("leaf-a");
  const rootB = artifact("root-b");
  return {
    externalParents: [],
    nodes: [
      {
        root: rootA,
        children: [
          {
            ...childA,
            depth: 1,
            parentId: rootA.id,
            linkType: LinkType.Produces,
          },
          {
            ...leafA,
            depth: 2,
            parentId: childA.id,
            linkType: LinkType.Produces,
          },
        ],
      },
      { root: rootB, children: [] },
    ],
  };
}

function intent(
  sourceArtifactIds: string[],
  position: ProjectArtifactPlacementPosition,
  targetArtifactId?: string
) {
  return {
    sourceArtifactIds,
    destinationProjectId: PROJECT_ID,
    position,
    ...(targetArtifactId ? { targetArtifactId } : {}),
  };
}

describe("optimistic project artifact placement", () => {
  it("AC-010 preserves a complete subtree when reparenting its root", () => {
    const placed = applyPlacementToProjectTree(
      tree(),
      intent(["child-a"], ProjectArtifactPlacementPosition.Inside, "root-b")
    );
    expect(placed.nodes.map(({ root }) => root.id)).toEqual([
      "root-a",
      "root-b",
    ]);
    expect(placed.nodes[0]?.children).toEqual([]);
    expect(
      placed.nodes[1]?.children.map(({ id, parentId, depth }) => ({
        id,
        parentId,
        depth,
      }))
    ).toEqual([
      { id: "child-a", parentId: "root-b", depth: 1 },
      { id: "leaf-a", parentId: "child-a", depth: 2 },
    ]);
  });

  it("AC-010 preserves selected root order and removes selected descendants", () => {
    const placed = applyPlacementToProjectTree(
      tree(),
      intent(
        ["root-b", "root-a", "child-a"],
        ProjectArtifactPlacementPosition.Root
      )
    );
    expect(placed.nodes.map(({ root }) => root.id)).toEqual([
      "root-b",
      "root-a",
    ]);
    expect(placed.nodes[1]?.children.map(({ id }) => id)).toEqual([
      "child-a",
      "leaf-a",
    ]);
  });

  it("AC-010 returns the canonical cache unchanged for cycles and missing targets", () => {
    const current = tree();
    expect(
      applyPlacementToProjectTree(
        current,
        intent(["root-a"], ProjectArtifactPlacementPosition.Inside, "leaf-a")
      )
    ).toBe(current);
    expect(
      applyPlacementToProjectTree(
        current,
        intent(["root-a"], ProjectArtifactPlacementPosition.Before, "missing")
      )
    ).toBe(current);
  });
});
