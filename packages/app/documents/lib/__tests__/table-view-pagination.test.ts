import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type {
  ProjectTreeResponse,
  TreeChild,
  TreeNode,
} from "@repo/api/src/types/project-tree";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { describe, expect, test } from "vitest";
import { countTableViewRows, pageTableView } from "../table-view-pagination";

// ---- Fixtures ----

function doc(
  id: string,
  projectId = "p1",
  status: string = DocumentStatus.Draft
): DocumentRowData {
  return {
    id,
    title: id,
    slug: id,
    type: DocumentType.Prd,
    subtype: null,
    status,
    priority: Priority.Medium,
    projectId,
    project: null,
    assignee: null,
    updatedAt: "2026-07-01T00:00:00.000Z",
  } as unknown as DocumentRowData;
}

function branchNode(id: string): TreeNode {
  return {
    root: {
      id,
      type: ArtifactType.Branch,
      name: id,
      status: "OPEN",
      updatedAt: "2026-07-01T00:00:00.000Z",
    } as unknown as TreeNode["root"],
    children: [],
  };
}

function docNodeWithBranchChild(docId: string, branchId: string): TreeNode {
  const child: TreeChild = {
    id: branchId,
    type: ArtifactType.Branch,
    name: branchId,
    status: "OPEN",
    updatedAt: "2026-07-01T00:00:00.000Z",
    linkType: LinkType.Produces,
    depth: 1,
    parentId: docId,
  } as unknown as TreeChild;
  return {
    root: {
      id: docId,
      type: ArtifactType.Document,
      name: docId,
      status: "DRAFT",
      updatedAt: "2026-07-01T00:00:00.000Z",
    } as unknown as TreeNode["root"],
    children: [child],
  };
}

/** A branch root parenting another branch — the shape the Branches tab flattens. */
function branchRootWithBranchChild(rootId: string, childId: string): TreeNode {
  const child: TreeChild = {
    id: childId,
    type: ArtifactType.Branch,
    name: childId,
    status: "OPEN",
    updatedAt: "2026-07-01T00:00:00.000Z",
    linkType: LinkType.Produces,
    depth: 1,
    parentId: rootId,
  } as unknown as TreeChild;
  return { ...branchNode(rootId), children: [child] };
}

/**
 * The branch rows the Branches tab would actually render from a sliced tree —
 * the same `[root, ...children]` walk, deduped, that `collectArtifactRowItems`
 * performs. Asserting on this rather than on `nodes` is the point: the defect
 * was a root that survived the slice as a node and therefore as a ROW.
 */
function renderedBranchIds(
  treeData: ProjectTreeResponse | null | undefined
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const node of treeData?.nodes ?? []) {
    for (const entity of [node.root, ...node.children]) {
      if (entity.type === ArtifactType.Branch && !seen.has(entity.id)) {
        seen.add(entity.id);
        ids.push(entity.id);
      }
    }
  }
  return ids;
}

function tree(nodes: TreeNode[]): ProjectTreeResponse {
  return { nodes, externalParents: [] };
}

const baseInput = {
  filterCategory: "all" as const,
  filterText: "",
  applyProjectFilters: undefined,
  sortBy: null,
  sortDir: "asc" as const,
  groupBy: GroupByMode.None,
};

// ---- Honest count ----

describe("countTableViewRows — one honest total across all three streams", () => {
  test("counts documents plus tree roots once, not double, for entities in both streams", () => {
    // doc-1 is BOTH an assigned document AND a tree root (merged in by id):
    // it must be counted once. doc-2 is document-only; branch-1 is tree-only.
    const documents = [doc("doc-1"), doc("doc-2")];
    const treeData = tree([docNodeWithBranchChild("doc-1", "branch-1")]);

    // Roots: doc-1 (tree node, merges the document) + doc-2 (document-only) = 2.
    expect(countTableViewRows({ ...baseInput, documents, treeData })).toBe(2);
  });

  test("counts branch/session tree roots that have no backing document", () => {
    const documents = [doc("doc-1")];
    const treeData = tree([branchNode("branch-1"), branchNode("branch-2")]);

    // doc-1 + branch-1 + branch-2 = 3 roots.
    expect(countTableViewRows({ ...baseInput, documents, treeData })).toBe(3);
  });
});

// ---- Filters apply across the full set ----

describe("countTableViewRows — filters apply to the FULL merged set", () => {
  test("search text narrows the count across documents and branches", () => {
    const documents = [doc("alpha"), doc("beta")];
    const treeData = tree([branchNode("alpha-branch"), branchNode("zeta")]);

    // "alpha" matches the doc "alpha" and the branch "alpha-branch" = 2.
    expect(
      countTableViewRows({
        ...baseInput,
        documents,
        treeData,
        filterText: "alpha",
      })
    ).toBe(2);
  });
});

// ---- Paging: honest total, correct slice, nesting preserved ----

