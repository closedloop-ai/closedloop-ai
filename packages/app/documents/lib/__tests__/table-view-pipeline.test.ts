import {
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  DOCUMENT_ROUTE_PREFIX,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import {
  asChild,
  makeTreeArtifact,
} from "@repo/app/documents/lib/__tests__/tree-fixtures";
import {
  buildDocumentGridGroups,
  type DocumentGridGroup,
  documentTreeRoots,
} from "@repo/app/documents/lib/documents-grid-groups";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  buildCollapseVisibleItems,
  buildFlatItems,
  buildParentMap,
  buildRenderedItems,
  buildSortedGroups,
  filterByCategory,
  resolveTreeData,
  treeHasRenderableArtifacts,
} from "@repo/app/documents/lib/table-view-pipeline";
import {
  createMockDocument,
  makeArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, it } from "vitest";

function makeTree(nodes: ProjectTreeResponse["nodes"]): ProjectTreeResponse {
  return { nodes, externalParents: [] };
}

describe("filterByCategory", () => {
  it("returns no documents for the branches category (rows come from the tree)", () => {
    const docs = [createMockDocument({ id: "d1", title: "PRD one" })];
    expect(filterByCategory(docs, "branches", "")).toEqual([]);
  });

  it("text-filters documents in the all category", () => {
    const match = createMockDocument({ id: "d1", title: "Login flow" });
    const miss = createMockDocument({ id: "d2", title: "Billing" });
    expect(filterByCategory([match, miss], "all", "login")).toEqual([match]);
  });
});

describe("buildSortedGroups — SortKey.Updated comparator (FEA-4140)", () => {
  // The Updated column is exposed as sortable, so SortKey.Updated must resolve
  // to a real updatedAt comparator instead of leaving rows in API order while
  // showing an active sort indicator (a UI that lies about its state).
  const older = createMockDocument({
    id: "older",
    title: "Older doc",
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  });
  const newer = createMockDocument({
    id: "newer",
    title: "Newer doc",
    updatedAt: new Date("2024-06-01T00:00:00Z"),
  });

  it("orders ascending by updatedAt (oldest first)", () => {
    const { groups } = buildSortedGroups({
      treeData: null,
      // API order deliberately newest-first so a no-op comparator would fail.
      documents: [newer, older],
      sortBy: SortKey.Updated,
      sortDir: "asc",
    });
    expect(groups.map((g) => g.groupKey)).toEqual(["older", "newer"]);
  });

  it("orders descending by updatedAt (newest first)", () => {
    const { groups } = buildSortedGroups({
      treeData: null,
      documents: [older, newer],
      sortBy: SortKey.Updated,
      sortDir: "desc",
    });
    expect(groups.map((g) => g.groupKey)).toEqual(["newer", "older"]);
  });
});

