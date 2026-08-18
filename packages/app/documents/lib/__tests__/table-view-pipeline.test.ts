import { ArtifactType } from "@repo/api/src/types/artifact";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import {
  asChild,
  makeTreeArtifact,
} from "@repo/app/documents/lib/__tests__/tree-fixtures";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  buildCollapseVisibleItems,
  buildSortedGroups,
  filterByCategory,
  type GroupedSection,
  treeHasRenderableArtifacts,
} from "@repo/app/documents/lib/table-view-pipeline";
import {
  createMockDocument,
  makeArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, it } from "vitest";

// ---- Fixtures ----

function makeTree(nodes: ProjectTreeResponse["nodes"]): ProjectTreeResponse {
  return { nodes, externalParents: [] };
}

// ---- Tests ----

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

  function section(key: string, ids: string[]): GroupedSection {
    return {
      descriptor: { key, label: key, mode: GroupByMode.Status },
      groups: ids.map((id) => ({
        groupKey: id,
        root: docItem(id),
        children: [],
      })),
    };
  }

  const OPEN = section("open", ["a", "b"]);
  const CLOSED = section("closed", ["urgent-row"]);
  const ARGS = {
    groupBy: GroupByMode.Status,
    groupedSections: [OPEN, CLOSED],
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