describe("pageTableView — honest total + correct paged slice", () => {
  test("total is the full root count while the slice is bounded by page size", () => {
    const documents = Array.from({ length: 5 }, (_u, i) => doc(`doc-${i}`));
    const result = pageTableView({
      ...baseInput,
      documents,
      treeData: null,
      page: 0,
      pageSize: 2,
    });

    expect(result.total).toBe(5);
    // Page 0 of size 2 → first two documents only.
    expect(result.pagedDocuments.map((d) => d.id)).toEqual(["doc-0", "doc-1"]);
  });

  test("later page slices the correct window", () => {
    const documents = Array.from({ length: 5 }, (_u, i) => doc(`doc-${i}`));
    const result = pageTableView({
      ...baseInput,
      documents,
      treeData: null,
      page: 2,
      pageSize: 2,
    });

    expect(result.total).toBe(5);
    expect(result.pagedDocuments.map((d) => d.id)).toEqual(["doc-4"]);
  });

  test("a paged tree root carries its nested children (nesting not broken by paging)", () => {
    const documents = [doc("doc-1")];
    const treeData = tree([docNodeWithBranchChild("doc-1", "branch-1")]);
    const result = pageTableView({
      ...baseInput,
      documents,
      treeData,
      page: 0,
      pageSize: 10,
    });

    // The paged tree keeps the whole node (root + nested branch child), so the
    // downstream grouping still nests branch-1 under doc-1.
    expect(result.pagedTreeData?.nodes).toHaveLength(1);
    expect(result.pagedTreeData?.nodes[0].children.map((c) => c.id)).toEqual([
      "branch-1",
    ]);
    // doc-1 (the node's backing document) rides along so it resolves by id.
    expect(result.pagedDocuments.map((d) => d.id)).toContain("doc-1");
  });

  test("a tree root that pages out is excluded from the page's tree subset", () => {
    // Two branch-only roots, page size 1 → only the first survives page 0.
    const treeData = tree([branchNode("branch-1"), branchNode("branch-2")]);
    const result = pageTableView({
      ...baseInput,
      documents: [],
      treeData,
      page: 0,
      pageSize: 1,
    });

    expect(result.total).toBe(2);
    expect(result.pagedTreeData?.nodes.map((n) => n.root.id)).toEqual([
      "branch-1",
    ]);
  });

  test("no double-count: an entity in both streams is one root and one paged document", () => {
    const documents = [doc("doc-1"), doc("doc-2")];
    const treeData = tree([docNodeWithBranchChild("doc-1", "branch-1")]);
    const result = pageTableView({
      ...baseInput,
      documents,
      treeData,
      page: 0,
      pageSize: 10,
    });

    expect(result.total).toBe(2);
    // doc-1 appears exactly once in the paged documents even though it is both a
    // tree node root and an assigned document.
    const doc1Count = result.pagedDocuments.filter(
      (d) => d.id === "doc-1"
    ).length;
    expect(doc1Count).toBe(1);
  });
});

// ---- Grouping reaches the paginator (page membership follows grouped order) ----

describe("pageTableView — grouped order drives page membership", () => {
  test("groupBy=Status slices the page in section order, not input/sort order", () => {
    // Two documents, input order [approved, draft]. With no grouping the sort
    // is null so input order is preserved; with groupBy=Status the Draft
    // section sorts before the Approved section (STATUS_DISPLAY_ORDER), so a
    // page of size 1 must contain the DRAFT doc, not the first input doc.
    const documents = [
      doc("approved-doc", "p1", DocumentStatus.Approved),
      doc("draft-doc", "p1", DocumentStatus.Draft),
    ];

    const ungrouped = pageTableView({
      ...baseInput,
      documents,
      treeData: null,
      page: 0,
      pageSize: 1,
    });
    // Ungrouped, sort null → input order → the first input doc is on page 0.
    expect(ungrouped.pagedDocuments.map((d) => d.id)).toEqual(["approved-doc"]);

    const grouped = pageTableView({
      ...baseInput,
      groupBy: GroupByMode.Status,
      documents,
      treeData: null,
      page: 0,
      pageSize: 1,
    });
    // Grouped by status → Draft section first → the DRAFT doc is on page 0.
    expect(grouped.pagedDocuments.map((d) => d.id)).toEqual(["draft-doc"]);
  });

  test("grouped pages are disjoint and cover every root exactly once", () => {
    const documents = [
      doc("approved-doc", "p1", DocumentStatus.Approved),
      doc("draft-doc", "p1", DocumentStatus.Draft),
      doc("obsolete-doc", "p1", DocumentStatus.Obsolete),
    ];
    const grouped = { ...baseInput, groupBy: GroupByMode.Status };

    const page0 = pageTableView({
      ...grouped,
      documents,
      treeData: null,
      page: 0,
      pageSize: 2,
    });
    const page1 = pageTableView({
      ...grouped,
      documents,
      treeData: null,
      page: 1,
      pageSize: 2,
    });

    const ids0 = new Set(page0.pagedDocuments.map((d) => d.id));
    const ids1 = new Set(page1.pagedDocuments.map((d) => d.id));
    // Grouped section order is Draft → Approved → Obsolete, so with page size 2
    // the Draft+Approved roots ride on page 0 and the Obsolete root on page 1.
    // (Membership, not intra-page order — `DocumentsView` re-groups the handed
    // subset, so the order within `pagedDocuments` is re-derived downstream; the
    // paginator's contract is which roots land on which page.)
    expect(ids0).toEqual(new Set(["draft-doc", "approved-doc"]));
    expect(ids1).toEqual(new Set(["obsolete-doc"]));
    // Disjoint, and the union is every root exactly once.
    expect([...ids0].filter((id) => ids1.has(id))).toEqual([]);
    expect(new Set([...ids0, ...ids1]).size).toBe(3);
  });
});

