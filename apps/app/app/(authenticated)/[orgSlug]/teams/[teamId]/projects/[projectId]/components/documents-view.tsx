"use client";

import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ArtifactType } from "@repo/api/src/types/artifact";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { MoveEntityDialog } from "@repo/app/documents/components/move-entity-dialog";
import { BulkStatusPicker } from "@repo/app/documents/components/table/bulk-status-picker";
import { BulkTagPicker } from "@repo/app/documents/components/table/bulk-tag-picker";
import {
  DocumentRow,
  type DocumentRowItem,
} from "@repo/app/documents/components/table/document-row";
import {
  collectArtifactRowItems,
  getItemTitle,
  toRowItem,
} from "@repo/app/documents/components/table/document-tree";
import { DocumentsEmptyState } from "@repo/app/documents/components/table/documents-empty-state";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import { sectionIcon } from "@repo/app/documents/components/table/group-section-icon";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import {
  getRowTypeConfig,
  type RowTypeConfig,
} from "@repo/app/documents/components/table/row-type-registry";
import {
  RankInteractionMode,
  SORT_KEYS,
  SortKey,
} from "@repo/app/documents/components/table/sort-keys";
import { DocumentTableHeader } from "@repo/app/documents/components/table/table-header";
import { TreeGroupRows } from "@repo/app/documents/components/table/tree-group-rows";
import { useMergeDocuments } from "@repo/app/documents/hooks/use-documents";
import { useDocumentsViewState } from "@repo/app/documents/hooks/use-documents-view-state";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  collectBulkMoveEntities,
  computeMoveEntities,
  findMergeCandidates,
  runBulkDelete,
} from "@repo/app/documents/lib/table-row-actions";
import {
  buildFlatItems,
  buildGroupedSections,
  buildParentMap,
  buildRenderedItems,
  buildSortedGroups,
  filterByCategory,
  resolveTreeData,
  treeHasRenderableArtifacts,
} from "@repo/app/documents/lib/table-view-pipeline";
import { useProjectTree } from "@repo/app/projects/hooks/use-project-tree";
import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import { DndProvider } from "@repo/app/shared/components/dnd-provider";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import type { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { useGroupExpansion } from "@repo/app/shared/hooks/use-group-expansion";
import { useSortParams } from "@repo/app/shared/hooks/use-sort-params";
import { STACK_RANK_PROJECT_PAGE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { NAME_SORT_OPTIONS } from "@repo/app/shared/lib/sort-comparators";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { GroupSectionHeader } from "@repo/design-system/components/ui/group-section-header";
import {
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  GitPullRequestIcon,
  Layers2Icon,
  Loader2,
  MergeIcon,
  TrashIcon,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { useContextGroupExpansion } from "../hooks/use-context-group-expansion";
import { useStackRanking } from "../hooks/use-stack-ranking";
import { MergeDocumentsDialog } from "./merge-documents-dialog";

export type DocumentsViewProps = {
  documents: DocumentRowData[];
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
  /**
   * When set, the "branches" category only shows pull requests whose
   * `assigneeId` matches this id. Used by My Tasks to hide unassigned PRs
   * and PRs assigned to other users from the current user's view.
   */
  branchAssigneeFilter?: string | null;
  /** localStorage key for sort state persistence. */
  sortPersistenceKey?: string;
};

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
  branchAssigneeFilter,
  sortPersistenceKey,
}: DocumentsViewProps) {
  const orgSlug = useOrgSlug();
  const expansionKey = storageKey ?? `project-artifacts:${projectId ?? "all"}`;
  const { isExpanded: isGroupExpanded, toggleGroup } = useGroupExpansion(
    `table:expand:${expansionKey}`
  );
  const { isExpanded: isSectionExpanded, toggleGroup: toggleSection } =
    useGroupExpansion(`table:expand:${expansionKey}-group-sections`, {
      defaultExpanded: true,
    });

  // Selection, context menu, and delete/move/merge dialog state (PLN-874
  // Phase 3: one reducer instead of ten useState calls). Destructured to
  // const bindings so TypeScript narrowing survives into event closures.
  const { state, actions } = useDocumentsViewState();
  const {
    selectedIds,
    menuState,
    deleteTarget,
    pendingBulkIds,
    deleteDialogOpen,
    deletePending,
    moveEntity,
    moveEntities,
    mergeDialogOpen,
    mergeError,
  } = state;

  // Clear selection when filter category changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when filterCategory changes
  useEffect(() => {
    actions.clearSelection();
  }, [filterCategory]);

  const mergeMutation = useMergeDocuments();

  // PLN-755 Phase D: when the `stack-rank-project-page` flag is on, default
  // the page to "Stack rank ASC" so a no-params URL renders the canonical
  // server-supplied ordering. Flag-off keeps the legacy null default so the
  // existing column-header sort UX is unchanged for users not yet in the
  // rollout. URL params (set by clicking column headers) still take
  // precedence over the default in both branches.
  const isStackRankEnabled = useFeatureFlagEnabled(
    STACK_RANK_PROJECT_PAGE_FEATURE_FLAG_KEY
  );
  const { sortBy, sortDir, setSort, clearSort } = useSortParams<SortKey>({
    validColumns: SORT_KEYS,
    defaultColumn: isStackRankEnabled ? SortKey.StackRank : null,
    defaultDirection: "asc",
    persistenceKey: sortPersistenceKey,
  });

  const filteredDocuments = useMemo(
    () => filterByCategory(documents, filterCategory, filterText),
    [documents, filterCategory, filterText]
  );

  const isGroupedView = filterCategory === "all";
  // Branch rows have no bulk operations (no merge/move/batch-delete), so the
  // Branches tab renders without selection checkboxes.
  const showCheckbox = !isGroupedView && filterCategory !== "branches";
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
  const parentMap = useMemo(
    () => buildParentMap(treeData ?? null, orgSlug),
    [treeData, orgSlug]
  );

  // Build groups for "All" view, sorted by root item when a sort is active.
  // Uses project tree structure when available; falls back to per-document
  // flat grouping while loading. `contextExpandedIds` are nodes kept only as
  // context for a matching descendant — they must be force-expanded so that
  // descendant is visible despite tree groups defaulting to collapsed.
  const { groups, contextExpandedIds } = useMemo(
    () =>
      buildSortedGroups({
        treeData: treeData ?? null,
        // Full set, not `filteredDocuments`: buildSortedGroups applies the
        // search text itself so branch/session rows nested under a
        // non-matching document ancestor stay reachable (FEA-1763 Phase 3).
        documents,
        applyProjectFilters,
        filterText,
        sortBy,
        sortDir,
      }),
    [documents, filterText, sortBy, sortDir, treeData, applyProjectFilters]
  );

  // Nodes retained only as filter context default to expanded so the matching
  // descendant is visible, while explicit user collapses still win.
  const { isTreeGroupExpanded, toggleTreeGroup } = useContextGroupExpansion({
    contextExpandedIds,
    isGroupExpanded,
    toggleGroup,
  });

  // Branches tab: branch artifacts come from the project tree, not the
  // documents list. They are collected flat and run through the same
  // filter/sort pipeline as the document categories (FEA-1763 Phase 2).
  const branchItems: DocumentRowItem[] = useMemo(() => {
    if (filterCategory !== "branches") {
      return [];
    }
    let items = collectArtifactRowItems(
      treeData?.nodes ?? [],
      ArtifactType.Branch
    );
    const text = filterText.trim().toLowerCase();
    if (text) {
      items = items.filter((item) =>
        getItemTitle(item).toLowerCase().includes(text)
      );
    }
    if (branchAssigneeFilter) {
      items = items.filter(
        (item) => item.data.assigneeId === branchAssigneeFilter
      );
    }
    return items;
  }, [filterCategory, treeData, filterText, branchAssigneeFilter]);

  // Build flat items for filtered views
  const flatItems: DocumentRowItem[] = useMemo(
    () =>
      buildFlatItems(
        filterCategory === "branches"
          ? branchItems
          : filteredDocuments.map(toRowItem),
        applyProjectFilters,
        sortBy,
        sortDir
      ),
    [
      filterCategory,
      branchItems,
      filteredDocuments,
      sortBy,
      sortDir,
      applyProjectFilters,
    ]
  );

  // Build sections when a grouping mode is active
  const groupedSections = useMemo(
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
        isGroupExpanded: isTreeGroupExpanded,
      }),
    [
      groupBy,
      groupedSections,
      isGroupedView,
      flatItems,
      groups,
      isTreeGroupExpanded,
    ]
  );

  // PLN-755 (PRD-421): all stack-rank interaction state and actions. See
  // `useStackRanking` for why the surface is gated to the "all" tree view.
  const {
    rankInteractionMode,
    isDndEnabled,
    rankItemIds,
    isRankableMenuItem,
    moveToTop,
    moveToBottom,
    handleDragEnd,
  } = useStackRanking({
    isStackRankEnabled,
    projectId,
    filterCategory,
    sortBy,
    groupBy,
    isGroupedView,
    groups,
    flatItems,
    renderedItems,
  });

  useEffect(() => {
    actions.pruneSelection(
      new Set(renderedItems.map((i: DocumentRowItem) => i.data.id))
    );
  }, [renderedItems, actions]);

  // Emptiness is derived from renderable rows, not the documents list alone:
  // a project containing only branch/session artifacts still renders its tree
  // (pre-existing gap fixed in PLN-874 Phase 3).
  const isSourceEmpty = computeIsSourceEmpty({
    filterCategory,
    isGroupedView,
    groupCount: groups.length,
    branchItemCount: branchItems.length,
    filteredDocumentCount: filteredDocuments.length,
  });
  const isPostFilterEmpty = renderedItems.length === 0;
  const shouldShowEmptyState =
    isSourceEmpty || (isFilterActive === true && isPostFilterEmpty);
  const hasAnyItems =
    documents.length > 0 || treeHasRenderableArtifacts(treeData);

  // ---- Selection handlers ----

  const selectMode = selectedIds.size > 0;
  const allSelected =
    showCheckbox &&
    renderedItems.length > 0 &&
    selectedIds.size === renderedItems.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  function handleSelectAll(checked: boolean) {
    if (checked) {
      actions.replaceSelection(
        new Set(renderedItems.map((i: DocumentRowItem) => i.data.id))
      );
    } else {
      actions.clearSelection();
    }
  }

  // ---- Context menu / dialog handlers ----

  function handleRequestMove(item: DocumentRowItem) {
    actions.requestMove(computeMoveEntities(item, treeData));
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
      actions.markBulkDeleteSucceeded();
    }
    return allDeleted;
  }

  async function handleConfirmDelete(): Promise<boolean> {
    if (!onDelete) {
      return false;
    }
    actions.setDeletePending(true);
    try {
      if (pendingBulkIds.size > 0) {
        return await executeBulkDelete(onDelete);
      }
      if (!deleteTarget) {
        return false;
      }
      const result = await onDelete(deleteTarget);
      if (result) {
        actions.markDeleteSucceeded(deleteTarget.data.id);
      }
      return result;
    } finally {
      actions.setDeletePending(false);
    }
  }

  // ---- Branches: wait for the tree before declaring the list empty ----

  if (filterCategory === "branches" && isLoadingTree) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ---- Empty state ----

  if (shouldShowEmptyState) {
    if (filterCategory === "branches") {
      return (
        <EmptyState
          description="No pull requests linked to this project yet."
          icon={GitPullRequestIcon}
          title="No branches"
        />
      );
    }
    return (
      <DocumentsEmptyState
        hasAnyItems={hasAnyItems}
        isFilterActive={isFilterActive}
        onClearFilters={onClearFilters}
      />
    );
  }

  // ---- Table body rendering (extracted to avoid nested ternaries) ----

  // Flat category views (documents/features/plans) are never a rank surface
  // — `isRankSurface` requires the "all" view — so these rows carry no rank
  // affordance and render plain.
  function renderFlatRow(item: DocumentRowItem) {
    return (
      <DocumentRow
        editHandlers={editHandlers}
        isSelected={selectedIds.has(item.data.id)}
        item={item}
        key={item.data.id}
        onMoreMenu={actions.openMenu}
        onSelectionChange={actions.changeSelection}
        parentHref={parentMap.get(item.data.id)?.href}
        parentTitle={parentMap.get(item.data.id)?.title}
        selectMode={selectMode}
        showCheckbox={showCheckbox}
        visibleColumns={visibleColumns}
      />
    );
  }

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
                    handleMoreMenu={actions.openMenu}
                    handleSelectionChange={actions.changeSelection}
                    isGroupExpanded={isTreeGroupExpanded}
                    key={group.groupKey}
                    parentMap={parentMap}
                    rankInteractionMode={rankInteractionMode}
                    selectedIds={selectedIds}
                    toggleGroup={toggleTreeGroup}
                    visibleColumns={visibleColumns}
                  />
                ) : (
                  <DocumentRow
                    editHandlers={editHandlers}
                    isSelected={selectedIds.has(group.root.data.id)}
                    item={group.root}
                    key={group.root.data.id}
                    onMoreMenu={actions.openMenu}
                    onSelectionChange={actions.changeSelection}
                    parentHref={parentMap.get(group.root.data.id)?.href}
                    parentTitle={parentMap.get(group.root.data.id)?.title}
                    rankInteractionMode={rankInteractionMode}
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
          handleMoreMenu={actions.openMenu}
          handleSelectionChange={actions.changeSelection}
          isGroupExpanded={isTreeGroupExpanded}
          key={group.groupKey}
          parentMap={parentMap}
          rankInteractionMode={rankInteractionMode}
          selectedIds={selectedIds}
          toggleGroup={toggleTreeGroup}
          visibleColumns={visibleColumns}
        />
      ));
    }

    return flatItems.map(renderFlatRow);
  }

  // Wraps the body in `<DndProvider>` + `<SortableContext>` when stack-rank
  // drag is live; falls through to a bare fragment otherwise so the
  // non-rank surfaces incur zero dnd overhead.
  function renderRankableBody() {
    const body = renderTableBody();
    if (!isDndEnabled) {
      return body;
    }
    return (
      <DndProvider onDragEnd={handleDragEnd}>
        <SortableContext
          items={rankItemIds}
          strategy={verticalListSortingStrategy}
        >
          {body}
        </SortableContext>
      </DndProvider>
    );
  }

  const deleteDialogCopy = computeDeleteDialogCopy({
    bulkCount: pendingBulkIds.size,
    deleteTarget,
    config: deleteTarget ? getRowTypeConfig(deleteTarget) : null,
  });

  return (
    <>
      <div>
        {isFilterActive === true &&
          rankInteractionMode === RankInteractionMode.Enabled && (
            <div className="border-b bg-muted/40 px-4 py-2 text-muted-foreground text-xs">
              Reordering applies to the whole project, not just the current
              filter.
            </div>
          )}
        <DocumentTableHeader
          allSelected={allSelected}
          nameSortOptions={NAME_SORT_OPTIONS}
          onClearSort={clearSort}
          onSelectAll={handleSelectAll}
          onSort={(col, dir) => setSort(col as SortKey, dir)}
          showSelectAll={showCheckbox}
          someSelected={someSelected}
          sortBy={sortBy}
          sortDir={sortDir}
          visibleColumns={visibleColumns}
        />
        {renderRankableBody()}

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
                  onClick={actions.clearSelection}
                  size="sm"
                  variant="outline"
                >
                  Clear Selected
                </Button>
                {selectedDocumentsForMerge && (
                  <Button
                    className="h-8 text-xs"
                    onClick={actions.openMergeDialog}
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
                    onClick={() =>
                      actions.requestBulkMove(
                        collectBulkMoveEntities(selectedIds, documents)
                      )
                    }
                    size="sm"
                    variant="outline"
                  >
                    <Layers2Icon className="h-4 w-4" />
                    Move to Project
                  </Button>
                )}
                <BulkStatusPicker
                  onComplete={actions.clearSelection}
                  selectedIds={selectedIds}
                />
                <BulkTagPicker
                  onComplete={actions.clearSelection}
                  selectedIds={selectedIds}
                />
                <Button
                  className="h-8 text-xs"
                  onClick={actions.requestBulkDelete}
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
            actions.closeMenu();
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
          {isDndEnabled &&
            menuState !== null &&
            isRankableMenuItem(menuState.item) && (
              <>
                <DropdownMenuItem
                  onClick={() => {
                    moveToTop(menuState.item);
                    actions.closeMenu();
                  }}
                >
                  <ArrowUpToLineIcon className="h-4 w-4" />
                  Move to top
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    moveToBottom(menuState.item);
                    actions.closeMenu();
                  }}
                >
                  <ArrowDownToLineIcon className="h-4 w-4" />
                  Move to bottom
                </DropdownMenuItem>
              </>
            )}
          {menuState?.item.kind === "document" && (
            <DropdownMenuItem onClick={() => handleRequestMove(menuState.item)}>
              <Layers2Icon className="h-4 w-4" />
              Move to Project
            </DropdownMenuItem>
          )}
          {menuState &&
            getRowTypeConfig(menuState.item)?.deletable === true && (
              <DropdownMenuItem
                onClick={() => {
                  actions.requestDelete(menuState.item);
                }}
                variant="destructive"
              >
                <TrashIcon className="h-4 w-4 text-destructive" />
                Delete
              </DropdownMenuItem>
            )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Delete confirmation — heading/body copy comes from the row-type
          registry (PLN-874 Task 3.5). */}
      <DeleteConfirmationDialog
        description={deleteDialogCopy.description}
        isPending={deletePending}
        itemName={deleteDialogCopy.itemName}
        onConfirm={handleConfirmDelete}
        onOpenChange={actions.setDeleteDialogOpen}
        open={deleteDialogOpen}
        title={deleteDialogCopy.title}
      />

      {/* Move entity dialog */}
      {moveEntity && (
        <MoveEntityDialog
          currentProjectId={projectId}
          entity={moveEntity}
          onOpenChange={(open) => {
            if (!open) {
              actions.closeMoveDialog();
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
              actions.closeBulkMoveDialog();
            }
          }}
          onSuccess={actions.markBulkMoveSucceeded}
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
            // Clear any error from a prior attempt so the banner disappears
            // while this retry is in flight, not after it resolves.
            actions.clearMergeError();
            try {
              await mergeMutation.mutateAsync({
                primaryDocumentId: primaryId,
                secondaryDocumentId: secondaryId,
              });
              actions.markMergeSucceeded();
            } catch (err) {
              actions.markMergeFailed(
                err instanceof Error ? err.message : "Failed to merge artifacts"
              );
            }
          }}
          onOpenChange={actions.setMergeDialogOpen}
          open={mergeDialogOpen}
        />
      )}
    </>
  );
}

