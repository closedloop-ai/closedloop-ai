import { ArtifactType } from "@repo/api/src/types/artifact";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { toRowItem } from "@repo/app/documents/components/table/document-tree";
import {
  asChild,
  makeTreeArtifact,
} from "@repo/app/documents/lib/__tests__/tree-fixtures";
import {
  collectBulkMoveEntities,
  computeMoveEntities,
  findMergeCandidates,
  runBulkDelete,
} from "@repo/app/documents/lib/table-row-actions";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, it, vi } from "vitest";

// ---- Fixtures ----

const DOC = createMockDocument({ id: "doc-1", projectId: "proj-1" });

const TREE: ProjectTreeResponse = {
  nodes: [
    {
      root: makeTreeArtifact("doc-1", ArtifactType.Document),
      children: [
        asChild(makeTreeArtifact("fea-1", ArtifactType.Document), "doc-1"),
        asChild(makeTreeArtifact("pln-1", ArtifactType.Document), "fea-1"),
      ],
    },
  ],
  externalParents: [],
};

// ---- Tests ----

describe("computeMoveEntities", () => {
  it("moves a root with its transitive descendants as one bulk move", () => {
    const result = computeMoveEntities(toRowItem(DOC), TREE);
    expect(result).toEqual({
      kind: "bulk",
      entities: [
        { id: "doc-1", projectId: "proj-1" },
        { id: "fea-1" },
        { id: "pln-1" },
      ],
    });
  });

  it("moves a leaf document as a single entity", () => {
    const leaf = createMockDocument({ id: "leaf-1", projectId: "proj-1" });
    const result = computeMoveEntities(toRowItem(leaf), TREE);
    expect(result).toEqual({
      kind: "single",
      entity: { id: "leaf-1", projectId: "proj-1" },
    });
  });

  it("declines to move non-document rows", () => {
    const branchItem: DocumentRowItem = {
      kind: "branch",
      data: makeTreeArtifact("br-1", ArtifactType.Branch),
    };
    expect(computeMoveEntities(branchItem, TREE)).toEqual({ kind: "none" });
  });
});

describe("collectBulkMoveEntities", () => {
  it("resolves selected ids to movable entities, skipping unknown ids", () => {
    const entities = collectBulkMoveEntities(new Set(["doc-1", "missing"]), [
      DOC,
    ]);
    expect(entities).toEqual([{ id: "doc-1", projectId: "proj-1" }]);
  });
});

describe("runBulkDelete", () => {
  it("deletes every resolvable item and reports success", async () => {
    const performDelete = vi.fn().mockResolvedValue(true);
    const ok = await runBulkDelete(new Set(["doc-1"]), [DOC], performDelete);
    expect(ok).toBe(true);
    expect(performDelete).toHaveBeenCalledTimes(1);
  });

  it("reports failure when an id is missing or a delete fails", async () => {
    const performDelete = vi.fn().mockResolvedValue(true);
    expect(
      await runBulkDelete(new Set(["doc-1", "missing"]), [DOC], performDelete)
    ).toBe(false);

    const failingDelete = vi.fn().mockResolvedValue(false);
    expect(await runBulkDelete(new Set(["doc-1"]), [DOC], failingDelete)).toBe(
      false
    );
  });
});

describe("findMergeCandidates", () => {
  const other = createMockDocument({ id: "doc-2" });

  it("returns the pair when exactly two known documents are selected", () => {
    expect(
      findMergeCandidates(new Set(["doc-1", "doc-2"]), [DOC, other])
    ).toEqual([DOC, other]);
  });

  it("returns null for any other selection size or unknown ids", () => {
    expect(findMergeCandidates(new Set(["doc-1"]), [DOC, other])).toBeNull();
    expect(
      findMergeCandidates(new Set(["doc-1", "doc-2", "doc-3"]), [DOC, other])
    ).toBeNull();
    expect(
      findMergeCandidates(new Set(["doc-1", "missing"]), [DOC, other])
    ).toBeNull();
  });
});
