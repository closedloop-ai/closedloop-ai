import {
  type ArtifactLinkEndpoint,
  type ArtifactLinkWithEndpoints,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import type { Document } from "@repo/api/src/types/document";
import { describe, expect, test } from "vitest";
import { createMockDocument } from "@/__tests__/fixtures/documents";
import { flattenAssociatedArtifacts } from "../flatten-associated-artifacts";

const ROOT_ID = "prd-root";

function endpointFromDocument(child: Document): ArtifactLinkEndpoint {
  return {
    id: child.id,
    organizationId: child.organizationId,
    projectId: child.projectId ?? "",
    workstreamId: child.workstreamId,
    type: ArtifactType.Document,
    subtype: null,
    name: child.title,
    slug: child.slug,
    status: child.status,
    priority: child.priority,
    assigneeId: child.assigneeId,
    dueDate: null,
    externalUrl: null,
    sortOrder: child.sortOrder,
    createdAt: child.createdAt,
    createdById: child.createdById,
    updatedAt: child.updatedAt,
  };
}

function makeLink(overrides: {
  id: string;
  sourceId: string;
  child: Document;
  targetType?: ArtifactType;
}): ArtifactLinkWithEndpoints {
  const { id, sourceId, child, targetType = ArtifactType.Document } = overrides;
  const targetEndpoint: ArtifactLinkEndpoint = {
    ...endpointFromDocument(child),
    type: targetType,
  };
  return {
    id,
    organizationId: "org-1",
    sourceId,
    targetId: child.id,
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    source: {
      id: sourceId,
      organizationId: "org-1",
      projectId: "",
      workstreamId: null,
      type: ArtifactType.Document,
      subtype: null,
      name: "Source",
      slug: null,
      status: "DRAFT",
      priority: null,
      assigneeId: null,
      dueDate: null,
      externalUrl: null,
      sortOrder: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      createdById: null,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
    target: targetEndpoint,
  };
}

describe("flattenAssociatedArtifacts", () => {
  test("returns an empty array when there are no resolved links", () => {
    expect(flattenAssociatedArtifacts(ROOT_ID, [])).toEqual([]);
  });

  test("flattens direct children at depth 1 in traversal order", () => {
    const featureA = createMockDocument({ id: "feat-a", title: "Feature A" });
    const featureB = createMockDocument({ id: "feat-b", title: "Feature B" });
    const links = [
      makeLink({ id: "link-a", sourceId: ROOT_ID, child: featureA }),
      makeLink({ id: "link-b", sourceId: ROOT_ID, child: featureB }),
    ];

    const rows = flattenAssociatedArtifacts(ROOT_ID, links);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.linkId).toBe("link-a");
    expect(rows[0]?.endpoint.id).toBe("feat-a");
    expect(rows[0]?.depth).toBe(1);
    expect(rows[1]?.linkId).toBe("link-b");
    expect(rows[1]?.endpoint.id).toBe("feat-b");
    expect(rows[1]?.depth).toBe(1);
  });

  test("recurses depth-first and tags descendant depth", () => {
    const feature = createMockDocument({ id: "feat-1" });
    const planA = createMockDocument({ id: "plan-a" });
    const planB = createMockDocument({ id: "plan-b" });
    const sibling = createMockDocument({ id: "feat-2" });
    const links = [
      makeLink({ id: "l-feat-1", sourceId: ROOT_ID, child: feature }),
      makeLink({ id: "l-plan-a", sourceId: feature.id, child: planA }),
      makeLink({ id: "l-plan-b", sourceId: feature.id, child: planB }),
      makeLink({ id: "l-feat-2", sourceId: ROOT_ID, child: sibling }),
    ];

    const rows = flattenAssociatedArtifacts(ROOT_ID, links);

    expect(rows.map((r) => [r.endpoint.id, r.depth])).toEqual([
      ["feat-1", 1],
      ["plan-a", 2],
      ["plan-b", 2],
      ["feat-2", 1],
    ]);
  });

  test("guards against cycles — a node reachable from itself is not revisited", () => {
    const a = createMockDocument({ id: "a" });
    const b = createMockDocument({ id: "b" });
    const links = [
      makeLink({ id: "l-a", sourceId: ROOT_ID, child: a }),
      makeLink({ id: "l-b", sourceId: a.id, child: b }),
      // Cycle: b → a
      makeLink({ id: "l-cycle", sourceId: b.id, child: a }),
    ];

    const rows = flattenAssociatedArtifacts(ROOT_ID, links);

    expect(rows.map((r) => r.endpoint.id)).toEqual(["a", "b"]);
  });

  test("deduplicates repeated parent→child edges", () => {
    const child = createMockDocument({ id: "dup-child" });
    const links = [
      makeLink({ id: "l1", sourceId: ROOT_ID, child }),
      makeLink({ id: "l2", sourceId: ROOT_ID, child }),
    ];

    const rows = flattenAssociatedArtifacts(ROOT_ID, links);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.linkId).toBe("l1");
  });

  test("skips links whose target is not a Document", () => {
    const child = createMockDocument({ id: "child" });
    const links = [
      makeLink({
        id: "l-bad",
        sourceId: ROOT_ID,
        child,
        targetType: ArtifactType.PullRequest,
      }),
    ];

    expect(flattenAssociatedArtifacts(ROOT_ID, links)).toEqual([]);
  });

  test("returns direct children only when intermediate parents are missing", () => {
    const orphanChild = createMockDocument({ id: "orphan" });
    const links = [
      // Child whose sourceId does not match ROOT_ID and has no upstream link.
      makeLink({
        id: "l-orphan",
        sourceId: "unrelated-parent",
        child: orphanChild,
      }),
    ];

    expect(flattenAssociatedArtifacts(ROOT_ID, links)).toEqual([]);
  });
});
