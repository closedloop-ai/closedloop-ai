"use client";

import { type Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import {
  DocumentType,
  type DocumentWithWorkstream,
} from "@repo/api/src/types/document";
import type {
  ProjectTreeResponse,
  TreeNode,
} from "@repo/api/src/types/project-tree";
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
import {
  type DisplayGroup,
  getItemTitle,
  groupByProjectTree,
  groupByWorkstream,
  isDocumentArtifact,
  isFeatureDoc,
  toDisplayGroups,
  toRowItem,
} from "@/components/document-table/document-tree";
import type { FilterCategory } from "@/components/document-table/filter-category";
import { GroupSectionHeader } from "@/components/document-table/group-section-header";
import { DocumentTableHeader } from "@/components/document-table/table-header";
import { TreeGroupRows } from "@/components/document-table/tree-group-rows";
import { EmptyState } from "@/components/empty-state";
import { MoveEntityDialog } from "@/components/move-entity-dialog";
import { useMergeDocuments } from "@/hooks/queries/use-documents";
import { useProjectTree } from "@/hooks/queries/use-project-tree";
import type { DocumentColumn } from "@/hooks/use-column-visibility";
import { useGroupExpansion } from "@/hooks/use-group-expansion";
import { useSortParams } from "@/hooks/use-sort-params";
import { matchesFilter } from "@/lib/document-filter";
import { getArtifactRoute } from "@/lib/document-navigation";
import {
  GroupByMode,
  type GroupByNonNone,
  type GroupSectionDescriptor,
  groupByMode,
} from "@/lib/group-by";
import { comparePriorityValues } from "@/lib/priority-sort";
import { DOCUMENT_STATUS_TO_ICON } from "@/lib/project-constants";
import {
  addNodeParentEntries,
  type ParentEntry,
} from "@/lib/project-tree-utils";
import type { SortConfig } from "@/lib/table-utils";
import { sortTableData } from "@/lib/table-utils";
import { compareAssigneeNames } from "@/lib/user-utils";
import { MergeDocumentsDialog } from "./merge-documents-dialog";

export type DocumentsViewProps = {
  documents: DocumentWithWorkstream[];
  /** Single-project mode: projectId + teamId scope to this project. */
  projectId?: string;
  teamId?: string;
  /**
   * When provided, skip the internal `useProjectTree` fetch and use this tree
   * instead. Required for multi-project mode (when `projectId` is absent).
   */
  treeData?: ProjectTreeResponse | null;
  /** Loading state for externally-provided tree data. */
  isTreeDataLoading?: boolean;
  /**
   * Storage key prefix for group expansion state. Defaults to
   * `project-artifacts:${projectId}` in single-project mode; required when
   * `projectId` is absent.
   */
  storageKey?: string;
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
// ---- Filter items by category ----

function buildParentMap(
  treeData: ProjectTreeResponse | null
): Map<string, ParentEntry> {
  const map = new Map<string, ParentEntry>();
  if (!treeData) {
    return map;
  }
  for (const node of treeData.nodes) {
    addNodeParentEntries(node, map);
  }
  for (const entry of treeData.externalParents) {
    if (map.has(entry.childId) || !isDocumentArtifact(entry.parent)) {
      continue;
    }
    map.set(entry.childId, {
      title: entry.parent.name,
      href: getArtifactRoute(entry.parent),
    });
  }
  return map;
}

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

const SORT_COLUMNS = [
  "title",
  "type",
  "dueDate",
  "assignee",
  "priority",
  "score",
] as const;

type SortColumn = (typeof SORT_COLUMNS)[number];

function getItemSortType(item: DocumentRowItem): string {
  if (item.kind === "artifact" || item.kind === "branch") {
    return item.data.type;
  }
  return "FEATURE";
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: orchestrator component
export function DocumentsView({
  documents,
  projectId,
  teamId,
  treeData: providedTreeData,
  isTreeDataLoading,
  storageKey,
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
  const expansionKey = storageKey ?? `project-artifacts:${projectId ?? "all"}`;
  const { isExpanded: isGroupExpanded, toggleGroup } = useGroupExpansion(
    `table:expand:${expansionKey}`
  );
  const { isExpanded: isSectionExpanded, toggleGroup: toggleSection } =
    useGroupExpansion(`table:expand:${expansionKey}-group-sections`, {
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

  const selectedDocumentsForMerge = useMemo(
    () => findMergeCandidates(selectedIds, documents),
    [selectedIds, documents]
  );

  // Single-project mode fetches the tree internally; multi-project consumers
  // pass a pre-merged `treeData` and skip the fetch.
  const fetchedTree = useProjectTree(projectId ?? "", {
    enabled: !!projectId && providedTreeData === undefined,
  });
  const { treeData, isLoadingTree } = resolveTreeData(
    providedTreeData,
    isTreeDataLoading,
    fetchedTree.data,
    fetchedTree.isLoading
  );

  // Build parent map: child entity id → immediate parent title + route.
  // Uses depth field from TreeChild to find the correct immediate parent for each
  // descendant, rather than mapping all descendants to the root.
  // Cross-project parents (returned in `treeData.externalParents`) fill in for
  // items whose parent lives outside this project.
  const parentMap = useMemo(() => buildParentMap(treeData ?? null), [treeData]);

  // Build groups for "All" view, sorted by root item when a sort is active.
  // Uses project tree structure when available; falls back to workstream grouping while loading.
  const groups: DisplayGroup[] = useMemo(
    () =>
      buildSortedGroups({
        treeData: treeData ?? null,
        filteredDocuments,
        applyProjectFilters,
        sortBy,
        sortDir,
      }),
    [filteredDocuments, sortBy, sortDir, treeData, applyProjectFilters]
  );

  // Build flat items for filtered views
  const flatItems: DocumentRowItem[] = useMemo(
    () =>
      buildFlatItems(filteredDocuments, applyProjectFilters, sortBy, sortDir),
    [filteredDocuments, sortBy, sortDir, applyProjectFilters]
  );

  // Build sections when a grouping mode is active
  const groupedSections: GroupedSection[] = useMemo(
    () => buildGroupedSections(groupBy, isGroupedView, groups, flatItems),
    [groupBy, isGroupedView, groups, flatItems]
  );

  const renderedItems = useMemo(
    (): DocumentRowItem[] =>
      buildRenderedItems({
        groupBy,
        groupedSections,
        isGroupedView,
        flatItems,
        groups,
        isGroupExpanded,
      }),
    [
      groupBy,
      groupedSections,
      isGroupedView,
      flatItems,
      groups,
      isGroupExpanded,
    ]
  );

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
    const move = computeMoveEntities(item, treeData);
    if (move.kind === "bulk") {
      setMoveEntities(move.entities);
    } else if (move.kind === "single") {
      setMoveEntity(move.entity);
    }
    setMenuState(null);
  }

  async function executeBulkDelete(
    performDelete: (item: DocumentRowItem) => Promise<boolean>
  ): Promise<boolean> {
    const allDeleted = await runBulkDelete(
      pendingBulkIds,
      documents,
      performDelete
    );
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
    const entitiesToMove = collectBulkMoveEntities(selectedIds, documents);
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
                    editHandlers={editHandlers}
                    group={group}
                    handleMoreMenu={handleMoreMenu}
                    handleSelectionChange={handleSelectionChange}
                    isGroupExpanded={isGroupExpanded}
                    key={group.groupKey}
                    parentMap={parentMap}
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
                    parentHref={parentMap.get(group.root.data.id)?.href}
                    parentTitle={parentMap.get(group.root.data.id)?.title}
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
          editHandlers={editHandlers}
          group={group}
          handleMoreMenu={handleMoreMenu}
          handleSelectionChange={handleSelectionChange}
          isGroupExpanded={isGroupExpanded}
          key={group.groupKey}
          parentMap={parentMap}
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
        parentHref={parentMap.get(item.data.id)?.href}
        parentTitle={parentMap.get(item.data.id)?.title}
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
          {menuState?.item.kind !== "branch" && (
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
          )}
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

// ---- Branches list (PR + Deployment artifacts) ----

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
      if (!isExternalLinkArtifact(entity)) {
        continue;
      }
      if (seen.has(entity.id) || !entity.externalUrl) {
        continue;
      }
      seen.add(entity.id);
      out.push({
        id: entity.id,
        title: entity.name,
        externalUrl: entity.externalUrl,
      });
    }
  }
  return out;
}

function isExternalLinkArtifact(artifact: Artifact): boolean {
  return (
    artifact.type === ArtifactType.PullRequest ||
    artifact.type === ArtifactType.Deployment
  );
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

function collectBulkMoveEntities(
  selectedIds: Set<string>,
  documents: DocumentWithWorkstream[]
): MovableEntity[] {
  const entities: MovableEntity[] = [];
  for (const id of selectedIds) {
    const doc = documents.find((d) => d.id === id);
    if (doc) {
      entities.push({ id: doc.id, projectId: doc.projectId });
    }
  }
  return entities;
}

async function runBulkDelete(
  pendingIds: Set<string>,
  documents: DocumentWithWorkstream[],
  performDelete: (item: DocumentRowItem) => Promise<boolean>
): Promise<boolean> {
  const itemsToDelete: DocumentRowItem[] = [];
  let hasMissing = false;
  for (const id of pendingIds) {
    const doc = documents.find((d) => d.id === id);
    if (doc) {
      itemsToDelete.push(toRowItem(doc));
    } else {
      hasMissing = true;
    }
  }
  const results = await Promise.all(itemsToDelete.map(performDelete));
  return !hasMissing && results.every(Boolean);
}

type MovableEntity = { id: string; projectId?: string | null };

type MoveResolution =
  | { kind: "bulk"; entities: MovableEntity[] }
  | { kind: "single"; entity: MovableEntity }
  | { kind: "none" };

/**
 * Resolve a move action for a single item. If the item is the root of a tree
 * with children, all entities (root + children) move together; the root's
 * projectId scopes the destination filter. Otherwise a single document/feature
 * is moved.
 */
function computeMoveEntities(
  item: DocumentRowItem,
  treeData: ProjectTreeResponse | null | undefined
): MoveResolution {
  if (!(item.kind === "artifact" || item.kind === "feature")) {
    return { kind: "none" };
  }
  const descendantIds = collectDescendantIds(item.data.id, treeData ?? null);
  if (descendantIds.length > 0) {
    const entities: MovableEntity[] = [
      { id: item.data.id, projectId: item.data.projectId },
      ...descendantIds.map((id) => ({ id })),
    ];
    return { kind: "bulk", entities };
  }
  return {
    kind: "single",
    entity: { id: item.data.id, projectId: item.data.projectId },
  };
}

/**
 * Walk the tree starting at `rootId` and return every transitive descendant
 * id. Works whether `rootId` is a TreeNode root or any nested child — uses
 * the flat children list's `parentId` chain to traverse the subtree.
 */
function collectDescendantIds(
  rootId: string,
  treeData: ProjectTreeResponse | null
): string[] {
  if (!treeData) {
    return [];
  }
  const node = treeData.nodes.find(
    (n) => n.root.id === rootId || n.children.some((c) => c.id === rootId)
  );
  if (!node) {
    return [];
  }
  const descendants: string[] = [];
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    for (const child of node.children) {
      if (child.parentId === parentId) {
        descendants.push(child.id);
        queue.push(child.id);
      }
    }
  }
  return descendants;
}

/**
 * Returns the pair of documents to merge when exactly two documents are
 * selected. Returns null otherwise. The merge service rejects Templates
 * server-side (`Cannot merge TEMPLATE artifacts`); other type combinations
 * including Features are allowed.
 */
function findMergeCandidates(
  selectedIds: Set<string>,
  documents: DocumentWithWorkstream[]
): [DocumentWithWorkstream, DocumentWithWorkstream] | null {
  if (selectedIds.size !== 2) {
    return null;
  }
  const ids = Array.from(selectedIds);
  const d1 = documents.find((d) => d.id === ids[0]);
  const d2 = documents.find((d) => d.id === ids[1]);
  if (d1 && d2) {
    return [d1, d2];
  }
  return null;
}

function resolveTreeData(
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
 * structure when available; falls back to workstream grouping while loading.
 * Project filters are applied to root items only — children are preserved.
 */
function buildSortedGroups({
  treeData,
  filteredDocuments,
  applyProjectFilters,
  sortBy,
  sortDir,
}: {
  treeData: ProjectTreeResponse | null;
  filteredDocuments: DocumentWithWorkstream[];
  applyProjectFilters?: (items: DocumentRowItem[]) => DocumentRowItem[];
  sortBy: SortColumn | null;
  sortDir: "asc" | "desc";
}): DisplayGroup[] {
  const ungrouped: DisplayGroup[] = treeData
    ? groupByProjectTree(treeData.nodes, filteredDocuments)
    : toDisplayGroups(groupByWorkstream(filteredDocuments));

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
}

/** Build the flat (filtered + sorted) DocumentRowItem list for filtered views. */
function buildFlatItems(
  filteredDocuments: DocumentWithWorkstream[],
  applyProjectFilters:
    | ((items: DocumentRowItem[]) => DocumentRowItem[])
    | undefined,
  sortBy: SortColumn | null,
  sortDir: "asc" | "desc"
): DocumentRowItem[] {
  let items: DocumentRowItem[] = filteredDocuments.map(toRowItem);
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
}

/** Build grouped sections when a grouping mode (status/assignee/priority) is active. */
function buildGroupedSections(
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

/** Flatten the grouping output into the final ordered row list for rendering. */
function buildRenderedItems({
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
