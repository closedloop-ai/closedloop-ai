import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  type ArtifactHierarchyState,
  type DetailedTreeChild,
  HierarchyAvailability,
  type ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import { describe, expect, it } from "vitest";
import {
  completeProjectTreeArtifactIds,
  hierarchyExpansionParentIds,
  mergeProjectTreeExpansionPages,
} from "../project-hierarchy-child-pages";

const rootId = "11111111-1111-7111-8111-111111111111";
const childAId = "22222222-2222-7222-8222-222222222222";
const childBId = "33333333-3333-7333-8333-333333333333";

describe("project hierarchy child pages", () => {
  it("merges complete expanded children in server order without duplicates", () => {
    const base = tree(rootId, [child(childAId, rootId)], {
      availability: HierarchyAvailability.Partial,
      canMove: false,
      childCount: 2,
      hierarchyPath: [rootId],
    });
    const page: ProjectTreeDetailsResponse = {
      ...tree(childAId, []),
      nodes: [
        {
          children: [],
          hierarchy: {
            availability: HierarchyAvailability.Complete,
            canMove: true,
            childCount: 0,
            hierarchyPath: [rootId, childAId],
          },
          root: artifact(childAId),
        },
        {
          children: [],
          hierarchy: {
            availability: HierarchyAvailability.Complete,
            canMove: true,
            childCount: 0,
            hierarchyPath: [rootId, childBId],
          },
          root: artifact(childBId),
        },
      ],
      hierarchy: {
        capabilities: {
          childPaging: true,
          exactPlacement: true,
          maxVisibleLevels: 4,
          mutationVersion: "version-1",
          rootPaging: true,
        },
        childCount: 2,
        contractVersion: 1,
        diagnostics: [],
        diagnosticsComplete: true,
        parentArtifactId: rootId,
      },
    };

    const merged = mergeProjectTreeExpansionPages(base, [[page]]);

    expect(merged.nodes[0]?.children.map((entry) => entry.id)).toEqual([
      childAId,
      childBId,
    ]);
    expect(merged.nodes[0]?.hierarchy).toMatchObject({
      availability: HierarchyAvailability.Complete,
      canMove: false,
      childCount: 2,
      hierarchyPath: [rootId],
    });
    expect(merged.nodes[0]?.children[0]?.hierarchy).toMatchObject({
      canMove: true,
      hierarchyPath: [rootId, childAId],
    });
    expect(hierarchyExpansionParentIds(merged, () => true)).toEqual([]);
    expect(hierarchyExpansionParentIds(merged, () => false)).toEqual([]);
  });

  it("returns authoritative ids only for a fully loaded hierarchy", () => {
    const complete = tree(rootId, [
      {
        ...child(childAId, rootId),
        hierarchy: {
          availability: HierarchyAvailability.Complete,
          childCount: 0,
        },
      },
    ]);

    expect(completeProjectTreeArtifactIds(complete)).toEqual(
      new Set([rootId, childAId])
    );
    if (!complete.hierarchy) {
      throw new Error("Expected hierarchy fixture");
    }
    expect(
      completeProjectTreeArtifactIds({
        ...complete,
        hierarchy: { ...complete.hierarchy, rootNextCursor: "next-root" },
      })
    ).toBeNull();
    expect(
      completeProjectTreeArtifactIds(
        tree(rootId, [child(childAId, rootId)], {
          availability: HierarchyAvailability.Partial,
          childCount: 2,
        })
      )
    ).toBeNull();
  });

  it("keeps a capped expansion partial and retains its continuation", () => {
    const base = tree(rootId, [child(childAId, rootId)], {
      availability: HierarchyAvailability.Partial,
      childCount: 6000,
      hierarchyPath: [rootId],
    });
    const cappedPage = tree(childAId, []);
    if (!cappedPage.hierarchy) {
      throw new Error("Expected hierarchy fixture");
    }
    cappedPage.hierarchy = {
      ...cappedPage.hierarchy,
      childCount: 6000,
      nextCursor: "cursor-50",
      parentArtifactId: rootId,
    };

    const merged = mergeProjectTreeExpansionPages(base, [[cappedPage]]);

    expect(merged.nodes[0]?.hierarchy).toMatchObject({
      availability: HierarchyAvailability.Partial,
      childCount: 6000,
      hierarchyPath: [rootId],
      nextCursor: "cursor-50",
    });
    expect(completeProjectTreeArtifactIds(merged)).toBeNull();
  });
});

function tree(
  id: string,
  children: ReturnType<typeof child>[],
  hierarchy: ArtifactHierarchyState = {
    availability: HierarchyAvailability.Complete,
    childCount: children.length,
  }
): ProjectTreeDetailsResponse {
  return {
    externalParents: [],
    hierarchy: {
      capabilities: {
        childPaging: true,
        exactPlacement: true,
        maxVisibleLevels: 4,
        mutationVersion: "version-1",
        rootPaging: true,
      },
      contractVersion: 1,
      diagnostics: [],
      diagnosticsComplete: true,
    },
    nodes: [{ children, hierarchy, root: artifact(id) }],
  };
}

function child(id: string, parentId: string): DetailedTreeChild {
  return {
    ...artifact(id),
    depth: 1,
    linkType: LinkType.Produces,
    parentId,
  };
}

function artifact(id: string) {
  return {
    assignee: null,
    assigneeId: null,
    createdAt: new Date("2026-10-19T00:00:00.000Z"),
    createdById: null,
    dueDate: null,
    externalUrl: null,
    id,
    name: id,
    organizationId: "44444444-4444-7444-8444-444444444444",
    priority: null,
    projectId: "55555555-5555-7555-8555-555555555555",
    slug: null,
    sortOrder: 1,
    status: "BACKLOG",
    subtype: null,
    type: ArtifactType.Document,
    updatedAt: new Date("2026-10-19T00:00:00.000Z"),
  };
}
