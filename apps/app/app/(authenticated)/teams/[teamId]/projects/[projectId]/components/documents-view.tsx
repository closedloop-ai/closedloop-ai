"use client";

import {
  DocumentType,
  type DocumentWithWorkstream,
  getRoutePrefixForType,
} from "@repo/api/src/types/document";
import {
  type TreeEntity,
  TreeEntityType,
  type TreeNode,
} from "@repo/api/src/types/project-tree";
import type { WorkstreamState } from "@repo/api/src/types/workstream";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import {
  CircleDashedIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FilterXIcon,
  GitPullRequestIcon,
  Layers2Icon,
  Loader2,
  MergeIcon,
  TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import {
  DocumentRow,
  type DocumentRowItem,
  type RowEditHandlers,
} from "@/components/document-table/document-row";
import { GroupSectionHeader } from "@/components/document-table/group-section-header";
import { DocumentTableHeader } from "@/components/document-table/table-header";
import { EmptyState } from "@/components/empty-state";
import { MoveEntityDialog } from "@/components/move-entity-dialog";
import { useParentFallbackMap } from "@/hooks/queries/use-artifact-links";
import { useMergeDocuments } from "@/hooks/queries/use-documents";
import { useProjectTree } from "@/hooks/queries/use-project-tree";
import type { DocumentColumn } from "@/hooks/use-column-visibility";
import { useGroupExpansion } from "@/hooks/use-group-expansion";
import { useSortParams } from "@/hooks/use-sort-params";
import { matchesFilter } from "@/lib/document-filter";
import {
  GroupByMode,
  type GroupByNonNone,
  type GroupSectionDescriptor,
  groupByMode,
} from "@/lib/group-by";
import { comparePriorityValues } from "@/lib/priority-sort";
import { DOCUMENT_STATUS_TO_ICON } from "@/lib/project-constants";
import type { SortConfig } from "@/lib/table-utils";
import { sortTableData } from "@/lib/table-utils";
import { compareAssigneeNames } from "@/lib/user-utils";
import type { FilterCategory } from "../page";
import { MergeDocumentsDialog } from "./merge-documents-dialog";

export type DocumentsViewProps = {
  documents: DocumentWithWorkstream[];
  projectId: string;
  teamId: string;
  filterText: string;
  filterCategory: FilterCategory;
  visibleColumns: DocumentColumn[];
  onDelete?: (item: DocumentRowItem) => Promise<boolean>;
  /** Edit handlers for inline cell editing (assignee, priority, due date). */
  editHandlers?: RowEditHandlers;
  /** Apply project-level filters (assignee, status, priority, date) to root items. */
  applyProjectFilters?: (items: DocumentRowItem[]) => DocumentRowItem[];
  /** Whether any project filter is currently active. */
  isFilterActive?: boolean;
  /** Callback to clear all project filters. */
  onClearFilters?: () => void;
  /** How to group items (none / status / assignee / priority). */
  groupBy?: GroupByMode;
};

/**
 * Convert a document to a DocumentRowItem. Feature-typed documents render
 * with the "feature" kind so row-level components can style / route them
 * differently from other document types.
 */
function toRowItem(doc: DocumentWithWorkstream): DocumentRowItem {
  return doc.type === DocumentType.Feature
    ? { kind: "feature", data: doc }
    : { kind: "artifact", data: doc };
}

function isFeatureDoc(doc: DocumentWithWorkstream): boolean {
  return doc.type === DocumentType.Feature;
}

// ---- Workstream grouping (reused from threaded view) ----

type WorkstreamGroup = {
  id: string | null;
  groupKey: string;
  title: string;
  state: WorkstreamState | null;
  items: DocumentRowItem[];
};

const TYPE_ORDER: Record<DocumentType, number> = {
  [DocumentType.Prd]: 0,
  [DocumentType.Feature]: 1,
  [DocumentType.ImplementationPlan]: 2,
  [DocumentType.Template]: 3,
};

const UNASSIGNED_KEY_PREFIX = "unassigned:" as const;

function getItemTypeOrder(item: DocumentRowItem): number {
  if (item.kind === "project") {
    return 99;
  }
  return TYPE_ORDER[item.data.type] ?? 99;
}

function getItemTitle(item: DocumentRowItem): string {
  if (item.kind === "project") {
    return item.data.name;
  }
  return item.data.title;
}

function sortItemsByType(items: DocumentRowItem[]): DocumentRowItem[] {
  return [...items].sort((a, b) => getItemTypeOrder(a) - getItemTypeOrder(b));
}

function deriveGroupTitle(
  workstreamTitle: string | null | undefined,
  items: DocumentRowItem[]
): string {
  if (workstreamTitle) {
    return workstreamTitle;
  }
  const prd = items.find(
    (i) => i.kind !== "project" && i.data.type === DocumentType.Prd
  );
  if (prd && prd.kind !== "project") {
    return prd.data.title;
  }
  return "Unassigned";
}

function buildUnassignedKey(doc: DocumentWithWorkstream): string {
  // PRDs get their own unassigned bucket so each shows as its own group; every
  // other document type shares a single "unassigned" bucket.
  return doc.type === DocumentType.Prd
    ? `${UNASSIGNED_KEY_PREFIX}${doc.id}`
    : `${UNASSIGNED_KEY_PREFIX}shared`;
}

function groupByWorkstream(
  documents: DocumentWithWorkstream[]
): WorkstreamGroup[] {
  const groups = new Map<string, WorkstreamGroup>();
  const workstreamTitles = new Map<string, string | null | undefined>();

  for (const doc of documents) {
    const key = doc.workstreamId ?? buildUnassignedKey(doc);

    if (!groups.has(key)) {
      groups.set(key, {
        id: doc.workstreamId,
        groupKey: key,
        title: "",
        state: doc.workstream?.state ?? null,
        items: [],
      });
      workstreamTitles.set(key, doc.workstream?.title);
    }
    groups.get(key)?.items.push(toRowItem(doc));
  }

  for (const [key, group] of groups) {
    group.title = deriveGroupTitle(workstreamTitles.get(key), group.items);
    group.items = sortItemsByType(group.items);
  }

  return [...groups.values()].sort((a, b) => {
    if (a.id === null && b.id === null) {
      return a.title.localeCompare(b.title);
    }
    if (a.id === null) {
      return 1;
    }
    if (b.id === null) {
      return -1;
    }
    return a.title.localeCompare(b.title);
  });
}

// ---- Tree-based grouping ----

/** Unified group shape used by both workstream and tree grouping paths. */
type DisplayGroup = {
  groupKey: string;
  root: DocumentRowItem;
  children: DocumentRowItem[];
};

/** Convert workstream groups (fallback path) to the unified DisplayGroup shape. */
function toDisplayGroups(wsGroups: WorkstreamGroup[]): DisplayGroup[] {
  const result: DisplayGroup[] = [];
  for (const g of wsGroups) {
    const [root, ...children] = g.items;
    if (root) {
      result.push({ groupKey: g.groupKey, root, children });
    }
  }
  return result;
}

function treeEntityToRowItem(
  entity: TreeEntity,
  documentMap: Map<string, DocumentWithWorkstream>
): DocumentRowItem | null {
  if (isArtifactTreeEntity(entity)) {
    const doc = documentMap.get(entity.id);
    return doc ? toRowItem(doc) : null;
  }
  return null; // ExternalLink — no row type yet
}

function groupByProjectTree(
  nodes: TreeNode[],
  documents: DocumentWithWorkstream[]
): DisplayGroup[] {
  const documentMap = new Map(documents.map((d) => [d.id, d]));
  const seenIds = new Set<string>();
  const groups: DisplayGroup[] = [];

  for (const node of nodes) {
    const root = treeEntityToRowItem(node.root, documentMap);
    if (!root) {
      continue;
    }
    seenIds.add(node.root.id);

    const children: DocumentRowItem[] = [];
    for (const child of node.children) {
      seenIds.add(child.id);
      const childItem = treeEntityToRowItem(child, documentMap);
      if (childItem) {
        children.push(childItem);
      }
    }
    groups.push({ groupKey: node.root.id, root, children });
  }

  // Orphans — items in filtered data but not in any tree node
  for (const doc of documents) {
    if (!seenIds.has(doc.id)) {
      groups.push({
        groupKey: doc.id,
        root: toRowItem(doc),
        children: [],
      });
    }
  }

  return groups;
}

// ---- Filter items by category ----

function filterByCategory(
  documents: DocumentWithWorkstream[],
  category: FilterCategory,
  filterText: string
): DocumentWithWorkstream[] {
  const byText = documents.filter((d) => matchesFilter(d, filterText));

  switch (category) {
    case "documents":
      return byText.filter((d) => d.type === DocumentType.Prd);
    case "features":
      return byText.filter(isFeatureDoc);
    case "plans":
      return byText.filter((d) => d.type === DocumentType.ImplementationPlan);
    case "branches":
      return byText.filter((d) => d.type === DocumentType.Template);
    default:
      return byText;
  }
}

// ---- Grouped sections (by status / assignee / priority) ----

type GroupedSection = {
  descriptor: GroupSectionDescriptor;
  groups: DisplayGroup[];
};

function sectionIcon(descriptor: GroupSectionDescriptor): ReactNode {
  if (descriptor.mode === GroupByMode.Status && descriptor.status) {
    return (
      <StatusIcon
        size={16}
        status={DOCUMENT_STATUS_TO_ICON[descriptor.status]}
      />
    );
  }
  if (descriptor.mode === GroupByMode.Priority) {
    if (descriptor.priority) {
      return <PriorityIcon priority={descriptor.priority} size={16} />;
    }
    return <CircleDashedIcon className="h-4 w-4 text-muted-foreground" />;
  }
  return (
    <AssigneeAvatar
      assignee={descriptor.assignee ?? null}
      className="size-4"
      disableLink
      disableTooltip
    />
  );
}

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
        items.push(...group.children);
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
      items.push(...group.children);
    }
  }
  return items;
}

