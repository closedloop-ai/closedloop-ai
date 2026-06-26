import { ArtifactType } from "@repo/api/src/types/artifact";
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
  type GroupByNonNone,
  type GroupSectionDescriptor,
  groupByMode,
} from "@repo/app/documents/lib/group-by";
// Cross-slice import (intentional): the table's Parent column links rows to
// their project-tree parents, so the documents pipeline reuses the projects
// slice's parent-entry walker rather than duplicating the traversal.
import {
  addNodeParentEntries,
  type ParentEntry,
} from "@repo/app/projects/lib/project-tree-utils";
import { comparePriorityValues } from "@repo/app/shared/lib/priority-sort";
import {
  compareSlugValues,
  compareStatusValues,
} from "@repo/app/shared/lib/sort-comparators";
import type { SortConfig } from "@repo/app/shared/lib/table-utils";
import { sortTableData } from "@repo/app/shared/lib/table-utils";
import { compareAssigneeNames } from "@repo/app/shared/lib/user-utils";

/**
 * Pure view-pipeline helpers for the documents table (FEA-1763 / PLN-874
 * Phase 3). Extracted from the page-private `documents-view.tsx` so the
 * orchestrator component is composition-only and the pipeline is unit-testable:
 * source rows → category/text filter → tree grouping → project filters →
 * sort → grouped sections → flattened render list.
 */

// ---- Parent map ----

/**
 * Build the parent map for the Parent column: child entity id → immediate
 * parent title + route. Uses the depth field from TreeChild to find the
 * correct immediate parent for each descendant rather than mapping all
 * descendants to the root. Cross-project parents (in
 * `treeData.externalParents`) fill in for items whose parent lives outside
 * this project.
 */
export function buildParentMap(
  treeData: ProjectTreeResponse | null,
  orgSlug: string
): Map<string, ParentEntry> {
  const map = new Map<string, ParentEntry>();
  if (!treeData) {
    return map;
  }
  for (const node of treeData.nodes) {
    addNodeParentEntries(node, map, orgSlug);
  }
  for (const entry of treeData.externalParents) {
    if (map.has(entry.childId) || !isDocumentArtifact(entry.parent)) {
      continue;
    }
    map.set(entry.childId, {
      title: entry.parent.name,
      href: withOrgSlug(orgSlug, getArtifactRoute(entry.parent)),
    });
  }
  return map;
}

// ---- Category / text filtering ----

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

// ---- Grouped sections (by status / assignee / priority) ----

export type GroupedSection = {
  descriptor: GroupSectionDescriptor;
  groups: DisplayGroup[];
};

function groupDisplayGroupsByMode(
  groups: DisplayGroup[],
  mode: GroupByNonNone
): GroupedSection[] {
  return groupByMode(groups, (g) => g.root, mode).map((bucket) => ({
    descriptor: bucket.descriptor,
    groups: bucket.values,
  }));
}

function groupFlatItemsByMode(
  items: DocumentRowItem[],
  mode: GroupByNonNone
): GroupedSection[] {
  return groupByMode(items, (item) => item, mode).map((bucket) => ({
    descriptor: bucket.descriptor,
    groups: bucket.values.map((item) => ({
      groupKey: item.data.id,
      root: item,
      children: [],
    })),
  }));
}

/** Recursively collect visible items from a nested children list. */
function collectVisibleChildren(
  children: DocumentRowItem[],
  isGroupExpanded: (key: string) => boolean
): DocumentRowItem[] {
  const items: DocumentRowItem[] = [];
  for (const child of children) {
    items.push(child);
    if (
      child.children &&
      child.children.length > 0 &&
      isGroupExpanded(child.data.id)
    ) {
      items.push(...collectVisibleChildren(child.children, isGroupExpanded));
    }
  }
  return items;
}

function flattenGroupedSections(
  sections: GroupedSection[],
  isGroupedView: boolean,
  isGroupExpanded: (key: string) => boolean
): DocumentRowItem[] {
  const items: DocumentRowItem[] = [];
  for (const section of sections) {
    for (const group of section.groups) {
      items.push(group.root);
      if (isGroupedView && isGroupExpanded(group.groupKey)) {
        items.push(...collectVisibleChildren(group.children, isGroupExpanded));
      }
    }
  }
  return items;
}

