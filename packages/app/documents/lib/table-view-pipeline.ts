import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  STATUS_DISPLAY_ORDER,
  statusDisplayRank,
} from "@repo/api/src/types/artifact-status-display-order";
import { artifactStatusRootRankOrNull } from "@repo/api/src/types/artifact-status-rank";
import { DocumentType } from "@repo/api/src/types/document";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  type DisplayGroup,
  filterDisplayGroups,
  getItemTitle,
  groupByProjectTree,
  isDocumentArtifact,
  isFeatureDoc,
  toRowItem,
} from "@repo/app/documents/components/table/document-tree";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import { isDocumentRowItem } from "@repo/app/documents/components/table/row-type-registry";
import type { SortKey } from "@repo/app/documents/components/table/sort-keys";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { matchesFilter } from "@repo/app/documents/lib/document-filter";
import {
  getArtifactRoute,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import {
  GroupByMode,
  type GroupByModeOptions,
} from "@repo/app/documents/lib/group-by";
import {
  type RowTypeConfigOptionsResolver,
  rowArtifactStatus,
  rowArtifactStatusEvidence,
} from "@repo/app/documents/lib/row-artifact-status";
// Cross-slice import (intentional): the table's Parent column links rows to
// their project-tree parents, so the documents pipeline reuses the projects
// slice's parent-entry walker rather than duplicating the traversal.
import {
  addNodeParentEntries,
  type ParentEntry,
} from "@repo/app/projects/lib/project-tree-utils";
import { comparePriorityValuesForSort } from "@repo/app/shared/lib/priority-sort";
import {
  compareSlugValues,
  compareStatusValues,
} from "@repo/app/shared/lib/sort-comparators";
import type {
  SortConfig,
  SortDirection,
} from "@repo/app/shared/lib/table-utils";
import { sortTableData } from "@repo/app/shared/lib/table-utils";
import { compareAssigneeNames } from "@repo/app/shared/lib/user-utils";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";
import { compareNullableNumber } from "@repo/lib/sort-comparators";
import type { OrgPathBuilder } from "@repo/navigation/navigation-adapter";
import {
  collectPaintedDocumentGroupRows,
  collectVisibleDocumentRows,
  documentTreeRoots,
} from "./documents-grid-groups";

/**
 * Pure view-pipeline helpers for the documents table (FEA-1763 / PLN-874
 * Phase 3). Extracted from the page-private `documents-view.tsx` so the
 * orchestrator component is composition-only and the pipeline is unit-testable:
 * source rows → category/text filter → tree grouping → project filters →
 * sort → canonical grid bands → flattened render list.
 */

/**
 * Build the parent map for the Parent column: child entity id → immediate
 * parent title + route. Uses the depth field from TreeChild to find the
 * correct immediate parent for each descendant rather than mapping all
 * descendants to the root. Cross-project parents (in
 * `treeData.externalParents`) fill in for items whose parent lives outside
 * this project.
 *
 * `treeData.flatParents` fills in for the third case: a CATEGORY read returns
 * every match as a root, so a promoted row has neither a `parentId` nor a
 * `children` array to be found in and the walk above sees no parent for it. It
 * is read with the same rule the walk uses — the title always, the route only
 * when the parent type has one — so a filtered tab's Parent column says what
 * the unfiltered tree's does, rather than emptying out and collapsing
 * (whitlockk, PR #6745). Deliberately NOT merged into the `externalParents` loop
 * below, whose document-only narrowing is a separate, deliberate choice about
 * out-of-project parents.
 */
export function buildParentMap(
  treeData: ProjectTreeResponse | null,
  orgSlug: string | OrgPathBuilder
): Map<string, ParentEntry> {
  const map = new Map<string, ParentEntry>();
  if (!treeData) {
    return map;
  }
  const slug = typeof orgSlug === "string" ? orgSlug : "";
  for (const node of treeData.nodes) {
    addNodeParentEntries(node, map, slug);
  }
  for (const entry of treeData.flatParents ?? []) {
    if (map.has(entry.childId)) {
      continue;
    }
    map.set(entry.childId, {
      title: entry.parent.name,
      href: withOrgSlug(slug, getArtifactRoute(entry.parent)),
    });
  }
  for (const entry of treeData.externalParents) {
    if (map.has(entry.childId) || !isDocumentArtifact(entry.parent)) {
      continue;
    }
    map.set(entry.childId, {
      title: entry.parent.name,
      href: withOrgSlug(slug, getArtifactRoute(entry.parent)),
    });
  }
  if (typeof orgSlug === "function") {
    for (const entry of map.values()) {
      if (entry.href) {
        entry.href = orgSlug(entry.href.slice(1));
      }
    }
  }
  return map;
}

export function filterByCategory(
  documents: DocumentRowData[],
  category: FilterCategory,
  filterText: string
): DocumentRowData[] {
  const byText = documents.filter((d) => matchesFilter(d, filterText));

  switch (category) {
    case "all":
      return byText;
    case "documents":
      return byText.filter((d) => d.type === DocumentType.Prd);
    case "features":
      return byText.filter(isFeatureDoc);
    case "plans":
      return byText.filter((d) => d.type === DocumentType.ImplementationPlan);
    case "branches":
      // Branch artifacts are not documents — they come from the project tree
      // (see `branchItems` in DocumentsView), so no document matches this
      // category (FEA-1763).
      return [];
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}

function getItemSortType(item: DocumentRowItem): string {
  if (item.kind === "project") {
    return "PROJECT";
  }
  return item.data.type;
}

function compareByPriority(
  a: DocumentRowItem,
  b: DocumentRowItem,
  direction: "asc" | "desc"
): number {
  return comparePriorityValuesForSort(
    a.data.priority,
    b.data.priority,
    direction
  );
}

function compareByStatus(a: DocumentRowItem, b: DocumentRowItem): number {
  return compareStatusValues(a.data.status, b.data.status);
}

function compareBySlug(a: DocumentRowItem, b: DocumentRowItem): number {
  return compareSlugValues(a.data.slug, b.data.slug);
}

function compareByUpdatedAt(a: DocumentRowItem, b: DocumentRowItem): number {
  const aDate = new Date(a.data.updatedAt).getTime();
  const bDate = new Date(b.data.updatedAt).getTime();
  return aDate - bDate;
}

/** The column comparators one table view sorts by. */
export type ItemSortConfigs = Record<string, SortConfig<DocumentRowItem>>;

const ITEM_SORT_CONFIGS: ItemSortConfigs = {
  title: {
    key: "title",
    comparator: (a, b) => getItemTitle(a).localeCompare(getItemTitle(b)),
  },
  type: {
    key: "type",
    comparator: (a, b) => {
      const aType = getItemSortType(a);
      const bType = getItemSortType(b);
      return aType.localeCompare(bType);
    },
  },
  updated: {
    key: "updatedAt",
    comparator: compareByUpdatedAt,
  },
  assignee: {
    key: "assignee",
    comparator: (a, b) =>
      compareAssigneeNames(a.data.assignee, b.data.assignee),
  },
  priority: {
    key: "priority",
    directedComparator: compareByPriority,
  },
  status: {
    key: "status",
    comparator: compareByStatus,
  },
  slug: {
    key: "slug",
    comparator: compareBySlug,
  },
};

export function resolveTreeData(
  providedTreeData: ProjectTreeResponse | null | undefined,
  providedLoading: boolean | undefined,
  fetchedData: ProjectTreeResponse | undefined,
  fetchedLoading: boolean
): {
  treeData: ProjectTreeResponse | null | undefined;
  isLoadingTree: boolean;
} {
  if (providedTreeData === undefined) {
    return { treeData: fetchedData, isLoadingTree: fetchedLoading };
  }
  return {
    treeData: providedTreeData,
    isLoadingTree: providedLoading ?? false,
  };
}

/**
 * Build the sorted DisplayGroup list for the "All" view. Uses the project tree
 * structure when available; falls back to per-document flat grouping when
 * treeData is unavailable. Project filters are applied recursively: a group is
 * kept when its root matches (whole subtree preserved) or when any descendant
 * matches (root kept as context, subtree pruned to matching branches), so
 * sub-items matching the filter stay visible even when their parent does not.
 */
export function buildSortedGroups({
  treeData,
  documents,
  applyProjectFilters,
  filterText = "",
  sortBy,
  sortDir,
  ordering = DEFAULT_TABLE_VIEW_ORDERING,
}: {
  treeData: ProjectTreeResponse | null;
  // The FULL document set for this view, not a text-filtered subset: the tree
  // is built from it so a branch/session nested under a document whose own
  // title does not match the search is still reachable. Text matching is
  // applied below, uniformly, in the filter step.
  documents: DocumentRowData[];
  applyProjectFilters?: (items: DocumentRowItem[]) => DocumentRowItem[];
  filterText?: string;
  sortBy: SortKey | null;
  sortDir: "asc" | "desc";
  /**
   * ISS-9437: the resolved comparators + section inputs this surface orders by.
   * Omitted takes {@link DEFAULT_TABLE_VIEW_ORDERING}, which is today's order.
   * The paginator and the view MUST pass the same one — two orderings over one
   * corpus is how a row is skipped or repeated across pages.
   */
  ordering?: TableViewOrdering;
}): { groups: DisplayGroup[]; contextExpandedIds: Set<string> } {
  const ungrouped: DisplayGroup[] = treeData
    ? groupByProjectTree(treeData.nodes, documents)
    : documents.map((doc) => ({
        groupKey: doc.id,
        root: toRowItem(doc),
        children: [],
      }));

  // Apply the search text to every row kind here, in the tree filter step,
  // so a matching branch/session under a non-matching document ancestor is
  // retained (the root is kept as context). Documents match through
  // `matchesFilter` (title OR slug) — the same predicate the flat category
  // tabs use — so a slug-only match is not dropped by a title-only check.
  // Branch/session rows have no slug-search semantics, so they match by name.
  const text = filterText.trim().toLowerCase();
  const matchesText = (item: DocumentRowItem) => {
    if (text === "") {
      return true;
    }
    if (item.kind === "project") {
      return true;
    }
    if (isDocumentRowItem(item)) {
      return matchesFilter(item.data, filterText);
    }
    return getItemTitle(item).toLowerCase().includes(text);
  };

  const needsFiltering = applyProjectFilters !== undefined || text !== "";
  const { groups: filtered, contextExpandedIds } = needsFiltering
    ? filterDisplayGroups(
        ungrouped,
        (item) =>
          matchesText(item) &&
          (!applyProjectFilters || applyProjectFilters([item]).length > 0)
      )
    : { groups: ungrouped, contextExpandedIds: new Set<string>() };

  const config = sortBy ? ordering.itemSortConfigs[sortBy] : null;
  if (!(config?.comparator || config?.directedComparator)) {
    return { groups: filtered, contextExpandedIds };
  }
  const dirMultiplier = sortDir === "asc" ? 1 : -1;
  const sorted = [...filtered].sort((a, b) => {
    if (config.directedComparator) {
      return config.directedComparator(a.root, b.root, sortDir);
    }
    return config.comparator!(a.root, b.root) * dirMultiplier;
  });
  return { groups: sorted, contextExpandedIds };
}

/** Build the flat (filtered + sorted) DocumentRowItem list for filtered views. */
export function buildFlatItems(
  sourceItems: DocumentRowItem[],
  applyProjectFilters:
    | ((items: DocumentRowItem[]) => DocumentRowItem[])
    | undefined,
  sortBy: SortKey | null,
  sortDir: "asc" | "desc",
  ordering: TableViewOrdering = DEFAULT_TABLE_VIEW_ORDERING
): DocumentRowItem[] {
  const items = applyProjectFilters
    ? applyProjectFilters(sourceItems)
    : sourceItems;
  if (sortBy) {
    const config = ordering.itemSortConfigs[sortBy];
    if (config) {
      return sortTableData(items, sortBy, ordering.itemSortConfigs, sortDir);
    }
  }
  return items;
}

/**
 * Whether the project tree contains any artifact the table can render beyond
 * the documents list — i.e. branch or session rows (deployments are excluded
 * from this table by product decision, Task 0.3). Used to derive emptiness
 * and "has anything at all" gates from renderable rows instead of documents
 * only, so a project containing only PRs/sessions still renders its table.
 */
export function treeHasRenderableArtifacts(
  treeData: ProjectTreeResponse | null | undefined
): boolean {
  if (!treeData) {
    return false;
  }
  return treeData.nodes.some(
    (node) =>
      isRenderableNonDocumentType(node.root.type) ||
      node.children.some((child) => isRenderableNonDocumentType(child.type))
  );
}

function isRenderableNonDocumentType(type: ArtifactType): boolean {
  // Exhaustive over ArtifactType: a new artifact type must explicitly opt in
  // or out here rather than silently becoming non-renderable (FEA-1763's
  // "fail loudly" rule). Mirrors `treeEntityToRowItem`'s switch.
  switch (type) {
    case ArtifactType.Branch:
    case ArtifactType.Session:
      return true;
    case ArtifactType.Document:
    case ArtifactType.Deployment:
      return false;
    default: {
      const unhandled: never = type;
      return unhandled;
    }
  }
}

/**
 * The expanded logical population, including closed bands. Painting can retain
 * an earlier occurrence of a repeated identity; that must not remove a later
 * root's descendants from it. Select-all reads `buildCollapseVisibleItems`
 * instead (ISS-12640 AC-3).
 */
export function buildRenderedItems({
  groupBy,
  gridGroups,
  isGroupedView,
  flatItems,
  groups,
  isGroupExpanded,
}: {
  groupBy: GroupByMode;
  gridGroups: readonly GridTableV2Group<DocumentRowItem>[];
  isGroupedView: boolean;
  flatItems: DocumentRowItem[];
  groups: DisplayGroup[];
  isGroupExpanded: (key: string) => boolean;
}): DocumentRowItem[] {
  if (groupBy !== GroupByMode.None) {
    const roots = gridGroups.flatMap((group) => group.items);
    if (isGroupedView) {
      return collectVisibleDocumentRows(roots, isGroupExpanded);
    }
    return roots;
  }
  if (!isGroupedView) {
    return flatItems;
  }
  return collectVisibleDocumentRows(documentTreeRoots(groups), isGroupExpanded);
}

/**
 * The retained grid/card paint projection, read by column collapse and by
 * select-all (ISS-12640 AC-3). Its per-band guard can suppress a later root's
 * occurrence even with every band open, so an unpainted Urgent row cannot keep
 * Priority visible for a body that contains only default priorities, and
 * select-all never reaches a row the body does not paint.
 */
export function buildCollapseVisibleItems({
  groupBy,
  gridGroups,
  isGroupedView,
  flatItems,
  groups,
  isGroupExpanded,
  isSectionExpanded,
}: {
  groupBy: GroupByMode;
  gridGroups: readonly GridTableV2Group<DocumentRowItem>[];
  isGroupedView: boolean;
  flatItems: DocumentRowItem[];
  groups: DisplayGroup[];
  isGroupExpanded: (key: string) => boolean;
  isSectionExpanded: (key: string) => boolean;
}): DocumentRowItem[] {
  if (groupBy !== GroupByMode.None) {
    return collectPaintedDocumentGroupRows({
      gridGroups,
      isGroupExpanded,
      isNested: isGroupedView,
      isSectionExpanded,
    }).map((row) => row.item);
  }
  if (!isGroupedView) {
    return flatItems;
  }
  return collectVisibleDocumentRows(documentTreeRoots(groups), isGroupExpanded);
}

/**
 * ISS-9437 — the ORDER one `DocumentsView` surface is sorted and sectioned by,
 * as one resolved value.
 *
 * Both halves travel together on purpose. The paginator slices page membership
 * with these comparators and the view re-sorts each page with them; hand the two
 * different values and a row is silently skipped or shown twice, which is the
 * exact failure `table-view-pagination.test.ts`'s partition proof exists to
 * detect. One object means a surface can only get that wrong by passing two
 * different objects, which a reader can see.
 */
export type TableViewOrdering = {
  itemSortConfigs: ItemSortConfigs;
  groupOptions: GroupByModeOptions;
};

/** Today's order: raw display rank for the Status column and its sections. */
export const DEFAULT_TABLE_VIEW_ORDERING: TableViewOrdering = Object.freeze({
  itemSortConfigs: ITEM_SORT_CONFIGS,
  groupOptions: Object.freeze({}) as GroupByModeOptions,
});

/**
 * ISS-9437 ON: root band first, the raw display rank as the tiebreak inside it.
 *
 * Takes the caller's RESOLVED per-row options rather than a flag, so the ISS-8694
 * decision is made once at that surface's own read site and the fold here reads
 * exactly what the row's render reads. Memoized per resolver — there are two of
 * them and they are module constants — so the returned record has a stable
 * identity and a `useMemo` keyed on it is not invalidated every render.
 */
export function rootFirstTableViewOrdering(
  resolveRowOptions: RowTypeConfigOptionsResolver
): TableViewOrdering {
  const cached = ROOT_FIRST_ORDERINGS.get(resolveRowOptions);
  if (cached) {
    return cached;
  }
  const ordering: TableViewOrdering = Object.freeze({
    itemSortConfigs: Object.freeze({
      ...ITEM_SORT_CONFIGS,
      status: {
        key: "status",
        directedComparator: rootFirstStatusComparator(resolveRowOptions),
      },
    }),
    groupOptions: Object.freeze({
      sectionRoot: (item: DocumentRowItem) =>
        rowArtifactStatus(item, resolveRowOptions(item)).root,
      statusEvidence: (item: DocumentRowItem) =>
        rowArtifactStatusEvidence(item, resolveRowOptions(item)),
    }),
  });
  ROOT_FIRST_ORDERINGS.set(resolveRowOptions, ordering);
  return ordering;
}

/** Keeps legacy sort order while grouping on the champion's retained evidence. */
export function retainedStatusTableViewOrdering(
  resolveRowOptions: RowTypeConfigOptionsResolver
): TableViewOrdering {
  const cached = RETAINED_STATUS_ORDERINGS.get(resolveRowOptions);
  if (cached) {
    return cached;
  }
  const ordering: TableViewOrdering = Object.freeze({
    itemSortConfigs: ITEM_SORT_CONFIGS,
    groupOptions: Object.freeze({
      statusEvidence: (item: DocumentRowItem) =>
        rowArtifactStatusEvidence(item, resolveRowOptions(item)),
    }),
  });
  RETAINED_STATUS_ORDERINGS.set(resolveRowOptions, ordering);
  return ordering;
}

const ROOT_FIRST_ORDERINGS = new WeakMap<
  RowTypeConfigOptionsResolver,
  TableViewOrdering
>();

const RETAINED_STATUS_ORDERINGS = new WeakMap<
  RowTypeConfigOptionsResolver,
  TableViewOrdering
>();

/**
 * A `directedComparator`, not a `comparator`, and both levels park their misses.
 *
 * `SortConfig.comparator`'s result is negated wholesale for a descending sort, so
 * it cannot hold a value at one end of the column in both directions.
 * `statusDisplayRank` returns `STATUS_DISPLAY_ORDER.length` for a miss and every
 * branch, session and project status IS a miss, so a negated raw rank floats a
 * `MERGED` branch row to the TOP of the `done` band on descending. Both levels
 * therefore go through `compareNullableNumber`, whose null handling returns
 * before the direction sign is applied — nothing here is hand-negated.
 */
function rootFirstStatusComparator(
  resolveRowOptions: RowTypeConfigOptionsResolver
): (
  a: DocumentRowItem,
  b: DocumentRowItem,
  direction: SortDirection
) => number {
  return (a, b, direction) => {
    const rootDelta = compareNullableNumber(
      artifactStatusRootRankOrNull(
        rowArtifactStatus(a, resolveRowOptions(a)).root
      ),
      artifactStatusRootRankOrNull(
        rowArtifactStatus(b, resolveRowOptions(b)).root
      ),
      direction
    );
    if (rootDelta !== 0) {
      return rootDelta;
    }
    return compareNullableNumber(
      rawStatusRankOrNull(rowArtifactStatusEvidence(a, resolveRowOptions(a))),
      rawStatusRankOrNull(rowArtifactStatusEvidence(b, resolveRowOptions(b))),
      direction
    );
  };
}

/**
 * The raw display rank, reporting a MISS as `null` so it parks last in BOTH
 * directions instead of being negated to the front. A miss is the routine case
 * for branch, session and project rows, not an edge case.
 */
function rawStatusRankOrNull(status: string | null | undefined): number | null {
  const rank = statusDisplayRank(status);
  return rank === STATUS_DISPLAY_ORDER.length ? null : rank;
}