// ---- Sort configs ----

const SORT_COLUMNS = [
  "title",
  "type",
  "dueDate",
  "assignee",
  "priority",
  "score",
] as const;

type SortColumn = (typeof SORT_COLUMNS)[number];

const ITEM_SORT_CONFIGS: Record<string, SortConfig<DocumentRowItem>> = {
  title: {
    key: "title",
    comparator: (a, b) => getItemTitle(a).localeCompare(getItemTitle(b)),
  },
  type: {
    key: "type",
    comparator: (a, b) => {
      const aType = a.kind === "artifact" ? a.data.type : "FEATURE";
      const bType = b.kind === "artifact" ? b.data.type : "FEATURE";
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
};

function compareByPriority(a: DocumentRowItem, b: DocumentRowItem): number {
  return comparePriorityValues(a.data.priority, b.data.priority);
}

// ---- Context menu state ----

type MenuState = {
  item: DocumentRowItem;
  anchor: HTMLElement;
} | null;

// ---- Component ----

export function DocumentsView({
  documents,
  projectId,
  teamId,
  filterText,
  filterCategory,
  visibleColumns,
  onDelete,
  editHandlers,
  applyProjectFilters,
  isFilterActive,
  onClearFilters,
  groupBy = GroupByMode.None,
}: DocumentsViewProps) {
  const { isExpanded: isGroupExpanded, toggleGroup } = useGroupExpansion(
    `table:expand:project-artifacts:${projectId}`
  );
  const { isExpanded: isSectionExpanded, toggleGroup: toggleSection } =
    useGroupExpansion(`table:expand:project-group-sections:${projectId}`, {
      defaultExpanded: true,
    });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Clear selection when filter category changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when filterCategory changes
  useEffect(() => {
    setSelectedIds(new Set());
  }, [filterCategory]);

  const [menuState, setMenuState] = useState<MenuState>(null);
  const [deleteTarget, setDeleteTarget] = useState<DocumentRowItem | null>(
    null
  );
  const [pendingBulkIds, setPendingBulkIds] = useState<Set<string>>(new Set());
  const [moveEntities, setMoveEntities] = useState<
    { id: string; projectId?: string | null }[]
  >([]);
  const [moveEntity, setMoveEntity] = useState<{
    id: string;
    projectId?: string | null;
  } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const mergeMutation = useMergeDocuments();

  const { sortBy, sortDir, setSort } = useSortParams<SortColumn>({
    validColumns: SORT_COLUMNS,
    defaultColumn: null,
  });

  const filteredDocuments = useMemo(
    () => filterByCategory(documents, filterCategory, filterText),
    [documents, filterCategory, filterText]
  );

  const isGroupedView = filterCategory === "all";
  const showCheckbox = !isGroupedView;
  const canBulkMove =
    filterCategory === "documents" ||
    filterCategory === "features" ||
    filterCategory === "plans";

  // Check if exactly 2 non-feature documents are selected for merge.
  // Features are excluded — merge is not supported for feature-typed docs.
  const selectedDocumentsForMerge = useMemo(():
    | [DocumentWithWorkstream, DocumentWithWorkstream]
    | null => {
    if (selectedIds.size !== 2) {
      return null;
    }
    const ids = Array.from(selectedIds);
    const d1 = documents.find((d) => d.id === ids[0]);
    const d2 = documents.find((d) => d.id === ids[1]);
    if (d1 && d2 && !(isFeatureDoc(d1) || isFeatureDoc(d2))) {
      return [d1, d2];
    }
    return null;
  }, [selectedIds, documents]);

  const { data: treeData, isLoading: isLoadingTree } =
    useProjectTree(projectId);

  // Build parent map: child entity id → parent title + optional parent artifact route.
  const parentMap = useMemo((): Map<
    string,
    { title: string; href: string | null }
  > => {
    if (!treeData) {
      return new Map();
    }
    const map = new Map<string, { title: string; href: string | null }>();
    for (const node of treeData.nodes) {
      let parentHref: string | null = null;
      if (isArtifactTreeEntity(node.root)) {
        const routePrefix = getRoutePrefixForType(node.root.type);
        if (routePrefix) {
          parentHref = `/${routePrefix}/${node.root.slug}`;
        }
      }
      for (const child of node.children) {
        map.set(child.id, { title: node.root.title, href: parentHref });
      }
    }
    return map;
  }, [treeData]);

  // Build groups for "All" view, sorted by root item when a sort is active.
  // Uses project tree structure when available; falls back to workstream grouping while loading.
  const groups: DisplayGroup[] = useMemo(() => {
    const ungrouped: DisplayGroup[] = treeData
      ? groupByProjectTree(treeData.nodes, filteredDocuments)
      : toDisplayGroups(groupByWorkstream(filteredDocuments));

    // Apply project filters to root items — children are preserved regardless
    const filtered = applyProjectFilters
      ? ungrouped.filter((g) => applyProjectFilters([g.root]).length > 0)
      : ungrouped;

    if (!sortBy) {
      return filtered;
    }
    const config = ITEM_SORT_CONFIGS[sortBy];
    if (!config?.comparator) {
      return filtered;
    }
    const { comparator } = config;
    const dirMultiplier = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort(
      (a, b) => comparator(a.root, b.root) * dirMultiplier
    );
  }, [filteredDocuments, sortBy, sortDir, treeData, applyProjectFilters]);

  // Build flat items for filtered views
  const flatItems: DocumentRowItem[] = useMemo(() => {
    let items: DocumentRowItem[] = filteredDocuments.map(toRowItem);
    // Apply project filters (assignee, status, priority, date)
    if (applyProjectFilters) {
      items = applyProjectFilters(items);
    }
    if (sortBy) {
      const config = ITEM_SORT_CONFIGS[sortBy];
      if (config) {
        return sortTableData(items, sortBy, ITEM_SORT_CONFIGS, sortDir);
      }
    }
    return items;
  }, [filteredDocuments, sortBy, sortDir, applyProjectFilters]);

  // Build sections when a grouping mode is active
  const groupedSections: GroupedSection[] = useMemo(() => {
    if (groupBy === GroupByMode.None) {
      return [];
    }
    if (isGroupedView) {
      return groupDisplayGroupsByMode(groups, groupBy);
    }
    return groupFlatItemsByMode(flatItems, groupBy);
  }, [groupBy, isGroupedView, groups, flatItems]);

  const renderedItems = useMemo((): DocumentRowItem[] => {
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
  }, [
    groupBy,
    groupedSections,
    isGroupedView,
    flatItems,
    groups,
    isGroupExpanded,
  ]);

  // When a child entity is moved to a different project, it leaves its parent's
  // project tree (parentMap is built from the current project's tree). To keep
  // the "Parent" column populated after a cross-project move, we query
  // entity-links for any item not already in parentMap and build a fallback
  // that surfaces the parent's title and href in the new project's table.
  const parentFallbackItems = useMemo(
    () =>
      renderedItems
        .filter((item) => !parentMap.has(item.data.id))
        .map((item) => ({
          id: item.data.id,
        })),
    [renderedItems, parentMap]
  );

  const fallbackParentMap = useParentFallbackMap(parentFallbackItems);

  const combinedParentMap = useMemo(() => {
    const map = new Map(parentMap);
    for (const [childId, parentInfo] of fallbackParentMap) {
      if (!map.has(childId)) {
        map.set(childId, parentInfo);
      }
    }
    return map;
  }, [parentMap, fallbackParentMap]);

  const isSourceEmpty = filteredDocuments.length === 0;
  const isPostFilterEmpty = renderedItems.length === 0;
  const shouldShowEmptyState =
    isSourceEmpty || (isFilterActive === true && isPostFilterEmpty);
  const hasAnyItems = documents.length > 0;

  // ---- Selection handlers ----

  function handleSelectionChange(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  // ---- Context menu handlers ----

  function handleMoreMenu(item: DocumentRowItem, anchor: HTMLElement) {
    setMenuState({ item, anchor });
  }

  function handleRequestDelete(item: DocumentRowItem) {
    setDeleteTarget(item);
    setDeleteDialogOpen(true);
    setMenuState(null);
  }

  function handleRequestMove(item: DocumentRowItem) {
    // Use the full, unfiltered tree data to find children so that active
    // view filters (e.g. "Documents only") do not hide children of a
    // different type and cause them to be left behind during a move.
    if (treeData) {
      const treeNode = treeData.nodes.find((n) => n.root.id === item.data.id);
      if (treeNode && treeNode.children.length > 0) {
        const rootProjectId =
          item.kind === "artifact" || item.kind === "feature"
            ? item.data.projectId
            : undefined;
        setMoveEntities([
          {
            id: item.data.id,
            projectId: rootProjectId,
          },
          ...treeNode.children.map((child) => ({
            id: child.id,
          })),
        ]);
        setMenuState(null);
        return;
      }
    }

    if (item.kind === "artifact" || item.kind === "feature") {
      setMoveEntity({
        id: item.data.id,
        projectId: item.data.projectId,
      });
    }
    setMenuState(null);
  }

  async function executeBulkDelete(
    performDelete: (item: DocumentRowItem) => Promise<boolean>
  ): Promise<boolean> {
    const itemsToDelete: DocumentRowItem[] = [];
    let hasMissing = false;
    for (const id of pendingBulkIds) {
      const doc = documents.find((d) => d.id === id);
      if (doc) {
        itemsToDelete.push(toRowItem(doc));
      } else {
        hasMissing = true;
      }
    }
    const results = await Promise.all(itemsToDelete.map(performDelete));
    const allDeleted = !hasMissing && results.every(Boolean);
    if (allDeleted) {
      setDeleteDialogOpen(false);
      setPendingBulkIds(new Set());
      setSelectedIds(new Set());
    }
    return allDeleted;
  }

  async function handleConfirmDelete(): Promise<boolean> {
    if (!onDelete) {
      return false;
    }
    setDeletePending(true);
    try {
      if (pendingBulkIds.size > 0) {
        return await executeBulkDelete(onDelete);
      }
      if (!deleteTarget) {
        return false;
      }
      const result = await onDelete(deleteTarget);
      if (result) {
        setDeleteDialogOpen(false);
        setDeleteTarget(null);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(deleteTarget.data.id);
          return next;
        });
      }
      return result;
    } finally {
      setDeletePending(false);
    }
  }

  function handleRequestBulkMove() {
    const entitiesToMove: { id: string; projectId?: string | null }[] = [];

    for (const id of selectedIds) {
      const doc = documents.find((d) => d.id === id);
      if (doc) {
        entitiesToMove.push({
          id: doc.id,
          projectId: doc.projectId,
        });
      }
    }

    if (entitiesToMove.length > 0) {
      setMoveEntities(entitiesToMove);
    }
  }

  // ---- Branches: render ExternalLinks instead of artifacts ----

  if (filterCategory === "branches") {
    return (
      <BranchesList
        isLoading={isLoadingTree}
        prNodes={collectPullRequestTreeEntries(treeData?.nodes ?? [])}
      />
    );
  }

  // ---- Empty state ----

  if (shouldShowEmptyState) {
    return (
      <DocumentsEmptyState
        hasAnyItems={hasAnyItems}
        isFilterActive={isFilterActive}
        onClearFilters={onClearFilters}
      />
    );
  }

  // ---- Table body rendering (extracted to avoid nested ternaries) ----

  function renderTableBody() {
    if (groupBy !== GroupByMode.None) {
      return groupedSections.map((section) => {
        const sectionOpen = isSectionExpanded(section.descriptor.key);
        return (
          <div key={section.descriptor.key}>
            <GroupSectionHeader
              count={section.groups.length}
              icon={sectionIcon(section.descriptor)}
              isOpen={sectionOpen}
              label={section.descriptor.label}
              onToggle={() => toggleSection(section.descriptor.key)}
            />
            {sectionOpen &&
              section.groups.map((group) =>
                isGroupedView ? (
                  <TreeGroupRows
                    combinedParentMap={combinedParentMap}
                    editHandlers={editHandlers}
                    group={group}
                    handleMoreMenu={handleMoreMenu}
                    handleSelectionChange={handleSelectionChange}
                    isGroupExpanded={isGroupExpanded}
                    key={group.groupKey}
                    selectedIds={selectedIds}
                    toggleGroup={toggleGroup}
                    visibleColumns={visibleColumns}
                  />
                ) : (
                  <DocumentRow
                    editHandlers={editHandlers}
                    isSelected={selectedIds.has(group.root.data.id)}
                    item={group.root}
                    key={group.root.data.id}
                    onMoreMenu={handleMoreMenu}
                    onSelectionChange={handleSelectionChange}
                    parentHref={combinedParentMap.get(group.root.data.id)?.href}
                    parentTitle={
                      combinedParentMap.get(group.root.data.id)?.title
                    }
                    showCheckbox={showCheckbox}
                    visibleColumns={visibleColumns}
                  />
                )
              )}
          </div>
        );
      });
    }

    if (isGroupedView) {
      return groups.map((group) => (
        <TreeGroupRows
          combinedParentMap={combinedParentMap}
          editHandlers={editHandlers}
          group={group}
          handleMoreMenu={handleMoreMenu}
          handleSelectionChange={handleSelectionChange}
          isGroupExpanded={isGroupExpanded}
          key={group.groupKey}
          selectedIds={selectedIds}
          toggleGroup={toggleGroup}
          visibleColumns={visibleColumns}
        />
      ));
    }

    return flatItems.map((item) => (
      <DocumentRow
        editHandlers={editHandlers}
        isSelected={selectedIds.has(item.data.id)}
        item={item}
        key={item.data.id}
        onMoreMenu={handleMoreMenu}
        onSelectionChange={handleSelectionChange}
        parentHref={combinedParentMap.get(item.data.id)?.href}
        parentTitle={combinedParentMap.get(item.data.id)?.title}
        showCheckbox={showCheckbox}
        visibleColumns={visibleColumns}
      />
    ));
  }

  return (
    <>
      <div>
        <DocumentTableHeader
          onSort={(col, dir) => setSort(col as SortColumn, dir)}
          sortBy={sortBy}
          sortDir={sortDir}
          visibleColumns={visibleColumns}
        />
        {renderTableBody()}

        {/* Floating selection bar */}
        {selectedIds.size > 0 && (
          <div className="pointer-events-none sticky bottom-3 z-50 mt-4 flex justify-center">
            <div className="pointer-events-auto flex items-center gap-4 rounded-2xl border bg-background px-[18px] py-3 shadow-md">
              <span className="shrink-0 font-medium text-muted-foreground text-xs">
                {selectedIds.size} {selectedIds.size === 1 ? "item" : "items"}{" "}
                selected
              </span>
              <div className="flex items-center gap-2">
                <Button
                  className="h-8 text-xs"
                  onClick={() => setSelectedIds(new Set())}
                  size="sm"
                  variant="outline"
                >
                  Clear Selected
                </Button>
                {selectedDocumentsForMerge && (
                  <Button
                    className="h-8 text-xs"
                    onClick={() => {
                      setMergeError(null);
                      setMergeDialogOpen(true);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <MergeIcon className="h-4 w-4" />
                    Merge
                  </Button>
                )}
                {canBulkMove && (
                  <Button
                    className="h-8 text-xs"
                    onClick={handleRequestBulkMove}
                    size="sm"
                    variant="outline"
                  >
                    <Layers2Icon className="h-4 w-4" />
                    Move to Project
                  </Button>
                )}
                <Button
                  className="h-8 text-xs"
                  onClick={() => {
                    setPendingBulkIds(new Set(selectedIds));
                    setDeleteDialogOpen(true);
                  }}
                  size="sm"
                  variant="outline"
                >
                  <TrashIcon className="h-4 w-4" />
                  Delete
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Context menu dropdown (anchored to the more-menu button via virtual ref) */}
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) {
            setMenuState(null);
          }
        }}
        open={menuState !== null}
      >
        <DropdownMenuTrigger asChild>
          <span
            className="pointer-events-none fixed"
            ref={(node) => {
              if (node && menuState?.anchor) {
                const rect = menuState.anchor.getBoundingClientRect();
                node.style.top = `${rect.top}px`;
                node.style.left = `${rect.left}px`;
                node.style.width = `${rect.width}px`;
                node.style.height = `${rect.height}px`;
              }
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {(menuState?.item.kind === "artifact" ||
            menuState?.item.kind === "feature") && (
            <DropdownMenuItem onClick={() => handleRequestMove(menuState.item)}>
              <Layers2Icon className="h-4 w-4" />
              Move to Project
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() => {
              if (menuState) {
                handleRequestDelete(menuState.item);
              }
            }}
            variant="destructive"
          >
            <TrashIcon className="h-4 w-4 text-destructive" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Delete confirmation */}
      <DeleteConfirmationDialog
        isPending={deletePending}
        itemName={deleteTarget ? getItemTitle(deleteTarget) : ""}
        onConfirm={handleConfirmDelete}
        onOpenChange={setDeleteDialogOpen}
        open={deleteDialogOpen}
        title={deleteTarget?.kind === "artifact" ? "Document" : "Feature"}
      />

      {/* Move entity dialog */}
      {moveEntity && (
        <MoveEntityDialog
          currentProjectId={projectId}
          entity={moveEntity}
          onOpenChange={(open) => {
            if (!open) {
              setMoveEntity(null);
            }
          }}
          open={moveEntity !== null}
          teamId={teamId}
        />
      )}
      {moveEntities.length > 0 && (
        <MoveEntityDialog
          currentProjectId={projectId}
          entities={moveEntities}
          onOpenChange={(open) => {
            if (!open) {
              setMoveEntities([]);
            }
          }}
          onSuccess={() => {
            setSelectedIds(new Set());
            setMoveEntities([]);
          }}
          open={moveEntities.length > 0}
          teamId={teamId}
        />
      )}

      {/* Merge artifacts dialog */}
      {selectedDocumentsForMerge && (
        <MergeDocumentsDialog
          artifacts={selectedDocumentsForMerge}
          error={mergeError}
          isPending={mergeMutation.isPending}
          onConfirm={async (primaryId, secondaryId) => {
            setMergeError(null);
            try {
              await mergeMutation.mutateAsync({
                primaryDocumentId: primaryId,
                secondaryDocumentId: secondaryId,
              });
              setMergeDialogOpen(false);
              setSelectedIds(new Set());
            } catch (err) {
              setMergeError(
                err instanceof Error ? err.message : "Failed to merge artifacts"
              );
            }
          }}
          onOpenChange={setMergeDialogOpen}
          open={mergeDialogOpen}
        />
      )}
    </>
  );
}

function isArtifactTreeEntity(
  entity: TreeEntity
): entity is Extract<TreeEntity, { slug: string; type: DocumentType }> {
  return "slug" in entity && "type" in entity;
}

// ---- Tree group rows (shared between grouped and status-grouped views) ----

function TreeGroupRows({
  group,
  editHandlers,
  isGroupExpanded,
  toggleGroup,
  selectedIds,
  handleSelectionChange,
  handleMoreMenu,
  combinedParentMap,
  visibleColumns,
}: {
  group: DisplayGroup;
  editHandlers?: RowEditHandlers;
  isGroupExpanded: (key: string) => boolean;
  toggleGroup: (key: string) => void;
  selectedIds: Set<string>;
  handleSelectionChange: (id: string, checked: boolean) => void;
  handleMoreMenu: (item: DocumentRowItem, anchor: HTMLElement) => void;
  combinedParentMap: Map<string, { title: string; href: string | null }>;
  visibleColumns: DocumentColumn[];
}) {
  const { root, children } = group;
  const isOpen = isGroupExpanded(group.groupKey);
  const hasChildren = children.length > 0;
  return (
    <div key={group.groupKey}>
      <DocumentRow
        editHandlers={editHandlers}
        isExpanded={hasChildren ? isOpen : false}
        isSelected={selectedIds.has(root.data.id)}
        item={root}
        onMoreMenu={handleMoreMenu}
        onSelectionChange={handleSelectionChange}
        onToggleExpand={
          hasChildren ? () => toggleGroup(group.groupKey) : undefined
        }
        parentHref={combinedParentMap.get(root.data.id)?.href}
        parentTitle={combinedParentMap.get(root.data.id)?.title}
        showCheckbox={false}
        visibleColumns={visibleColumns}
      />
      {isOpen &&
        children.map((child, childIndex) => (
          <DocumentRow
            editHandlers={editHandlers}
            extendIndentedBottomBorderLeft={childIndex === children.length - 1}
            indented
            isSelected={selectedIds.has(child.data.id)}
            item={child}
            key={child.data.id}
            onMoreMenu={handleMoreMenu}
            onSelectionChange={handleSelectionChange}
            parentHref={combinedParentMap.get(child.data.id)?.href}
            parentTitle={combinedParentMap.get(child.data.id)?.title}
            showCheckbox={false}
            visibleColumns={visibleColumns}
          />
        ))}
    </div>
  );
}

// ---- Branches list (ExternalLinks with type=PULL_REQUEST) ----

function BranchesList({
  isLoading,
  prNodes,
}: {
  isLoading: boolean;
  prNodes: PrTreeEntry[];
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (prNodes.length === 0) {
    return (
      <EmptyState
        description="No pull requests linked to this project yet."
        icon={GitPullRequestIcon}
        title="No branches"
      />
    );
  }

  return (
    <div className="flex flex-col">
      {prNodes.map((node) => (
        <Link
          className="flex items-center gap-3 border-border border-b px-4 py-3 transition-colors hover:bg-accent/50"
          href={`/build/${node.id}`}
          key={node.id}
        >
          <GitPullRequestIcon className="h-4 w-4 shrink-0 text-emerald-500" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-medium text-foreground text-sm">
              {node.title}
            </span>
            {node.externalUrl ? (
              <span className="truncate text-muted-foreground text-xs">
                {node.externalUrl}
              </span>
            ) : null}
          </div>
          <ExternalLinkIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Link>
      ))}
    </div>
  );
}

type PrTreeEntry = {
  id: string;
  title: string;
  externalUrl: string;
};

function collectPullRequestTreeEntries(nodes: TreeNode[]): PrTreeEntry[] {
  const seen = new Set<string>();
  const out: PrTreeEntry[] = [];
  for (const node of nodes) {
    for (const entity of [node.root, ...node.children]) {
      if (!isPullRequestTreeEntity(entity) || seen.has(entity.id)) {
        continue;
      }
      seen.add(entity.id);
      out.push({
        id: entity.id,
        title: entity.title,
        externalUrl: entity.externalUrl,
      });
    }
  }
  return out;
}

function isPullRequestTreeEntity(
  entity: TreeEntity
): entity is Extract<TreeEntity, { externalUrl: string }> {
  return entity.entityType === TreeEntityType.ExternalLink;
}

function DocumentsEmptyState({
  hasAnyItems,
  isFilterActive,
  onClearFilters,
}: {
  hasAnyItems: boolean;
  isFilterActive?: boolean;
  onClearFilters?: () => void;
}) {
  if (!hasAnyItems) {
    return (
      <EmptyState
        description="Create a PRD, feature, or plan to get started."
        icon={FileTextIcon}
        title="No artifacts yet"
      />
    );
  }
  if (isFilterActive) {
    return (
      <EmptyState
        action={
          onClearFilters ? (
            <Button onClick={onClearFilters} size="sm" variant="outline">
              Clear filters
            </Button>
          ) : undefined
        }
        description="Try adjusting your filters or search term."
        icon={FilterXIcon}
        title="No items match your filters"
      />
    );
  }
  return (
    <EmptyState
      description="Try adjusting your filter or search term."
      icon={FileTextIcon}
      title="No matching artifacts"
    />
  );
}
