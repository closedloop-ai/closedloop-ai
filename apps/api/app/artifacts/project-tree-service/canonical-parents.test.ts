import { LinkType } from "@repo/api/src/types/artifact";
import { describe, expect, it } from "vitest";
import { resolveCanonicalParents } from "./canonical-parents";

const childId = "00000000-0000-4000-8000-000000000001";
const firstParentId = "00000000-0000-4000-8000-000000000002";
const secondParentId = "00000000-0000-4000-8000-000000000003";

describe("resolveCanonicalParents", () => {
  it("uses the explicit canonical edge while preserving per-parent rank", () => {
    const result = resolveCanonicalParents([
      parentLink("link-a", firstParentId, 0, null),
      parentLink("link-b", secondParentId, 2000, {
        hierarchy: { canonical: true, managed: true, version: 1 },
      }),
    ]);

    expect(result.get(childId)).toEqual({
      linkType: LinkType.Produces,
      parentId: secondParentId,
      sortOrder: 2000,
    });
  });

  it("keeps a retained suppressed lineage edge out of the canonical tree", () => {
    const result = resolveCanonicalParents([
      parentLink("link-a", firstParentId, 1000, {
        hierarchy: {
          canonical: false,
          managed: true,
          suppressed: true,
          version: 1,
        },
      }),
    ]);

    expect(result.has(childId)).toBe(false);
  });

  it("elects an explicit reparent across another child's timestamp tie", () => {
    const peerId = "00000000-0000-4000-8000-000000000004";
    const result = resolveCanonicalParents([
      {
        ...parentLink("old-parent", firstParentId, 1000, null),
        createdAt: new Date("2026-10-20T10:00:00Z"),
      },
      {
        ...parentLink("peer", firstParentId, 1000, null),
        targetId: peerId,
        createdAt: new Date("2026-10-20T10:00:00Z"),
      },
      {
        ...parentLink("reparent", secondParentId, 2000, {
          hierarchy: { canonical: true, managed: true, version: 1 },
        }),
        createdAt: new Date("2026-10-20T10:00:05Z"),
      },
    ]);

    expect(result.get(childId)?.parentId).toBe(secondParentId);
    expect(result.get(peerId)?.parentId).toBe(firstParentId);
  });
});

function parentLink(
  id: string,
  sourceId: string,
  sortOrder: number,
  metadata: null | {
    hierarchy: {
      canonical: boolean;
      managed: boolean;
      suppressed?: boolean;
      version: number;
    };
  }
) {
  return {
    id,
    sourceId,
    targetId: childId,
    linkType: LinkType.Produces,
    sortOrder,
    metadata,
    createdAt: new Date(`2026-10-20T10:00:0${id === "link-a" ? "0" : "1"}Z`),
  };
}
