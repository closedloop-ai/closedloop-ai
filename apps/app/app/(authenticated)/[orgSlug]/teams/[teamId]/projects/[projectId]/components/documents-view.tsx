"use client";

import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { MoveEntityDialog } from "@repo/app/documents/components/move-entity-dialog";
import { BulkStatusPicker } from "@repo/app/documents/components/table/bulk-status-picker";
import { BulkTagPicker } from "@repo/app/documents/components/table/bulk-tag-picker";
import {
  type ColumnCollapseContext,
  collapseUninformativeColumns,
} from "@repo/app/documents/components/table/column-collapse";
import {
  DocumentRow,
  type DocumentRowItem,
  getDocumentTableColumnCount,
} from "@repo/app/documents/components/table/document-row";
import { DocumentTableSkeleton } from "@repo/app/documents/components/table/document-table-skeleton";
import {
  collectArtifactRowItems,
  getItemTitle,
  toRowItem,
} from "@repo/app/documents/components/table/document-tree";
import { DocumentsEmptyState } from "@repo/app/documents/components/table/documents-empty-state";
import { DocumentsTreeSection } from "@repo/app/documents/components/table/documents-tree-section";
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
  buildCollapseVisibleItems,
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
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { GroupSectionHeader } from "@repo/design-system/components/ui/group-section-header";
import { ariaTableProps } from "@repo/design-system/lib/grid-table-aria";
import {
  GitPullRequestIcon,
  Layers2Icon,
  Loader2,
  MergeIcon,
  TrashIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { GeneratePrdFromDocumentDialog } from "@/app/(authenticated)/[orgSlug]/documents/components/generate-prd-from-document-dialog";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { useContextGroupExpansion } from "../hooks/use-context-group-expansion";
import { useStackRanking } from "../hooks/use-stack-ranking";
import { DocumentRowActions } from "./document-row-actions";
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
   * Whether the primary documents list is still loading (fetching, or waiting
   * on a prerequisite such as the current user). When true, the view renders a
   * table skeleton instead of the empty state so the empty state never flashes
   * before rows arrive (FEA-3938). Optional and backward-compatible: consumers
   * that already gate their own loading (e.g. the project page, which mounts
   * this view only after artifacts resolve) can omit it.
   */
  isLoading?: boolean;
  /**
   * Screen-reader label for the loading skeleton. Lets a caller name what it is
   * loading (e.g. "Loading tasks…") without this shared view asserting one
   * caller's noun. Defaults to the skeleton's caller-agnostic "Loading…".
   */
  loadingLabel?: string;
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
  /**
   * Whether the board has ANY task at all BEFORE paging/filtering — the honest
   * "is the queue truly empty" signal. When a caller pages the data upstream
   * (My Tasks, ISS-4466), `documents`/`treeData` here are only the current
   * page's subset, so a filter that matches nothing hands this view two empty
   * sources and it would take the "No artifacts yet" branch, dropping the
   * "Clear filters" action. Callers that page upstream pass this so the
   * no-match state (with Clear filters) wins over the truly-empty state.
   * Optional and backward-compatible: unpaged callers omit it and the view
   * derives emptiness from its own `documents`/`treeData` as before.
   */
  hasUnpagedItems?: boolean;
  /** How to group items (none / status / assignee / priority). */
  groupBy?: GroupByMode;
  /** localStorage key for sort state persistence. */
  sortPersistenceKey?: string;
  /**
   * FEA-4165: reorder the data columns. Receives the reordered VISIBLE column-id
   * order the owning page merges into its persisted order. Omit → header drag
   * handles are hidden (static columns).
   */
  onReorderColumns?: (nextVisibleOrder: string[]) => void;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: orchestrator component
export function DocumentsView({
  documents,
  projectId,
  teamId,
  treeData: providedTreeData,
  isTreeDataLoading,
  isLoading,
  loadingLabel,
  storageKey,
  filterText,
  filterCategory,
  visibleColumns,
  onDelete,
  editHandlers,
  applyProjectFilters,
  isFilterActive,
  onClearFilters,
  hasUnpagedItems,
  groupBy = GroupByMode.None,
  sortPersistenceKey,
  onReorderColumns,
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
  // FEA-3952: "Generate PRD" is offered on evergreen Document (DocumentType.Doc)
  // rows. The generated PRD's target project is chosen inside the dialog
  // (pre-filled to this project when the view is project-scoped).
  const [generatePrdSource, setGeneratePrdSource] = useState<{
    id: string;
    title: string;
  } | null>(null);
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
    return items;
  }, [filterCategory, treeData, filterText]);

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

  // FEA-3945 / FEA-3946: drop columns that convey nothing for the currently
  // visible rows — an all-empty Parent/default-Priority column (every surface),
  // or a constant Assignee/Project on the single-scope "My Issues" view (opt-in
  // via `collapseConstantColumns`, off on the general artifacts table where
  // those are inline-edit controls the column menu still enables).
  // The collapse input is built from the rows the body actually paints —
  // collapsed-section rows are excluded so a hidden Urgent row can't keep the
  // Priority column open for a section of only Medium rows — plus the same
  // parent context the cells read, applied to both the header and every row so
  // the grid stays aligned. The Loop column and its loop context were removed
  // with the Loop cell; `hasParent` is now the only ambient lookup here.
  const collapseItems = useMemo(
    () =>
      buildCollapseVisibleItems({
        groupBy,
        groupedSections,
        isGroupedView,
        flatItems,
        groups,
        isGroupExpanded: isTreeGroupExpanded,
        isSectionExpanded,
      }),
    [
      groupBy,
      groupedSections,
      isGroupedView,
      flatItems,
      groups,
      isTreeGroupExpanded,
      isSectionExpanded,
    ]
  );
  const collapseContext: ColumnCollapseContext = useMemo(
    () => ({
      hasParent: (id: string) => parentMap.has(id),
      collapseConstantColumns: editHandlers?.surfaceVariant === "my-tasks",
    }),
    [parentMap, editHandlers]
  );
  const effectiveColumns = useMemo(
    () =>
      collapseUninformativeColumns(
        visibleColumns,
        collapseItems,
        collapseContext
      ),
    [visibleColumns, collapseItems, collapseContext]
  );

  // ISS-4761: the Documents tree was the last production caller still opted OUT
  // of the shared `GridTable` ARIA table semantics (ISS-4672), so
  // `/<org>/documents` announced a body cell as a loose "Active" where every
  // other dense table says "Status, Active". ISS-5280 retired the flag that
  // staged this, so the whole view opts in unconditionally — the one resolved
  // value still threads down to every header, row, and cell from here, so the
  // table can never be half-labelled.
  const insideAriaTable = true;
  // The table's `aria-colcount`, derived from the SAME arithmetic the header
  // and the rows number their tracks with, so all three cannot drift apart.
  const ariaColumnCount = getDocumentTableColumnCount(effectiveColumns.length);

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
  // Prefer the caller's unpaged signal (My Tasks pages upstream, so the local
  // `documents`/`treeData` are only the current page's subset — a zero-match
  // filter would otherwise read as an empty board and drop "Clear filters").
  // Falls back to the local sources for unpaged callers (ISS-4466).
  const hasAnyItems =
    hasUnpagedItems ??
    (documents.length > 0 || treeHasRenderableArtifacts(treeData));

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

  // ---- Loading ----

  // While the primary documents list is still loading, render a table skeleton
  // rather than falling through to the empty state (FEA-3938). Only applies
  // before any rows exist: once the list has data, keep showing it during
  // background refetches instead of flashing the skeleton over live rows.
  if (isLoading === true && !hasAnyItems) {
    return (
      <DocumentTableSkeleton
        label={loadingLabel}
        visibleColumns={visibleColumns}
      />
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

  // FEA-4242: build the per-row overflow ("More actions") menu. Each row owns
  // its own `DropdownMenu` (via `DocumentRowActions`), triggered by the row's
  // real button — replacing the former single view-level menu anchored to an
  // invisible, manually-positioned span. The Radix trigger both anchors the
  // popover and receives focus on close, so the stale-rect positioning and the
  // focus-stranding are gone by construction.
  function renderRowActions(item: DocumentRowItem) {
    return (
      <DocumentRowActions
        canGeneratePrd={canGeneratePrdFromRow(item)}
        item={item}
        onDelete={() => actions.requestDelete(item)}
        onGeneratePrd={() => {
          const doc = item.kind === "document" ? item.data : null;
          if (doc) {
            setGeneratePrdSource({ id: doc.id, title: doc.title });
          }
        }}
        onMove={() => handleRequestMove(item)}
        onMoveToBottom={() => moveToBottom(item)}
        onMoveToTop={() => moveToTop(item)}
        showRankActions={isDndEnabled && isRankableMenuItem(item)}
      />
    );
  }

  // Flat category views (documents/features/plans) are never a rank surface
  // — `isRankSurface` requires the "all" view — so these rows carry no rank
  // affordance and render plain.
  function renderFlatRow(item: DocumentRowItem) {
    return (
      <DocumentRow
        editHandlers={editHandlers}
        insideAriaTable={insideAriaTable}
        isSelected={selectedIds.has(item.data.id)}
        item={item}
        key={item.data.id}
        moreMenuContent={renderRowActions(item)}
        onSelectionChange={actions.changeSelection}
        parentHref={parentMap.get(item.data.id)?.href}
        parentTitle={parentMap.get(item.data.id)?.title}
        selectMode={selectMode}
        showCheckbox={showCheckbox}
        visibleColumns={effectiveColumns}
      />
    );
  }

  function renderTableBody() {
    if (groupBy !== GroupByMode.None) {
      return groupedSections.map((section) => {
        const sectionOpen = isSectionExpanded(section.descriptor.key);
        return (
          <DocumentsTreeSection
            columnCount={ariaColumnCount}
            insideAriaTable={insideAriaTable}
            key={section.descriptor.key}
            sectionHeader={
              <GroupSectionHeader
                count={section.groups.length}
                icon={sectionIcon(section.descriptor)}
                isOpen={sectionOpen}
                label={section.descriptor.label}
                onToggle={() => toggleSection(section.descriptor.key)}
              />
            }
          >
            {sectionOpen &&
              section.groups.map((group) =>
                isGroupedView ? (
                  <TreeGroupRows
                    editHandlers={editHandlers}
                    group={group}
                    handleSelectionChange={actions.changeSelection}
                    insideAriaTable={insideAriaTable}
                    isGroupExpanded={isTreeGroupExpanded}
                    key={group.groupKey}
                    parentMap={parentMap}
                    rankInteractionMode={rankInteractionMode}
                    renderMoreMenu={renderRowActions}
                    selectedIds={selectedIds}
                    toggleGroup={toggleTreeGroup}
                    visibleColumns={effectiveColumns}
                  />
                ) : (
                  <DocumentRow
                    editHandlers={editHandlers}
                    insideAriaTable={insideAriaTable}
                    isSelected={selectedIds.has(group.root.data.id)}
                    item={group.root}
                    key={group.root.data.id}
                    moreMenuContent={renderRowActions(group.root)}
                    onSelectionChange={actions.changeSelection}
                    parentHref={parentMap.get(group.root.data.id)?.href}
                    parentTitle={parentMap.get(group.root.data.id)?.title}
                    rankInteractionMode={rankInteractionMode}
                    showCheckbox={showCheckbox}
                    visibleColumns={effectiveColumns}
                  />
                )
              )}
          </DocumentsTreeSection>
        );
      });
    }

    if (isGroupedView) {
      return groups.map((group) => (
        <TreeGroupRows
          editHandlers={editHandlers}
          group={group}
          handleSelectionChange={actions.changeSelection}
          insideAriaTable={insideAriaTable}
          isGroupExpanded={isTreeGroupExpanded}
          key={group.groupKey}
          parentMap={parentMap}
          rankInteractionMode={rankInteractionMode}
          renderMoreMenu={renderRowActions}
          selectedIds={selectedIds}
          toggleGroup={toggleTreeGroup}
          visibleColumns={effectiveColumns}
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
        {/* ISS-4761: the ARIA table wraps the header + body ONLY. The filter
            banner above and the floating selection bar below are not rows, and a
            `role="table"` may not own them. */}
        <div {...ariaTableProps(insideAriaTable, ariaColumnCount)}>
          <DocumentTableHeader
            allSelected={allSelected}
            insideAriaTable={insideAriaTable}
            nameSortOptions={NAME_SORT_OPTIONS}
            onClearSort={clearSort}
            onReorderColumns={onReorderColumns}
            onSelectAll={handleSelectAll}
            onSort={(col, dir) => setSort(col as SortKey, dir)}
            showSelectAll={showCheckbox}
            someSelected={someSelected}
            sortBy={sortBy}
            sortDir={sortDir}
            visibleColumns={effectiveColumns}
          />
          {renderRankableBody()}
        </div>

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
      {generatePrdSource && (
        <GeneratePrdFromDocumentDialog
          defaultProjectId={projectId}
          document={generatePrdSource}
          onOpenChange={(open) => {
            if (!open) {
              setGeneratePrdSource(null);
            }
          }}
          open={generatePrdSource !== null}
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
 * Whether the "Generate PRD" row action should be offered: only for an
 * evergreen Document (DocumentType.Doc) row (FEA-3952). The type check is the
 * gate that carries meaning — no feature flag (the repo is not gating new
 * features). Extracted so it can be asserted behaviorally.
 */
export function canGeneratePrdFromRow(item: DocumentRowItem): boolean {
  return item.kind === "document" && item.data.type === DocumentType.Doc;
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