// ---- Branches tab pages the flat branch rows ----

describe("pageTableView — branches tab", () => {
  test("counts and pages branch rows collected from the tree", () => {
    const treeData = tree([
      branchNode("branch-1"),
      docNodeWithBranchChild("doc-1", "branch-2"),
    ]);
    const result = pageTableView({
      ...baseInput,
      filterCategory: "branches",
      documents: [doc("doc-1")],
      treeData,
      page: 0,
      pageSize: 10,
    });

    // Two branch rows: the branch root and the nested branch child.
    expect(result.total).toBe(2);
    expect(result.pagedDocuments).toEqual([]);
  });

  test("dedupes a branch that is both a tree root and another node's child", () => {
    // branch-1 appears as its own root AND nested under doc-1 — count once.
    const treeData = tree([
      branchNode("branch-1"),
      docNodeWithBranchChild("doc-1", "branch-1"),
    ]);
    const result = pageTableView({
      ...baseInput,
      filterCategory: "branches",
      documents: [doc("doc-1")],
      treeData,
      page: 0,
      pageSize: 10,
    });

    expect(result.total).toBe(1);
  });

  test("prunes a node's branch children to the current page's slice", () => {
    // One node carrying three branch children, page size 2: page 0 must expose
    // only the first two branch children, not all three.
    const node: TreeNode = {
      root: {
        id: "doc-1",
        type: ArtifactType.Document,
        name: "doc-1",
        status: DocumentStatus.Draft,
        updatedAt: "2026-07-01T00:00:00.000Z",
      } as unknown as TreeNode["root"],
      children: ["b-1", "b-2", "b-3"].map(
        (id) =>
          ({
            id,
            type: ArtifactType.Branch,
            name: id,
            status: "OPEN",
            updatedAt: "2026-07-01T00:00:00.000Z",
            linkType: LinkType.Produces,
            depth: 1,
            parentId: "doc-1",
          }) as unknown as TreeChild
      ),
    };
    const result = pageTableView({
      ...baseInput,
      filterCategory: "branches",
      documents: [],
      treeData: tree([node]),
      page: 0,
      pageSize: 2,
    });

    expect(result.total).toBe(3);
    const paged = result.pagedTreeData?.nodes[0]?.children.map((c) => c.id);
    expect(paged).toEqual(["b-1", "b-2"]);
  });

  // wongk: the Branches tab renders `[node.root, ...node.children]` flat, so a
  // node kept only to carry a paged CHILD also renders its root. Split a branch
  // root from its branch child across two pages and every page must hold
  // exactly its own slice.
  test("does not repeat a branch root on the page that holds only its child", () => {
    const treeData = tree([branchRootWithBranchChild("branch-a", "branch-b")]);
    const pageOf = (page: number) =>
      pageTableView({
        ...baseInput,
        filterCategory: "branches",
        documents: [],
        treeData,
        page,
        pageSize: 1,
      });

    const first = pageOf(0);
    const second = pageOf(1);

    expect(first.total).toBe(2);
    expect(renderedBranchIds(first.pagedTreeData)).toEqual(["branch-a"]);
    // Before the fix this was ["branch-a", "branch-b"]: two rows on a one-row
    // page, with branch-a repeated from page 1.
    expect(renderedBranchIds(second.pagedTreeData)).toEqual(["branch-b"]);
  });

  test("keeps a branch nested when its root is on the same page", () => {
    const treeData = tree([branchRootWithBranchChild("branch-a", "branch-b")]);
    const result = pageTableView({
      ...baseInput,
      filterCategory: "branches",
      documents: [],
      treeData,
      page: 0,
      pageSize: 10,
    });

    expect(result.pagedTreeData?.nodes).toHaveLength(1);
    expect(renderedBranchIds(result.pagedTreeData)).toEqual([
      "branch-a",
      "branch-b",
    ]);
  });

  test("emits a branch once when it is both a node root and another node's child", () => {
    const treeData = tree([
      branchNode("branch-b"),
      branchRootWithBranchChild("branch-a", "branch-b"),
    ]);
    const result = pageTableView({
      ...baseInput,
      filterCategory: "branches",
      documents: [],
      treeData,
      page: 1,
      pageSize: 1,
    });

    // Page 2 holds branch-a only; branch-b must not be promoted back onto it
    // just because branch-a's node carried a copy of it.
    expect(result.total).toBe(2);
    expect(renderedBranchIds(result.pagedTreeData)).toEqual(["branch-a"]);
  });
});
