import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  type OrderedSection,
  packSectionsIntoPages,
  type SectionPagePlan,
  type SectionPlanPage,
} from "@repo/api/src/types/artifact-section-paging";
import type {
  ProjectTreeResponse,
  TreeNode,
} from "@repo/api/src/types/project-tree";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  type DisplayGroup,
  getItemTitle,
  toRowItem,
} from "@repo/app/documents/components/table/document-tree";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import type { SortKey } from "@repo/app/documents/components/table/sort-keys";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import {
  GroupByMode,
  type GroupByModeOptions,
  type GroupByNonNone,
  groupByMode,
} from "@repo/app/documents/lib/group-by";
import {
  buildFlatItems,
  buildSortedGroups,
  DEFAULT_TABLE_VIEW_ORDERING,
  filterByCategory,
  type TableViewOrdering,
} from "@repo/app/documents/lib/table-view-pipeline";

/**
 * ISS-4466 — pagination for a `DocumentsView` surface, at the data layer.
 *
 * `DocumentsView` renders a TREE merging several streams: documents, and
 * branch/session rows nested in the project tree. FEA-4373 only bounded the
 * documents fetch and showed a truncation footer — it never paged, and
 * client-slicing the *tree* would strand nested branches under a root that
 * pages out.
 *
 * ISS-5307: hoisted out of the My Tasks board into `@repo/app/documents`, with
 * no behavior change, because the project detail page needs precisely this. The
 * paging unit is a property of what `DocumentsView` RENDERS, not of which page
 * is rendering it, so there is one implementation rather than two that drift.
 *
 * The honest paged unit is the ROOT GROUP: `buildSortedGroups` (the exact
 * pipeline `DocumentsView` runs) collapses all three streams into one deduped,
 * filter-applied, sorted list of root `DisplayGroup`s, each carrying its full
 * nested subtree. Documents already merged into a tree node are not re-added as
 * their own root (the pipeline's `seenIds` dedup), so an entity that appears in
 * more than one stream is counted once. Paging that list gives ONE honest total
 * that matches every visible root, with nesting intact.
 *
 * This module pages that root list and reconstructs the `documents` +
 * `treeData` subset for the current page so `DocumentsView` renders exactly the
 * page's roots with its render assembly untouched. For the flat category tabs
 * (documents / features / plans / branches) the paged unit is the flat row,
 * matching what those tabs render.
 */

/** The paged inputs to feed `DocumentsView`, plus one honest total. */
export type TableViewPage = {
  /** The document subset whose root (or nested-in-a-paged-node id) is present. */
  pagedDocuments: DocumentRowData[];
  /**
   * The tree subset whose root nodes are on the current page. `null`/`undefined`
   * is preserved (loading) so `DocumentsView`'s tree-loading gate is unchanged.
   */
  pagedTreeData: ProjectTreeResponse | null | undefined;
  /** One honest total across all three streams for the active tab + filters. */
  total: number;
};

type CountInput = {
  documents: DocumentRowData[];
  treeData: ProjectTreeResponse | null | undefined;
  filterCategory: FilterCategory;
  filterText: string;
  applyProjectFilters?: (items: DocumentRowItem[]) => DocumentRowItem[];
  sortBy: SortKey | null;
  sortDir: "asc" | "desc";
  /**
   * Active grouping mode (status / assignee / priority / none). ISS-4466:
   * `DocumentsView` re-groups and reorders the rows it is handed by section, so
   * page membership MUST be sliced in that same grouped order — otherwise a
   * status/assignee/priority section repeats across pages and the global
   * composition is wrong. When `None`, the sort order alone drives membership.
   */
  groupBy: GroupByMode;
  /**
   * ISS-9437: the resolved sort/section order for this surface. It MUST be the
   * same value `DocumentsView` renders with — the paginator decides page
   * membership by running this pipeline, and the view then re-sorts each page
   * with its own. Two orderings over one corpus drop rows and repeat others,
   * which `table-view-pagination.test.ts`'s partition proof detects. Omitted
   * takes today's order.
   */
  ordering?: TableViewOrdering;
};