/**
 * Source emptiness per tab: the All view derives it from renderable tree
 * groups (documents + branch/session artifacts), the Branches tab from
 * collected branch rows, and the flat document categories from the filtered
 * documents list.
 */
function computeIsSourceEmpty({
  filterCategory,
  isGroupedView,
  groupCount,
  branchItemCount,
  filteredDocumentCount,
}: {
  filterCategory: FilterCategory;
  isGroupedView: boolean;
  groupCount: number;
  branchItemCount: number;
  filteredDocumentCount: number;
}): boolean {
  if (filterCategory === "branches") {
    return branchItemCount === 0;
  }
  if (isGroupedView) {
    return groupCount === 0;
  }
  return filteredDocumentCount === 0;
}

/**
 * Delete-dialog copy for the two delete modes that share one dialog. A bulk
 * delete (`bulkCount > 0`) uses a generic "N items" heading with the default
 * confirmation body; a single-row delete pulls its heading and body from the
 * row-type registry (PLN-874 Task 3.5). Bulk takes precedence because
 * `handleConfirmDelete` dispatches on `pendingBulkIds.size`.
 */
function computeDeleteDialogCopy({
  bulkCount,
  deleteTarget,
  config,
}: {
  bulkCount: number;
  deleteTarget: DocumentRowItem | null;
  config: RowTypeConfig | null;
}): { title: string; itemName: string; description: string | undefined } {
  if (bulkCount > 0) {
    return {
      title: "Items",
      itemName: `${bulkCount} item${bulkCount === 1 ? "" : "s"}`,
      description: undefined,
    };
  }
  if (!deleteTarget) {
    return { title: "Document", itemName: "", description: undefined };
  }
  const itemName = getItemTitle(deleteTarget);
  return {
    title: config?.deleteDialogTitle ?? "Document",
    itemName,
    description: config?.deleteDialogDescription?.(itemName) ?? undefined,
  };
}