describe("buildSortedGroups — text filter on tree-sourced artifact rows (PLN-874 Phase 3)", () => {
  const doc = createMockDocument({
    id: "doc-1",
    slug: "PRD-1",
    title: "Login flow",
  });
  const branchRoot = makeTreeArtifact("br-root", ArtifactType.Branch);
  const sessionRoot = makeTreeArtifact("ses-root", ArtifactType.Session);
  const treeData = makeTree([
    { root: makeTreeArtifact("doc-1", ArtifactType.Document), children: [] },
    { root: branchRoot, children: [] },
    { root: sessionRoot, children: [] },
  ]);

  it("drops non-document roots that do not match the search text", () => {
    const { groups } = buildSortedGroups({
      treeData,
      documents: [doc],
      filterText: "login",
      sortBy: null,
      sortDir: "asc",
    });
    expect(groups.map((g) => g.groupKey)).toEqual(["doc-1"]);
  });

  it("keeps non-document roots whose name matches the search text", () => {
    const { groups } = buildSortedGroups({
      treeData,
      documents: [],
      filterText: "artifact br-root",
      sortBy: null,
      sortDir: "asc",
    });
    expect(groups.map((g) => g.groupKey)).toEqual(["br-root"]);
  });

  it("does not re-check documents against the title-only text predicate", () => {
    // matchesFilter upstream can match by slug, so a document whose TITLE
    // does not contain the text must still pass through buildSortedGroups.
    const slugMatched = createMockDocument({
      id: "doc-1",
      slug: "PRD-1",
      title: "Completely different title",
    });
    const { groups } = buildSortedGroups({
      treeData,
      documents: [slugMatched],
      filterText: "prd-1",
      sortBy: null,
      sortDir: "asc",
    });
    expect(groups.map((g) => g.groupKey)).toContain("doc-1");
  });

  it("keeps branch children riding under a matching document root", () => {
    const branchChild = makeTreeArtifact("br-child", ArtifactType.Branch);
    const tree = makeTree([
      {
        root: makeTreeArtifact("doc-1", ArtifactType.Document),
        children: [asChild(branchChild, "doc-1")],
      },
    ]);
    const { groups } = buildSortedGroups({
      treeData: tree,
      documents: [doc],
      filterText: "login",
      sortBy: null,
      sortDir: "asc",
    });
    expect(groups).toHaveLength(1);
    // Matching root preserves its whole subtree (by-design context behavior).
    expect(groups[0].children.map((c) => c.data.id)).toEqual(["br-child"]);
  });

  it("keeps a search-matching branch under a non-matching document ancestor", () => {
    // Regression (PLN-874 Phase 3): the tree is built from the FULL document
    // set, so a branch whose name matches the search stays reachable even
    // when its parent document's title/slug does not match. The ancestor is
    // retained as context and force-expanded.
    const matchingBranch = makeTreeArtifact("br-deploy", ArtifactType.Branch);
    const tree = makeTree([
      {
        root: makeTreeArtifact("doc-1", ArtifactType.Document),
        children: [asChild(matchingBranch, "doc-1")],
      },
    ]);
    const nonMatchingDoc = createMockDocument({
      id: "doc-1",
      slug: "PRD-9",
      title: "Billing rework",
    });
    const { groups, contextExpandedIds } = buildSortedGroups({
      treeData: tree,
      documents: [nonMatchingDoc],
      filterText: "br-deploy",
      sortBy: null,
      sortDir: "asc",
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].groupKey).toBe("doc-1");
    expect(groups[0].children.map((c) => c.data.id)).toEqual(["br-deploy"]);
    expect(contextExpandedIds.has("doc-1")).toBe(true);
  });

  it("applies no tree filtering when there is no text and no project filter", () => {
    const { groups } = buildSortedGroups({
      treeData,
      documents: [doc],
      filterText: "",
      sortBy: null,
      sortDir: "asc",
    });
    expect(groups.map((g) => g.groupKey)).toEqual([
      "doc-1",
      "br-root",
      "ses-root",
    ]);
  });
});

describe("treeHasRenderableArtifacts", () => {
  it("is true when a branch or session exists as root or child", () => {
    expect(
      treeHasRenderableArtifacts(
        makeTree([
          {
            root: makeTreeArtifact("br-1", ArtifactType.Branch),
            children: [],
          },
        ])
      )
    ).toBe(true);
    expect(
      treeHasRenderableArtifacts(
        makeTree([
          {
            root: makeTreeArtifact("doc-1", ArtifactType.Document),
            children: [
              asChild(makeTreeArtifact("ses-1", ArtifactType.Session), "doc-1"),
            ],
          },
        ])
      )
    ).toBe(true);
  });

  it("is false for document-only trees, deployment-only trees, and missing trees", () => {
    expect(
      treeHasRenderableArtifacts(
        makeTree([
          {
            root: makeTreeArtifact("doc-1", ArtifactType.Document),
            children: [],
          },
        ])
      )
    ).toBe(false);
    // Deployments are excluded from this table by product decision (Task 0.3).
    expect(
      treeHasRenderableArtifacts(
        makeTree([
          {
            root: makeTreeArtifact("dep-1", ArtifactType.Deployment),
            children: [],
          },
        ])
      )
    ).toBe(false);
    expect(treeHasRenderableArtifacts(null)).toBe(false);
    expect(treeHasRenderableArtifacts(undefined)).toBe(false);
  });
});

describe("buildCollapseVisibleItems — excludes collapsed-section rows (reviewer)", () => {
  function docItem(id: string): DocumentRowItem {
    return { kind: "document", data: makeArtifact({ id }) };
  }

  function section(key: string, ids: string[]): DocumentGridGroup {
    return {
      descriptor: { key, label: key, mode: GroupByMode.Status },
      key,
      label: key,
      items: ids.map(docItem),
    };
  }

  const OPEN = section("open", ["a", "b"]);
  const CLOSED = section("closed", ["urgent-row"]);
  const ARGS = {
    groupBy: GroupByMode.Status,
    gridGroups: [OPEN, CLOSED],
    isGroupedView: false,
    flatItems: [],
    groups: [],
    isGroupExpanded: () => true,
  };

  it("drops rows inside a collapsed section", () => {
    const items = buildCollapseVisibleItems({
      ...ARGS,
      isSectionExpanded: (key) => key === "open",
    });
    expect(items.map((i) => i.data.id)).toEqual(["a", "b"]);
  });

  it("includes rows once the section is expanded", () => {
    const items = buildCollapseVisibleItems({
      ...ARGS,
      isSectionExpanded: () => true,
    });
    expect(items.map((i) => i.data.id)).toEqual(["a", "b", "urgent-row"]);
  });
});