type PageInput = CountInput & {
  page: number;
  pageSize: number;
  /**
   * Explicit membership for this page, from {@link buildTableViewPagePlan}.
   * Absent means the page is the fixed `pageSize` slice of the ordered list.
   */
  pageIds?: readonly string[];
};

/**
 * Compute the honest total (all matching root groups / flat rows for the active
 * tab + filters) without slicing. This is the TRUE count of rows the tab would
 * render unpaged — never the size of the current page — so a footer built on it
 * cannot claim the page size is the total. Split from `pageTableView` so page-clamping can
 * read the total before deciding the effective page.
 */
export function countTableViewRows(input: CountInput): number {
  if (input.filterCategory === "branches") {
    return buildBranchFlatItems(input).length;
  }
  if (input.filterCategory !== "all") {
    return buildCategoryFlatItems(input).length;
  }
  return buildAllRootIds(input).length;
}

/**
 * Page a `DocumentsView` surface for the active tab. Returns the `documents` +
 * `treeData` subset for the requested page and the honest total. `page` is
 * zero-based and assumed already clamped by the caller (the hook clamps it
 * against `total`).
 */
export function pageTableView(input: PageInput): TableViewPage {
  if (input.filterCategory === "branches") {
    return pageBranchesTab(input);
  }
  if (input.filterCategory !== "all") {
    return pageCategoryTab(input);
  }
  return pageAllTab(input);
}

function buildAllRootGroups(input: CountInput): DisplayGroup[] {
  const { groups } = buildSortedGroups({
    treeData: input.treeData ?? null,
    documents: input.documents,
    applyProjectFilters: input.applyProjectFilters,
    filterText: input.filterText,
    sortBy: input.sortBy,
    sortDir: input.sortDir,
    ordering: orderingOf(input),
  });
  return groups;
}

function buildAllRootIds(input: CountInput): string[] {
  // When a grouping mode is active, `DocumentsView` reorders these root groups
  // by section (via `groupByMode`), so page membership must follow the same
  // grouped order — not the flat sorted order — or a section would repeat
  // across pages (davetho, ISS-4466).
  return orderGroupsForPaging(
    buildAllRootGroups(input),
    input.groupBy,
    orderingOf(input).groupOptions
  ).map((group) => group.groupKey);
}

function pageAllTab(input: PageInput): TableViewPage {
  const rootIds = buildAllRootIds(input);
  const total = rootIds.length;
  const pageIds = new Set(
    input.pageIds ?? sliceForPage(rootIds, input.page, input.pageSize)
  );

  // Rebuild the paged inputs from the page's root ids. `DocumentsView` re-runs
  // `buildSortedGroups` over this subset, so it must contain exactly the tree
  // nodes and documents whose ROOT is on the page — nested descendants ride
  // along inside their node/document, so nesting is preserved.
  const pagedTreeData = sliceTreeDataByRoots(input.treeData, pageIds);
  // A document that is its own root (not merged into a tree node) stays when its
  // id is on the page.
  const rootDocs = input.documents.filter((doc) => pageIds.has(doc.id));
  // Documents nested inside a paged tree node are resolved by id in
  // `groupByProjectTree`, so the paged document set must also include every
  // document referenced by a paged node's subtree (root or descendant).
  const nestedDocIds = collectNestedDocumentIds(pagedTreeData);
  const nestedDocs = input.documents.filter((doc) => nestedDocIds.has(doc.id));
  return {
    pagedDocuments: dedupeById([...rootDocs, ...nestedDocs]),
    pagedTreeData,
    total,
  };
}

function buildCategoryFlatItems(input: CountInput): DocumentRowItem[] {
  const filtered = filterByCategory(
    input.documents,
    input.filterCategory,
    input.filterText
  );
  const items = buildFlatItems(
    filtered.map(toRowItem),
    input.applyProjectFilters,
    input.sortBy,
    input.sortDir,
    orderingOf(input)
  );
  return orderFlatItemsForPaging(
    items,
    input.groupBy,
    orderingOf(input).groupOptions
  );
}

