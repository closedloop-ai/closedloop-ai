import type { Document } from "@repo/api/src/types/document";
import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { describe, expect, test } from "vitest";
import { createMockDocument } from "@/__tests__/fixtures/documents";
import { flattenAssociatedArtifacts } from "../flatten-associated-artifacts";

const ROOT_ID = "prd-root";

function makeLink(overrides: {
  id: string;
  sourceId: string;
  child: Document;
  targetType?: EntityType;
  resolvedType?: "DOCUMENT" | "EXTERNAL_LINK" | "NONE";
}): LinkedEntity {
  const {
    id,
    sourceId,
    child,
    targetType = EntityType.Document,
    resolvedType = "DOCUMENT",
  } = overrides;
  let resolvedEntity: LinkedEntity["resolvedEntity"];
  if (resolvedType === "DOCUMENT") {
    resolvedEntity = { type: EntityType.Document, entity: child };
  } else if (resolvedType === "EXTERNAL_LINK") {
    resolvedEntity = {
      type: EntityType.ExternalLink,
      entity: { id: child.id } as never,
    };
  } else {
    resolvedEntity = null;
  }
  return {
    id,
    organizationId: "org-1",
    sourceId,
    sourceType: EntityType.Document,
    sourceVersion: null,
    targetId: child.id,
    targetType,
    targetVersion: null,
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    resolvedEntity,
  };
}

describe("flattenAssociatedArtifacts", () => {
  test("returns an empty array when there are no linked entities", () => {
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

    expect(rows).toEqual([
      { document: featureA, linkId: "link-a", depth: 1 },
      { document: featureB, linkId: "link-b", depth: 1 },
    ]);
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

    expect(rows.map((r) => [r.document.id, r.depth])).toEqual([
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

    expect(rows.map((r) => r.document.id)).toEqual(["a", "b"]);
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

  test("skips links that do not resolve to a Document", () => {
    const docChild = createMockDocument({ id: "doc-child" });
    const externalChild = createMockDocument({ id: "ext-child" });
    const unresolvedChild = createMockDocument({ id: "nil-child" });
    const links = [
      makeLink({ id: "l-doc", sourceId: ROOT_ID, child: docChild }),
      makeLink({
        id: "l-ext",
        sourceId: ROOT_ID,
        child: externalChild,
        resolvedType: "EXTERNAL_LINK",
      }),
      makeLink({
        id: "l-nil",
        sourceId: ROOT_ID,
        child: unresolvedChild,
        resolvedType: "NONE",
      }),
    ];

    const rows = flattenAssociatedArtifacts(ROOT_ID, links);

    expect(rows.map((r) => r.document.id)).toEqual(["doc-child"]);
  });

  test("skips links where targetType is not Document", () => {
    const child = createMockDocument({ id: "child" });
    const links = [
      makeLink({
        id: "l-bad",
        sourceId: ROOT_ID,
        child,
        targetType: EntityType.ExternalLink,
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
