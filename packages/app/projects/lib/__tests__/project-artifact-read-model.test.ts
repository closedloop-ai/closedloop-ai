import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type { ProjectTreeDetailsResponse } from "@repo/api/src/types/project-tree";
import {
  HierarchyAvailability,
  TreeTruncationReason,
} from "@repo/api/src/types/project-tree";
import { describe, expect, it } from "vitest";
import {
  asChild,
  makeTreeArtifact,
} from "../../../documents/lib/__tests__/tree-fixtures";
import {
  projectArtifactReadModel,
  visibleProjectArtifacts,
} from "../project-artifact-read-model";

const root = makeTreeArtifact("root", ArtifactType.Document);
const child = asChild(makeTreeArtifact("child", ArtifactType.Branch), root.id);
const grandchild = asChild(
  makeTreeArtifact("grandchild", ArtifactType.Session),
  child.id
);

function tree(
  overrides: Partial<ProjectTreeDetailsResponse> = {}
): ProjectTreeDetailsResponse {
  return {
    nodes: [{ root, children: [child, grandchild] }],
    externalParents: [],
    ...overrides,
  };
}

describe("projectArtifactReadModel", () => {
  it("retains canonical identities and source records in traversal order", () => {
    const source = tree();
    const model = projectArtifactReadModel(source);
    expect(model.orderedArtifactIds).toEqual([
      root.id,
      child.id,
      grandchild.id,
    ]);
    expect(model.artifactsById.get(child.id)).toBe(child);
    expect(model.parentByArtifactId.get(child.id)).toBe(root.id);
    expect(model.parentByArtifactId.get(grandchild.id)).toBe(child.id);
  });

  it("does not prune ancestors or descendants at the four-level viewport boundary", () => {
    const descendants = Array.from({ length: 6 }, (_, index) =>
      asChild(
        makeTreeArtifact(`child-${index}`, ArtifactType.Document),
        index === 0 ? root.id : `child-${index - 1}`
      )
    );
    const model = projectArtifactReadModel(
      tree({ nodes: [{ root, children: descendants }] })
    );
    expect(model.artifactsById.size).toBe(7);
    expect(model.parentByArtifactId.get("child-5")).toBe("child-4");
  });

  it("retains external and category parent context without making those parents project members", () => {
    const external = {
      childId: root.id,
      parent: makeTreeArtifact("external", ArtifactType.Document),
      linkType: LinkType.Blocks,
    };
    const flat = {
      childId: root.id,
      parent: makeTreeArtifact("flat", ArtifactType.Branch),
      linkType: LinkType.Produces,
    };
    const model = projectArtifactReadModel(
      tree({ externalParents: [external], flatParents: [flat] })
    );
    expect(model.parentContextByArtifactId.get(root.id)).toEqual([
      external,
      flat,
    ]);
    expect(model.artifactsById.has("external")).toBe(false);
    expect(model.parentByArtifactId.has(root.id)).toBe(false);
  });

  it("retains truncation evidence by identity, including unknown future reasons", () => {
    const truncation = {
      anchorsIncluded: 1,
      anchorsMatchedAtLeast: 2,
      reasons: [TreeTruncationReason.AnchorCap, "future_cap"],
    };
    expect(projectArtifactReadModel(tree({ truncation })).truncation).toBe(
      truncation
    );
  });

  it("retains per-parent availability and child continuation", () => {
    const rootHierarchy = {
      availability: HierarchyAvailability.Partial,
      childCount: 3,
      nextCursor: "next-child-page",
    };
    const childHierarchy = {
      availability: HierarchyAvailability.PermissionHidden,
      childCount: 2,
    };
    const model = projectArtifactReadModel(
      tree({
        nodes: [
          {
            root,
            hierarchy: rootHierarchy,
            children: [{ ...child, hierarchy: childHierarchy }],
          },
        ],
        hierarchy: {
          contractVersion: 1,
          capabilities: {
            childPaging: true,
            exactPlacement: true,
            maxVisibleLevels: 4,
            mutationVersion: "version-1",
          },
          diagnostics: [],
          diagnosticsComplete: true,
        },
      })
    );
    expect(model.hierarchyByArtifactId.get(root.id)).toBe(rootHierarchy);
    expect(model.hierarchyByArtifactId.get(child.id)).toBe(childHierarchy);
  });

  it("deduplicates metadata cohorts and ignores ids outside the authoritative read", () => {
    const model = projectArtifactReadModel(tree());
    expect(
      visibleProjectArtifacts(model, [
        child.id,
        child.id,
        "not-readable",
        root.id,
      ])
    ).toEqual([child, root]);
  });

  it("keeps an unresolved read distinct from a completed empty read at the caller", () => {
    const model = projectArtifactReadModel(undefined);
    expect(model.artifactsById.size).toBe(0);
    expect(model.truncation).toBeUndefined();
    expect(visibleProjectArtifacts(model, [root.id])).toEqual([]);
  });
});