function pageCategoryTab(input: PageInput): TableViewPage {
  const items = buildCategoryFlatItems(input);
  const total = items.length;
  const pageIds = new Set(
    input.pageIds ??
      sliceForPage(items, input.page, input.pageSize).map((i) => i.data.id)
  );
  return {
    pagedDocuments: input.documents.filter((doc) => pageIds.has(doc.id)),
    // Flat category tabs read only from `documents`; keep the tree passthrough
    // so the view's loading gate is unchanged (it never nests for these tabs).
    pagedTreeData: input.treeData,
    total,
  };
}

// Branch rows come from the tree, not `input.documents` — the one builder here
// that does not read the documents list.
function buildBranchFlatItems(input: CountInput): DocumentRowItem[] {
  const items = collectBranchRowItems(input.treeData);
  const text = input.filterText.trim().toLowerCase();
  const searched = text
    ? items.filter((item) => getItemTitle(item).toLowerCase().includes(text))
    : items;
  const flat = buildFlatItems(
    searched,
    input.applyProjectFilters,
    input.sortBy,
    input.sortDir,
    orderingOf(input)
  );
  return orderFlatItemsForPaging(
    flat,
    input.groupBy,
    orderingOf(input).groupOptions
  );
}

function pageBranchesTab(input: PageInput): TableViewPage {
  const items = buildBranchFlatItems(input);
  const total = items.length;
  const pageIds = new Set(
    input.pageIds ??
      sliceForPage(items, input.page, input.pageSize).map((i) => i.data.id)
  );
  return {
    pagedDocuments: [],
    pagedTreeData: sliceTreeDataToPagedBranches(input.treeData, pageIds),
    total,
  };
}

function collectNestedDocumentIds(
  treeData: ProjectTreeResponse | null | undefined
): Set<string> {
  const ids = new Set<string>();
  for (const node of treeData?.nodes ?? []) {
    if (node.root.type === ArtifactType.Document) {
      ids.add(node.root.id);
    }
    for (const child of node.children) {
      if (child.type === ArtifactType.Document) {
        ids.add(child.id);
      }
    }
  }
  return ids;
}

function collectBranchRowItems(
  treeData: ProjectTreeResponse | null | undefined
): DocumentRowItem[] {
  // Dedup by branch id: a branch can appear both as a tree root and as another
  // node's child (a valid tree shape the canonical `collectArtifactRowItems`
  // also dedupes). Counting/slicing a duplicate-preserving list would inflate
  // the total and shift unique rows onto later pages.
  const items: DocumentRowItem[] = [];
  const seen = new Set<string>();
  for (const node of treeData?.nodes ?? []) {
    if (node.root.type === ArtifactType.Branch && !seen.has(node.root.id)) {
      seen.add(node.root.id);
      items.push({ kind: "branch", data: node.root });
    }
    for (const child of node.children) {
      if (child.type === ArtifactType.Branch && !seen.has(child.id)) {
        seen.add(child.id);
        items.push({ kind: "branch", data: child });
      }
    }
  }
  return items;
}

/**
 * Build the tree subset whose root nodes are in `rootIds`. Used by the tabs
 * whose paged unit IS the root, so a node is kept only when its own root is on
 * the page and its subtree rides along inside it.
 */
function sliceTreeDataByRoots(
  treeData: ProjectTreeResponse | null | undefined,
  rootIds: Set<string>
): ProjectTreeResponse | null | undefined {
  if (treeData === null || treeData === undefined) {
    return treeData;
  }
  const nodes = treeData.nodes.filter((node) => rootIds.has(node.root.id));
  return withKeptParentLinks(treeData, nodes);
}

function sliceForPage<T>(items: T[], page: number, pageSize: number): T[] {
  const start = page * pageSize;
  return items.slice(start, start + pageSize);
}

