import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  HierarchyAvailability,
  ProjectTreeIntegrityDiagnosticKind,
  type ProjectTreeResponse,
} from "@repo/api/src/types/project-tree";
import { describe, expect, it } from "vitest";
import type {
  ArtifactPlacementRow,
  PlacementState,
} from "@/app/documents/project-artifact-placement-service-support";
import {
  buildHierarchyResponse,
  ProjectHierarchyInvalidCursorError,
  ProjectHierarchyParentUnavailableError,
  ProjectHierarchyStaleCursorError,
  selectProjectHierarchyWindow,
} from "./project-tree-service/hierarchy-projection";

const projectId = "11111111-1111-7111-8111-111111111111";
const rootId = "22222222-2222-7222-8222-222222222222";
const childAId = "33333333-3333-7333-8333-333333333333";
const childBId = "44444444-4444-7444-8444-444444444444";
const childCId = "55555555-5555-7555-8555-555555555555";
const levelFiveId = "66666666-6666-7666-8666-666666666666";

describe("project hierarchy windows", () => {
  it("pages direct children with an opaque cursor and an honest total", () => {
    const state = placementState({
      artifacts: [row(rootId, 0), row(childAId, 10), row(childBId, 20)],
      parents: [
        [childAId, rootId],
        [childBId, rootId],
      ],
      version: "version-1",
    });

    const first = selectProjectHierarchyWindow(state, projectId, {
      childLimit: 1,
      hierarchy: true,
      parentArtifactId: rootId,
    });
    expect(first.rootIds).toEqual([childAId]);
    expect(first.totalChildCount).toBe(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.diagnosticsComplete).toBe(false);

    const second = selectProjectHierarchyWindow(state, projectId, {
      childCursor: first.nextCursor,
      childLimit: 1,
      hierarchy: true,
      parentArtifactId: rootId,
    });
    expect(second.rootIds).toEqual([childBId]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("rejects malformed, stale and unavailable child-page cursors", () => {
    const state = placementState({
      artifacts: [row(rootId, 0), row(childAId, 10), row(childBId, 20)],
      parents: [
        [childAId, rootId],
        [childBId, rootId],
      ],
      version: "version-1",
    });
    expect(() =>
      selectProjectHierarchyWindow(state, projectId, {
        childCursor: "not-a-cursor",
        hierarchy: true,
        parentArtifactId: rootId,
      })
    ).toThrow(ProjectHierarchyInvalidCursorError);
    expect(() =>
      selectProjectHierarchyWindow(state, projectId, {
        hierarchy: true,
        parentArtifactId: levelFiveId,
      })
    ).toThrow(ProjectHierarchyParentUnavailableError);

    const first = selectProjectHierarchyWindow(state, projectId, {
      childLimit: 1,
      hierarchy: true,
      parentArtifactId: rootId,
    });
    const changed = placementState({
      artifacts: state.artifacts,
      parents: [
        [childAId, rootId],
        [childBId, rootId],
      ],
      version: "version-2",
    });
    expect(() =>
      selectProjectHierarchyWindow(changed, projectId, {
        childCursor: first.nextCursor,
        hierarchy: true,
        parentArtifactId: rootId,
      })
    ).toThrow(ProjectHierarchyStaleCursorError);
  });

  it("keeps first-page diagnostics incomplete when a later root may add evidence", () => {
    const roots = Array.from({ length: 501 }, (_, index) =>
      row(rootIdFor(index), index)
    );
    const lastRootId = rootIdFor(500);
    const deepRows = [childAId, childBId, childCId, levelFiveId].map(
      (id, index) => row(id, 1000 + index)
    );
    const state = placementState({
      artifacts: [...roots, ...deepRows],
      parents: [
        [childAId, lastRootId],
        [childBId, childAId],
        [childCId, childBId],
        [levelFiveId, childCId],
      ],
      version: "version-501",
    });

    const first = selectProjectHierarchyWindow(state, projectId, {
      hierarchy: true,
    });
    expect(first.rootIds).toHaveLength(500);
    expect(first.rootNextCursor).toEqual(expect.any(String));
    expect(first.diagnosticsComplete).toBe(false);
    expect(first.diagnostics).not.toContainEqual(
      expect.objectContaining({ artifactId: levelFiveId })
    );

    const second = selectProjectHierarchyWindow(state, projectId, {
      hierarchy: true,
      rootCursor: first.rootNextCursor,
    });
    expect(second.rootIds).toEqual([lastRootId]);
    expect(second.diagnostics).toContainEqual({
      artifactId: levelFiveId,
      kind: ProjectTreeIntegrityDiagnosticKind.DepthCapped,
      relatedArtifactId: childCId,
    });
    expect(second.diagnosticsComplete).toBe(false);
  });

  it("reports diagnostics for a selected child subtree", () => {
    const state = placementState({
      artifacts: [
        row(rootId, 0),
        row(childAId, 10),
        row(childBId, 20),
        row(childCId, 30),
        row(levelFiveId, 40),
      ],
      parents: [
        [childAId, rootId],
        [childBId, childAId],
        [childCId, childBId],
        [levelFiveId, childCId],
      ],
      version: "version-deep",
    });

    const childPage = selectProjectHierarchyWindow(state, projectId, {
      hierarchy: true,
      parentArtifactId: rootId,
    });
    expect(childPage.diagnostics).toContainEqual({
      artifactId: levelFiveId,
      kind: ProjectTreeIntegrityDiagnosticKind.DepthCapped,
      relatedArtifactId: childCId,
    });
  });

  it("decorates four visible levels and marks the boundary partial", () => {
    const canonicalParents = new Map([
      [childAId, { linkType: LinkType.Produces, parentId: rootId }],
      [childBId, { linkType: LinkType.Produces, parentId: childAId }],
      [childCId, { linkType: LinkType.Produces, parentId: childBId }],
      [levelFiveId, { linkType: LinkType.Produces, parentId: childCId }],
    ]);
    const childIdsByParent = new Map([
      [rootId, [childAId]],
      [childAId, [childBId]],
      [childBId, [childCId]],
      [childCId, [levelFiveId]],
    ]);
    const legacyResponse: ProjectTreeResponse = {
      externalParents: [],
      nodes: [
        {
          root: artifact(rootId),
          children: [
            child(childAId, rootId, 1),
            child(childBId, childAId, 2),
            child(childCId, childBId, 3),
            child(levelFiveId, childCId, 4),
          ],
        },
      ],
    };

    const response = buildHierarchyResponse({
      canonicalParents,
      childIdsByParent,
      legacyResponse,
      window: {
        diagnostics: [],
        diagnosticsComplete: true,
        includedArtifactIds: new Set([rootId, childAId, childBId, childCId]),
        nodeBudgetHit: false,
        rootIds: [rootId],
        version: "version-visible",
      },
    });

    expect(response.nodes[0]?.children.map((item) => item.id)).toEqual([
      childAId,
      childBId,
      childCId,
    ]);
    expect(response.nodes[0]?.children.at(-1)?.hierarchy).toEqual({
      availability: HierarchyAvailability.Partial,
      childCount: 1,
      hierarchyPath: [rootId, childAId, childBId, childCId],
    });
  });
});

function placementState({
  artifacts,
  parents,
  version,
}: {
  artifacts: ArtifactPlacementRow[];
  parents: [childId: string, parentId: string][];
  version: string;
}): PlacementState {
  const artifactsById = new Map(artifacts.map((item) => [item.id, item]));
  const canonicalParents = new Map(
    parents.map(([childId, parentId]) => [
      childId,
      { linkType: LinkType.Produces, parentId },
    ])
  );
  const childrenByParent = new Map<string, string[]>();
  const incomingProduces = new Map<string, string[]>();
  for (const [childId, parentId] of parents) {
    const children = childrenByParent.get(parentId) ?? [];
    children.push(childId);
    childrenByParent.set(parentId, children);
    incomingProduces.set(childId, [parentId]);
  }
  return {
    allParentIds: new Map(),
    artifacts,
    artifactsById,
    canonicalParents,
    childrenByParent,
    incomingProduces,
    parentProjectIds: new Map(),
    projectVersions: { [projectId]: version },
  };
}

function row(id: string, sortOrder: number): ArtifactPlacementRow {
  return {
    createdAt: new Date("2026-10-19T00:00:00.000Z"),
    id,
    projectId,
    sortOrder,
  };
}

function rootIdFor(index: number): string {
  return `00000000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`;
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
    organizationId: "77777777-7777-7777-8777-777777777777",
    priority: null,
    projectId,
    slug: null,
    sortOrder: 0,
    status: "BACKLOG",
    subtype: null,
    type: ArtifactType.Document,
    updatedAt: new Date("2026-10-19T00:00:00.000Z"),
  };
}

function child(id: string, parentId: string, depth: number) {
  return {
    ...artifact(id),
    depth,
    linkType: LinkType.Produces,
    parentId,
  };
}