function flattenDisplayGroups(
  groups: DisplayGroup[],
  isGroupExpanded: (key: string) => boolean
): DocumentRowItem[] {
  const items: DocumentRowItem[] = [];
  for (const group of groups) {
    items.push(group.root);
    if (isGroupExpanded(group.groupKey)) {
      items.push(...collectVisibleChildren(group.children, isGroupExpanded));
    }
  }
  return items;
}

// ---- Sort configs ----

function getItemSortType(item: DocumentRowItem): string {
  if (item.kind === "project") {
    return "PROJECT";
  }
  return item.data.type;
}

function compareByPriority(a: DocumentRowItem, b: DocumentRowItem): number {
  return comparePriorityValues(a.data.priority, b.data.priority);
}

function compareByStatus(a: DocumentRowItem, b: DocumentRowItem): number {
  return compareStatusValues(a.data.status, b.data.status);
}

function compareBySlug(a: DocumentRowItem, b: DocumentRowItem): number {
  return compareSlugValues(a.data.slug, b.data.slug);
}

const ITEM_SORT_CONFIGS: Record<string, SortConfig<DocumentRowItem>> = {
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
  dueDate: {
    key: "updatedAt",
    comparator: (a, b) => {
      const aDate = new Date(a.data.updatedAt).getTime();
      const bDate = new Date(b.data.updatedAt).getTime();
      return aDate - bDate;
    },
  },
  assignee: {
    key: "assignee",
    comparator: (a, b) =>
      compareAssigneeNames(a.data.assignee, b.data.assignee),
  },
  priority: {
    key: "priority",
    comparator: compareByPriority,
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

// ---- Tree data resolution ----

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

// ---- Pipeline builders ----

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

  const config = sortBy ? ITEM_SORT_CONFIGS[sortBy] : null;
  if (!config?.comparator) {
    return { groups: filtered, contextExpandedIds };
  }
  const { comparator } = config;
  const dirMultiplier = sortDir === "asc" ? 1 : -1;
  const sorted = [...filtered].sort(
    (a, b) => comparator(a.root, b.root) * dirMultiplier
  );
  return { groups: sorted, contextExpandedIds };
}

/** Build the flat (filtered + sorted) DocumentRowItem list for filtered views. */
export function buildFlatItems(
  sourceItems: DocumentRowItem[],
  applyProjectFilters:
    | ((items: DocumentRowItem[]) => DocumentRowItem[])
    | undefined,
  sortBy: SortKey | null,
  sortDir: "asc" | "desc"
): DocumentRowItem[] {
  const items = applyProjectFilters
    ? applyProjectFilters(sourceItems)
    : sourceItems;
  if (sortBy) {
    const config = ITEM_SORT_CONFIGS[sortBy];
    if (config) {
      return sortTableData(items, sortBy, ITEM_SORT_CONFIGS, sortDir);
    }
  }
  return items;
}

/** Build grouped sections when a grouping mode (status/assignee/priority) is active. */
export function buildGroupedSections(
  groupBy: GroupByMode,
  isGroupedView: boolean,
  groups: DisplayGroup[],
  flatItems: DocumentRowItem[]
): GroupedSection[] {
  if (groupBy === GroupByMode.None) {
    return [];
  }
  if (isGroupedView) {
    return groupDisplayGroupsByMode(groups, groupBy);
  }
  return groupFlatItemsByMode(flatItems, groupBy);
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

/** Flatten the grouping output into the final ordered row list for rendering. */
export function buildRenderedItems({
  groupBy,
  groupedSections,
  isGroupedView,
  flatItems,
  groups,
  isGroupExpanded,
}: {
  groupBy: GroupByMode;
  groupedSections: GroupedSection[];
  isGroupedView: boolean;
  flatItems: DocumentRowItem[];
  groups: DisplayGroup[];
  isGroupExpanded: (key: string) => boolean;
}): DocumentRowItem[] {
  if (groupBy !== GroupByMode.None) {
    return flattenGroupedSections(
      groupedSections,
      isGroupedView,
      isGroupExpanded
    );
  }
  if (!isGroupedView) {
    return flatItems;
  }
  return flattenDisplayGroups(groups, isGroupExpanded);
}