function dedupeById(docs: DocumentRowData[]): DocumentRowData[] {
  const seen = new Set<string>();
  const out: DocumentRowData[] = [];
  for (const doc of docs) {
    if (seen.has(doc.id)) {
      continue;
    }
    seen.add(doc.id);
    out.push(doc);
  }
  return out;
}

/**
 * Keep only the parent-link entries whose child survived the slice — BOTH
 * channels. `flatParents` is what a category read's promoted rows rebuild their
 * Parent column from, and this slice is the tree the table actually renders, so
 * dropping it here would empty that column on every paged read and undo the fix
 * server-side (whitlockk, PR #6745). Omitted rather than emitted empty, matching the
 * response contract.
 */
function withKeptParentLinks(
  treeData: ProjectTreeResponse,
  nodes: TreeNode[]
): ProjectTreeResponse {
  const keptRootIds = new Set(nodes.map((node) => node.root.id));
  const flatParents = (treeData.flatParents ?? []).filter((entry) =>
    keptRootIds.has(entry.childId)
  );
  return {
    nodes,
    externalParents: treeData.externalParents.filter((entry) =>
      keptRootIds.has(entry.childId)
    ),
    ...(flatParents.length > 0 && { flatParents }),
    ...(treeData.hierarchy && {
      hierarchy: { ...treeData.hierarchy, diagnosticsComplete: false },
    }),
    ...(treeData.truncation && { truncation: treeData.truncation }),
  };
}

/**
 * Build the tree subset that renders EXACTLY the branch ids in `pageIds`, once
 * each.
 *
 * The Branches tab does not render this tree as a tree: `collectArtifactRowItems`
 * walks `[node.root, ...node.children]` and emits every BRANCH it finds as a flat
 * row. So membership of this slice is a claim about entities, not about roots,
 * and any branch left reachable in it becomes a visible row.
 *
 * That is what whitlockk caught: retaining a node so it could carry a paged CHILD
 * also retained its root. With branch root A parenting branch B and a page size
 * of 1, page 2 selected B, kept A's node to hold it, and rendered both — two
 * rows on a one-row page, with A repeated from page 1. The fix is to drop a
 * branch root this page excludes and promote its paged branch children to roots
 * of their own; nesting is not information this tab renders, so nothing is lost,
 * while the page and the footer finally agree.
 *
 * A node whose root is NOT a branch (a document parenting branches) contributes
 * no row of its own, so it is kept — pruned to its paged branch children — and
 * dropped entirely when none of them are on this page.
 */
function sliceTreeDataToPagedBranches(
  treeData: ProjectTreeResponse | null | undefined,
  pageIds: Set<string>
): ProjectTreeResponse | null | undefined {
  if (treeData === null || treeData === undefined) {
    return treeData;
  }
  // A branch can be both its own node's root and another node's child. When the
  // node it roots survives, promoting the child copy too would emit a second
  // node for the same id, so resolve the retained roots before promoting.
  const retainedRootIds = new Set(
    treeData.nodes
      .filter(
        (node) =>
          node.root.type === ArtifactType.Branch && pageIds.has(node.root.id)
      )
      .map((node) => node.root.id)
  );
  const nodes: TreeNode[] = [];
  const promoted = new Set<string>();
  for (const node of treeData.nodes) {
    const children = node.children.filter(
      (child) => child.type !== ArtifactType.Branch || pageIds.has(child.id)
    );
    if (retainedRootIds.has(node.root.id)) {
      nodes.push({ ...node, children });
      continue;
    }
    if (node.root.type !== ArtifactType.Branch) {
      // Renders no branch row itself; worth keeping only for paged children.
      if (children.some((child) => child.type === ArtifactType.Branch)) {
        nodes.push({ ...node, children });
      }
      continue;
    }
    // A branch root this page excludes: promote its paged branch children so
    // they render without dragging their parent's row onto the page.
    for (const child of children) {
      if (
        child.type === ArtifactType.Branch &&
        !(retainedRootIds.has(child.id) || promoted.has(child.id))
      ) {
        promoted.add(child.id);
        nodes.push({ root: child, children: [] });
      }
    }
  }
  return withKeptParentLinks(treeData, nodes);
}