describe("table view pipeline branch behavior", () => {
  it("filters every document category after applying text matching", () => {
    const prd = makeArtifact({
      id: "prd",
      type: DocumentType.Prd,
      title: "Matching PRD",
    });
    const feature = makeArtifact({
      id: "feature",
      type: DocumentType.Feature,
      title: "Matching issue",
    });
    const plan = makeArtifact({
      id: "plan",
      type: DocumentType.ImplementationPlan,
      title: "Matching plan",
    });

    expect(
      filterByCategory([prd, feature, plan], "documents", "matching")
    ).toEqual([prd]);
    expect(
      filterByCategory([prd, feature, plan], "features", "matching")
    ).toEqual([feature]);
    expect(filterByCategory([prd, feature, plan], "plans", "matching")).toEqual(
      [plan]
    );
  });

  it("builds internal and external parent links without overwriting a child", () => {
    const root = {
      ...makeTreeArtifact("root", ArtifactType.Document),
      subtype: ArtifactSubtype.Prd,
    };
    const child = asChild(
      {
        ...makeTreeArtifact("child", ArtifactType.Document),
        subtype: ArtifactSubtype.Prd,
      },
      "root"
    );
    const externalParent = {
      ...makeTreeArtifact("external", ArtifactType.Document),
      subtype: ArtifactSubtype.Prd,
    };
    const nonDocumentParent = makeTreeArtifact("branch", ArtifactType.Branch);
    const map = buildParentMap(
      {
        nodes: [{ root, children: [child] }],
        externalParents: [
          {
            childId: "child",
            parent: externalParent,
            linkType: LinkType.Blocks,
          },
          {
            childId: "orphan",
            parent: externalParent,
            linkType: LinkType.Blocks,
          },
          {
            childId: "ignored",
            parent: nonDocumentParent,
            linkType: LinkType.Blocks,
          },
        ],
      },
      "acme"
    );

    expect(map.get("child")?.title).toBe("Artifact root");
    expect(map.get("orphan")).toEqual({
      title: "Artifact external",
      href: `/acme/${DOCUMENT_ROUTE_PREFIX}/EXTERNAL`,
    });
    expect(map.has("ignored")).toBe(false);
    expect(buildParentMap(null, "acme").size).toBe(0);
  });

  it("resolves a flat node's parent from `flatParents` (whitlockk, PR #6745)", () => {
    // A category read returns every match as a root, so this row sits in no
    // `children` array and carries no `parentId` — the two things the walk
    // above resolves a parent from. Without reading `flatParents`, its Parent
    // cell is blank, and a tab where every cell is blank drops the column.
    const promoted = {
      ...makeTreeArtifact("promoted", ArtifactType.Document),
      subtype: ArtifactSubtype.Prd,
    };
    const parent = {
      ...makeTreeArtifact("parent", ArtifactType.Document),
      subtype: ArtifactSubtype.Prd,
    };
    // A non-document parent has no route, so the walk records its title with a
    // null href rather than dropping the row's only parent statement.
    const branchParent = makeTreeArtifact("branch", ArtifactType.Branch);

    const map = buildParentMap(
      {
        nodes: [
          { root: promoted, children: [] },
          {
            root: makeTreeArtifact("under-branch", ArtifactType.Document),
            children: [],
          },
        ],
        externalParents: [],
        flatParents: [
          { childId: "promoted", parent, linkType: LinkType.Produces },
          {
            childId: "under-branch",
            parent: branchParent,
            linkType: LinkType.Produces,
          },
        ],
      },
      "acme"
    );

    expect(map.get("promoted")).toEqual({
      title: "Artifact parent",
      href: `/acme/${DOCUMENT_ROUTE_PREFIX}/PARENT`,
    });
    expect(map.get("under-branch")).toEqual({
      title: "Artifact branch",
      href: null,
    });
  });

  it("distinguishes fetched and explicitly provided tree states", () => {
    const fetched = makeTree([]);
    expect(resolveTreeData(undefined, true, fetched, true)).toEqual({
      treeData: fetched,
      isLoadingTree: true,
    });
    expect(resolveTreeData(null, undefined, fetched, true)).toEqual({
      treeData: null,
      isLoadingTree: false,
    });
    expect(resolveTreeData(fetched, true, undefined, false)).toEqual({
      treeData: fetched,
      isLoadingTree: true,
    });
  });

  it("sorts document roots by every exposed comparator and respects filters", () => {
    const ada = {
      id: "ada",
      firstName: "Ada",
      lastName: "A",
      email: "a@x",
      avatarUrl: null,
    };
    const zed = {
      id: "zed",
      firstName: "Zed",
      lastName: "Z",
      email: "z@x",
      avatarUrl: null,
    };
    const sortCases = [
      {
        sortBy: SortKey.Title,
        documents: [
          makeArtifact({ id: "title-z", title: "Zulu" }),
          makeArtifact({ id: "title-a", title: "Alpha" }),
        ],
        expectedId: "title-a",
      },
      {
        sortBy: SortKey.Type,
        documents: [
          makeArtifact({
            id: "type-prd",
            title: "Same",
            type: DocumentType.Prd,
          }),
          makeArtifact({
            id: "type-plan",
            title: "Same",
            type: DocumentType.ImplementationPlan,
          }),
        ],
        expectedId: "type-plan",
      },
      {
        sortBy: SortKey.Updated,
        documents: [
          makeArtifact({
            id: "updated-later",
            title: "Same",
            updatedAt: new Date("2026-02-01"),
          }),
          makeArtifact({
            id: "updated-first",
            title: "Same",
            updatedAt: new Date("2026-01-01"),
          }),
        ],
        expectedId: "updated-first",
      },
      {
        sortBy: SortKey.Assignee,
        documents: [
          makeArtifact({ id: "assignee-z", title: "Same", assignee: zed }),
          makeArtifact({ id: "assignee-a", title: "Same", assignee: ada }),
        ],
        expectedId: "assignee-a",
      },
      {
        sortBy: SortKey.Priority,
        documents: [
          makeArtifact({
            id: "priority-low",
            title: "Same",
            priority: Priority.Low,
          }),
          makeArtifact({
            id: "priority-high",
            title: "Same",
            priority: Priority.High,
          }),
        ],
        expectedId: "priority-high",
      },
      {
        sortBy: SortKey.Status,
        documents: [
          makeArtifact({
            id: "status-review",
            title: "Same",
            status: DocumentStatus.InReview,
          }),
          makeArtifact({
            id: "status-draft",
            title: "Same",
            status: DocumentStatus.Draft,
          }),
        ],
        expectedId: "status-draft",
      },
      {
        sortBy: SortKey.Slug,
        documents: [
          makeArtifact({ id: "slug-20", title: "Same", slug: "PRD-20" }),
          makeArtifact({ id: "slug-3", title: "Same", slug: "PRD-3" }),
        ],
        expectedId: "slug-3",
      },
    ];

    for (const { sortBy, documents, expectedId } of sortCases) {
      const { groups } = buildSortedGroups({
        treeData: null,
        documents,
        sortBy,
        sortDir: "asc",
      });
      expect(groups[0].groupKey, sortBy).toBe(expectedId);
    }
    const first = sortCases[0].documents[0];
    const second = sortCases[0].documents[1];
    const filtered = buildSortedGroups({
      treeData: null,
      documents: [first, second],
      applyProjectFilters: (items) =>
        items.filter((item) => item.data.id === "title-z"),
      sortBy: SortKey.Title,
      sortDir: "desc",
    });
    expect(filtered.groups.map((group) => group.groupKey)).toEqual(["title-z"]);
  });

  it("keeps absent priorities last when sorting flat rows both directions", () => {
    const none = documentItem(
      makeArtifact({ id: "priority-none", priority: null })
    );
    const low = documentItem(
      makeArtifact({ id: "priority-low", priority: Priority.Low })
    );
    const urgent = documentItem(
      makeArtifact({ id: "priority-urgent", priority: Priority.Urgent })
    );
    const medium = documentItem(
      makeArtifact({ id: "priority-medium", priority: Priority.Medium })
    );

    expect(
      buildFlatItems(
        [none, low, urgent, medium],
        undefined,
        SortKey.Priority,
        "asc"
      ).map((item) => item.data.id)
    ).toEqual([
      "priority-urgent",
      "priority-medium",
      "priority-low",
      "priority-none",
    ]);
    expect(
      buildFlatItems(
        [none, low, urgent, medium],
        undefined,
        SortKey.Priority,
        "desc"
      ).map((item) => item.data.id)
    ).toEqual([
      "priority-low",
      "priority-medium",
      "priority-urgent",
      "priority-none",
    ]);
  });

  it("sorts and filters flat items or preserves them without a sort", () => {
    const alpha = documentItem(makeArtifact({ id: "alpha", title: "Alpha" }));
    const zulu = documentItem(makeArtifact({ id: "zulu", title: "Zulu" }));
    expect(
      buildFlatItems([zulu, alpha], undefined, SortKey.Title, "asc")
    ).toEqual([alpha, zulu]);
    expect(
      buildFlatItems(
        [zulu, alpha],
        (items) => items.filter((item) => item.data.id === "zulu"),
        null,
        "asc"
      )
    ).toEqual([zulu]);
  });

  it("groups tree roots or flat rows and skips grouping when disabled", () => {
    const root = documentItem(makeArtifact({ id: "root" }));
    const groups = [{ groupKey: "root", root, children: [] }];
    expect(
      buildDocumentGridGroups({
        groupBy: GroupByMode.None,
        isGroupedView: true,
        groups,
        flatItems: [root],
        groupOptions: {},
      })
    ).toEqual([]);
    expect(
      buildDocumentGridGroups({
        groupBy: GroupByMode.Status,
        isGroupedView: true,
        groups,
        flatItems: [root],
        groupOptions: {},
      })[0].items
    ).toEqual([{ ...root, children: [] }]);
    expect(
      buildDocumentGridGroups({
        groupBy: GroupByMode.Status,
        isGroupedView: false,
        groups,
        flatItems: [root],
        groupOptions: {},
      })[0].items
    ).toEqual([root]);
  });

  it("renders grouped, flat, and recursively expanded tree rows", () => {
    const grandchild = documentItem(makeArtifact({ id: "grandchild" }));
    const child = {
      ...documentItem(makeArtifact({ id: "child" })),
      children: [grandchild],
    };
    const root = documentItem(makeArtifact({ id: "root" }));
    const groups = [{ groupKey: "root", root, children: [child] }];
    const sections: DocumentGridGroup[] = [
      {
        descriptor: { key: "draft", label: "Draft", mode: GroupByMode.Status },
        key: "draft",
        label: "Draft",
        items: documentTreeRoots(groups),
      },
    ];
    const expanded = (key: string) => key !== "closed";

    expect(
      buildRenderedItems({
        groupBy: GroupByMode.Status,
        gridGroups: sections,
        isGroupedView: true,
        flatItems: [],
        groups: [],
        isGroupExpanded: expanded,
      }).map((item) => item.data.id)
    ).toEqual(["root", "child", "grandchild"]);
    expect(
      buildRenderedItems({
        groupBy: GroupByMode.None,
        gridGroups: [],
        isGroupedView: false,
        flatItems: [root],
        groups,
        isGroupExpanded: expanded,
      })
    ).toEqual([root]);
    expect(
      buildRenderedItems({
        groupBy: GroupByMode.None,
        gridGroups: [],
        isGroupedView: true,
        flatItems: [],
        groups,
        isGroupExpanded: () => false,
      })
    ).toEqual([{ ...root, children: [child] }]);
  });
});

function documentItem(data: ReturnType<typeof makeArtifact>): DocumentRowItem {
  return { kind: "document", data };
}

describe("native parent destinations", () => {
  it("uses the host path builder for flat, nested, and external parents", () => {
    const parent = {
      ...makeTreeArtifact("parent", ArtifactType.Document),
      subtype: ArtifactSubtype.Prd,
    };
    const child = asChild(
      makeTreeArtifact("child", ArtifactType.Document),
      "parent"
    );
    const tree = {
      nodes: [{ root: parent, children: [child] }],
      externalParents: [
        { childId: "external-child", parent, linkType: LinkType.Produces },
      ],
      flatParents: [
        { childId: "flat-child", parent, linkType: LinkType.Produces },
      ],
    };
    const native = buildParentMap(tree, (path) => path);
    const web = buildParentMap(tree, (path) => `/acme${path}`);
    for (const childId of ["child", "external-child", "flat-child"]) {
      expect(native.get(childId)?.href).toBe(
        `/${DOCUMENT_ROUTE_PREFIX}/PARENT`
      );
      expect(web.get(childId)?.href).toBe(
        `/acme/${DOCUMENT_ROUTE_PREFIX}/PARENT`
      );
    }
  });
});
