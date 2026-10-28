import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type {
  ProjectTreeResponse,
  TreeChild,
  TreeNode,
} from "@repo/api/src/types/project-tree";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import { makeTreeArtifact } from "@repo/app/documents/lib/__tests__/tree-fixtures";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { buildDocumentGridGroups } from "@repo/app/documents/lib/documents-grid-groups";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { STORED_SESSION_STATUS_ROW_OPTIONS } from "@repo/app/documents/lib/row-artifact-status";
import {
  buildSortedGroups,
  DEFAULT_TABLE_VIEW_ORDERING,
  rootFirstTableViewOrdering,
  type TableViewOrdering,
} from "@repo/app/documents/lib/table-view-pipeline";
import { describe, expect, test } from "vitest";
import {
  buildTableViewPagePlan,
  countTableViewRows,
  pageTableView,
} from "../table-view-pagination";

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

  test("the paged tree keeps flat parent context for the roots on the page (whitlockk, PR #6745)", () => {
    // `pagedTreeData` is the tree the table actually renders its Parent column
    // from, so dropping `flatParents` in the slice would empty that column on
    // every paged read no matter what the server sent. Narrowed to this page's
    // roots for the same contract reason `externalParents` is.
    const treeData: ProjectTreeResponse = {
      ...tree([branchNode("branch-1"), branchNode("branch-2")]),
      flatParents: [
        {
          childId: "branch-1",
          parent: makeTreeArtifact("plan-1", ArtifactType.Document),
          linkType: LinkType.Produces,
        },
        {
          childId: "branch-2",
          parent: makeTreeArtifact("plan-2", ArtifactType.Document),
          linkType: LinkType.Produces,
        },
      ],
    };

    const result = pageTableView({
      ...baseInput,
      documents: [],
      treeData,
      page: 0,
      pageSize: 1,
    });

    expect(result.pagedTreeData?.nodes.map((n) => n.root.id)).toEqual([
      "branch-1",
    ]);
    expect(result.pagedTreeData?.flatParents?.map((e) => e.childId)).toEqual([
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

  // whitlockk: the Branches tab renders `[node.root, ...node.children]` flat, so a
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

/**
 * A grouped board whose sections straddle a page boundary. Sizes are pinned to
 * literals here rather than derived from PAGE_PLAN_SIZE, so a change to the
 * page size cannot silently re-satisfy the expectations below.
 *
 * Sections render in `STATUS_DISPLAY_ORDER`: Draft, then In Review, then
 * Approved.
 */
const PAGE_PLAN_SIZE = 10;

function statusDocs(
  status: string,
  prefix: string,
  count: number
): DocumentRowData[] {
  return Array.from({ length: count }, (_u, i) =>
    doc(`${prefix}-${i}`, "p1", status)
  );
}

function groupedStatusBoard(): DocumentRowData[] {
  return [
    ...statusDocs(DocumentStatus.Draft, "draft", 6),
    ...statusDocs(DocumentStatus.InReview, "review", 7),
    ...statusDocs(DocumentStatus.Approved, "approved", 25),
  ];
}

function groupedStatusPlan() {
  return buildTableViewPagePlan(
    {
      ...baseInput,
      documents: groupedStatusBoard(),
      treeData: null,
      groupBy: GroupByMode.Status,
    },
    PAGE_PLAN_SIZE
  );
}

describe("buildTableViewPagePlan — sections stay whole across page boundaries", () => {
  test("a section that would straddle the boundary starts a fresh page instead of splitting", () => {
    const plan = groupedStatusPlan();

    // Draft(6) then In Review(7): 13 > 10, so In Review does NOT share page 0.
    // Fixed 10-row slicing would have put review-0..review-3 under a repeated
    // "In Review" header at the foot of page 0.
    expect(plan?.pages[0]?.ids).toEqual([
      "draft-0",
      "draft-1",
      "draft-2",
      "draft-3",
      "draft-4",
      "draft-5",
    ]);
    expect(plan?.pages[1]?.ids).toEqual([
      "review-0",
      "review-1",
      "review-2",
      "review-3",
      "review-4",
      "review-5",
      "review-6",
    ]);
  });

  test("only a section larger than one page splits, and its spill pages say so", () => {
    const plan = groupedStatusPlan();

    // Approved(25) cannot fit a 10-row page, so it is the one section allowed
    // to split: 10 / 10 / 5 starting on its own page.
    expect(plan?.pages.map((page) => page.ids.length)).toEqual([
      6, 7, 10, 10, 5,
    ]);
    expect([...(plan?.pages[2]?.continuedSectionKeys ?? [])]).toEqual([]);
    expect([...(plan?.pages[3]?.continuedSectionKeys ?? [])]).toEqual([
      DocumentStatus.Approved,
    ]);
    expect([...(plan?.pages[4]?.continuedSectionKeys ?? [])]).toEqual([
      DocumentStatus.Approved,
    ]);
  });

  test("every row lands on exactly one page — nothing is dropped or repeated", () => {
    const plan = groupedStatusPlan();
    const placed = (plan?.pages ?? []).flatMap((page) => page.ids);

    expect(placed).toHaveLength(38);
    expect(new Set(placed).size).toBe(38);
    expect(new Set(placed)).toEqual(
      new Set(groupedStatusBoard().map((d) => d.id))
    );
  });

  test("sectionTotals are the FULL-list per-status counts, not any page's slice", () => {
    const plan = groupedStatusPlan();

    expect(plan?.sectionTotals.get(DocumentStatus.Draft)).toBe(6);
    expect(plan?.sectionTotals.get(DocumentStatus.InReview)).toBe(7);
    // The page slices of Approved are 10, 10 and 5 — none of them is 25.
    expect(plan?.sectionTotals.get(DocumentStatus.Approved)).toBe(25);
  });

  test("an ungrouped board has no plan, so it keeps fixed pageSize slicing", () => {
    expect(
      buildTableViewPagePlan(
        {
          ...baseInput,
          documents: groupedStatusBoard(),
          treeData: null,
          groupBy: GroupByMode.None,
        },
        PAGE_PLAN_SIZE
      )
    ).toBeNull();
  });

  test("floors a non-positive page size at 1 instead of looping on an unplaceable section", () => {
    const plan = buildTableViewPagePlan(
      {
        ...baseInput,
        documents: statusDocs(DocumentStatus.Draft, "draft", 3),
        treeData: null,
        groupBy: GroupByMode.Status,
      },
      0
    );

    expect(plan?.pages.map((page) => page.ids)).toEqual([
      ["draft-0"],
      ["draft-1"],
      ["draft-2"],
    ]);
  });

  test("an empty board plans no pages and claims no section population", () => {
    const plan = buildTableViewPagePlan(
      {
        ...baseInput,
        documents: [],
        treeData: null,
        groupBy: GroupByMode.Status,
      },
      PAGE_PLAN_SIZE
    );

    expect(plan?.pages).toEqual([]);
    expect(plan?.sectionTotals.size).toBe(0);
  });
});

describe("pageTableView — explicit plan membership", () => {
  test("renders exactly the plan's page, not the fixed slice at that index", () => {
    const result = pageTableView({
      ...baseInput,
      documents: groupedStatusBoard(),
      treeData: null,
      groupBy: GroupByMode.Status,
      page: 1,
      pageSize: PAGE_PLAN_SIZE,
      pageIds: groupedStatusPlan()?.pages[1]?.ids,
    });

    // The whole In Review section — seven rows on a ten-row page.
    expect(result.pagedDocuments.map((d) => d.id)).toEqual([
      "review-0",
      "review-1",
      "review-2",
      "review-3",
      "review-4",
      "review-5",
      "review-6",
    ]);
    expect(result.total).toBe(38);
  });
});

/**
 * ISS-9437 — the paginator and the view must partition ONE ordered corpus.
 *
 * The paginator decides page membership by running this pipeline; `DocumentsView`
 * then re-runs `buildSortedGroups` over the subset it is handed. If the two
 * resolve different orderings, a row lands on no page or on two, and nothing in
 * either module notices. These cases page the corpus, re-sort each page the way
 * the view does, concatenate, and compare against a SEPARATELY-DERIVED oracle —
 * a literal, not a value re-derived by the code under test.
 */
const ROOT_FIRST_ORDERING = rootFirstTableViewOrdering(
  STORED_SESSION_STATUS_ROW_OPTIONS
);
const PARTITION_PAGE_SIZE = 2;

/**
 * Five documents spanning four roots, plus a branch tree root whose `OPEN`
 * status is a raw-rank MISS inside a band that also holds a ranked row — so the
 * corpus exercises both comparator levels and has no tie at either.
 */
function partitionDocuments(): DocumentRowData[] {
  return [
    doc("d-garbage", "p1", "GARBAGE"),
    doc("d-executed", "p1", DocumentStatus.Executed),
    doc("d-draft", "p1", DocumentStatus.Draft),
    doc("d-approved", "p1", DocumentStatus.Approved),
    doc("d-review", "p1", DocumentStatus.InReview),
  ];
}

/**
 * Hand-derived from the fixture, not read back out of the pipeline:
 * in_progress (DRAFT) → in_review (IN_REVIEW ranked, then the unranked branch)
 * → done (APPROVED before EXECUTED) → unknown (GARBAGE).
 */
const PARTITION_ORACLE = [
  "d-draft",
  "d-review",
  "branch-open",
  "d-approved",
  "d-executed",
  "d-garbage",
];

const partitionInput = {
  ...baseInput,
  documents: partitionDocuments(),
  treeData: tree([branchNode("branch-open")]),
  sortBy: SortKey.Status,
  sortDir: "asc" as const,
};

describe("ISS-9437 partition proof — ungrouped, root-first", () => {
  test("the pages concatenate to the full ordered corpus", () => {
    expect(concatenatePages(ROOT_FIRST_ORDERING, ROOT_FIRST_ORDERING)).toEqual(
      PARTITION_ORACLE
    );
  });

  test("detects a paginator and a view that resolved DIFFERENT orderings", () => {
    // Page membership sliced root-first, each page then re-sorted by today's
    // raw rank. The rows are all still reachable, so a set comparison would pass;
    // the ORDER is what breaks, and the oracle is what sees it.
    const mismatched = concatenatePages(
      ROOT_FIRST_ORDERING,
      DEFAULT_TABLE_VIEW_ORDERING
    );
    expect([...mismatched].sort()).toEqual([...PARTITION_ORACLE].sort());
    expect(mismatched).not.toEqual(PARTITION_ORACLE);
  });

  test("flag OFF partitions the corpus in today's order, not the oracle's", () => {
    const off = concatenatePages(
      DEFAULT_TABLE_VIEW_ORDERING,
      DEFAULT_TABLE_VIEW_ORDERING
    );
    expect([...off].sort()).toEqual([...PARTITION_ORACLE].sort());
    expect(off).not.toEqual(PARTITION_ORACLE);
  });
});

describe("ISS-9437 partition proof — grouped, through the section-aware plan", () => {
  test("the planned pages concatenate to the full ordered corpus", () => {
    const input = {
      ...partitionInput,
      groupBy: GroupByMode.Status,
      ordering: ROOT_FIRST_ORDERING,
    };
    const plan = buildTableViewPagePlan(input, PARTITION_PAGE_SIZE);
    expect(plan).not.toBeNull();

    const rendered = (plan?.pages ?? []).flatMap((planPage) => {
      const page = pageTableView({
        ...input,
        page: 0,
        pageSize: PARTITION_PAGE_SIZE,
        pageIds: planPage.ids,
      });
      const { groups } = buildSortedGroups({
        treeData: page.pagedTreeData ?? null,
        documents: page.pagedDocuments,
        filterText: input.filterText,
        sortBy: input.sortBy,
        sortDir: input.sortDir,
        ordering: ROOT_FIRST_ORDERING,
      });
      return buildDocumentGridGroups({
        groupBy: GroupByMode.Status,
        isGroupedView: true,
        groups,
        flatItems: [],
        groupOptions: ROOT_FIRST_ORDERING.groupOptions,
      }).flatMap((section) => section.items.map((item) => item.data.id));
    });

    expect(rendered).toEqual(PARTITION_ORACLE);
  });
});

/**
 * Page the corpus with `pagingOrdering`, then re-sort each page with
 * `viewOrdering` exactly as `DocumentsView` does, and concatenate. Passing two
 * different orderings is how the divergence case is expressed.
 */
function concatenatePages(
  pagingOrdering: TableViewOrdering,
  viewOrdering: TableViewOrdering
): string[] {
  const input = { ...partitionInput, ordering: pagingOrdering };
  const total = countTableViewRows(input);
  const pages = Math.ceil(total / PARTITION_PAGE_SIZE);
  const rendered: string[] = [];
  for (let page = 0; page < pages; page++) {
    const slice = pageTableView({
      ...input,
      page,
      pageSize: PARTITION_PAGE_SIZE,
    });
    const { groups } = buildSortedGroups({
      treeData: slice.pagedTreeData ?? null,
      documents: slice.pagedDocuments,
      filterText: input.filterText,
      sortBy: input.sortBy,
      sortDir: input.sortDir,
      ordering: viewOrdering,
    });
    rendered.push(...groups.map((group) => group.groupKey));
  }
  return rendered;
}