/**
 * Reorder root display groups into the exact section order `DocumentsView`
 * renders when a grouping mode is active (`groupByMode` → canonical grid bands): sections in descriptor order, each section's
 * members preserving their input (already-sorted) order. When `groupBy` is
 * `None`, the sorted order is the render order, so the input passes through
 * unchanged. Paging over this order is what makes each page a contiguous,
 * non-repeating slice of the grouped board (ISS-4466, davetho).
 */
function orderGroupsForPaging(
  groups: DisplayGroup[],
  groupBy: GroupByMode,
  groupOptions: GroupByModeOptions
): DisplayGroup[] {
  if (groupBy === GroupByMode.None) {
    return groups;
  }
  const sections = groupByMode(
    groups,
    (group) => group.root,
    groupBy as GroupByNonNone,
    groupOptions
  );
  return sections.flatMap((section) => section.values);
}

/**
 * Reorder flat row items into the section order `DocumentsView` renders for the
 * flat category/branch tabs when a grouping mode is active
 * (`groupByMode` → canonical grid bands). Mirrors
 * {@link orderGroupsForPaging} for the flat-row unit; passes through unchanged
 * when `groupBy` is `None`.
 */
function orderFlatItemsForPaging(
  items: DocumentRowItem[],
  groupBy: GroupByMode,
  groupOptions: GroupByModeOptions
): DocumentRowItem[] {
  if (groupBy === GroupByMode.None) {
    return items;
  }
  const sections = groupByMode(
    items,
    (item) => item,
    groupBy as GroupByNonNone,
    groupOptions
  );
  return sections.flatMap((section) => section.values);
}

// ISS-10472: the packer moved to `@repo/api` so `apps/api` packs grouped pages
// with the same arithmetic. These names stay exported because `DocumentsView`
// and its paginator are typed against them.
export type TableViewPlanPage = SectionPlanPage;
export type TableViewPagePlan = SectionPagePlan;

/**
 * Build the section-aware page plan for the active tab, or `null` when the
 * surface is UNGROUPED — an ungrouped board renders no section headers, so it
 * has no section boundaries to respect and no population to report, and it
 * keeps the fixed-`pageSize` slicing it has always had.
 */
export function buildTableViewPagePlan(
  input: CountInput,
  pageSize: number
): TableViewPagePlan | null {
  if (input.groupBy === GroupByMode.None) {
    return null;
  }
  return packSectionsIntoPages(buildOrderedSections(input), pageSize);
}

/** The active tab's sections, in the order `DocumentsView` renders them. */
function buildOrderedSections(input: CountInput): OrderedSection[] {
  const mode = input.groupBy as GroupByNonNone;
  const groupOptions = orderingOf(input).groupOptions;
  if (input.filterCategory === "branches") {
    return flatItemSections(buildBranchFlatItems(input), mode, groupOptions);
  }
  if (input.filterCategory !== "all") {
    return flatItemSections(buildCategoryFlatItems(input), mode, groupOptions);
  }
  return groupByMode(
    buildAllRootGroups(input),
    (group) => group.root,
    mode,
    groupOptions
  ).map((section) => ({
    key: section.descriptor.key,
    ids: section.values.map((group) => group.groupKey),
  }));
}

function flatItemSections(
  items: DocumentRowItem[],
  mode: GroupByNonNone,
  groupOptions: GroupByModeOptions
): OrderedSection[] {
  return groupByMode(items, (item) => item, mode, groupOptions).map(
    (section) => ({
      key: section.descriptor.key,
      ids: section.values.map((item) => item.data.id),
    })
  );
}

/** This surface's resolved order, defaulting to today's. */
function orderingOf(input: CountInput): TableViewOrdering {
  return input.ordering ?? DEFAULT_TABLE_VIEW_ORDERING;
}
