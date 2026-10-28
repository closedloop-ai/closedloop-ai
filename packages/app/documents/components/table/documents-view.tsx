"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import type { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { MoveEntityDialog } from "@repo/app/documents/components/move-entity-dialog";
import {
  type ColumnCollapseContext,
  collapseUninformativeColumns,
} from "@repo/app/documents/components/table/column-collapse";
import {
  DocumentRow,
  type DocumentRowItem,
  getDocumentTableColumnCount,
} from "@repo/app/documents/components/table/document-row";
import { DocumentRowActions } from "@repo/app/documents/components/table/document-row-actions";
import { DocumentTableSkeleton } from "@repo/app/documents/components/table/document-table-skeleton";
import {
  collectArtifactRowItems,
  getItemTitle,
  toRowItem,
} from "@repo/app/documents/components/table/document-tree";
import { DocumentsEmptyState } from "@repo/app/documents/components/table/documents-empty-state";
import { DocumentsGridGroupsBody } from "@repo/app/documents/components/table/documents-grid-groups-body";
import { DocumentsPlacementBody } from "@repo/app/documents/components/table/documents-placement-body";
import { DocumentsSelectionBar } from "@repo/app/documents/components/table/documents-selection-bar";
import { DocumentsUngroupedTreeBody } from "@repo/app/documents/components/table/documents-ungrouped-tree-body";
import {
  canBulkMoveDocumentsSelection,
  computeDeleteDialogCopy,
  computeIsSourceEmpty,
  toBandCollapsePort,
  toRowExpansionPort,
} from "@repo/app/documents/components/table/documents-view-helpers";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import { MergeDocumentsDialog } from "@repo/app/documents/components/table/merge-documents-dialog";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { getRowTypeConfig } from "@repo/app/documents/components/table/row-type-registry";
import {
  RankInteractionMode,
  SORT_KEYS,
  SortKey,
} from "@repo/app/documents/components/table/sort-keys";
import { DocumentTableHeader } from "@repo/app/documents/components/table/table-header";
import { useUniversalStatusGroupPresentation } from "@repo/app/documents/components/table/use-universal-status-group-presentation";
import { useContextGroupExpansion } from "@repo/app/documents/hooks/use-context-group-expansion";
import { useMergeDocuments } from "@repo/app/documents/hooks/use-documents";
import {
  collectHierarchyMoveEntities,
  useDocumentsHierarchySelectionRows,
} from "@repo/app/documents/hooks/use-documents-hierarchy-selection-rows";
import { useDocumentsLegacyRowSelection } from "@repo/app/documents/hooks/use-documents-legacy-row-selection";
import { useDocumentsProjectTree } from "@repo/app/documents/hooks/use-documents-project-tree";
import { useDocumentsViewState } from "@repo/app/documents/hooks/use-documents-view-state";
import { useStackRanking } from "@repo/app/documents/hooks/use-stack-ranking";
import { useTableViewOrdering } from "@repo/app/documents/hooks/use-table-view-ordering";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import {
  buildDocumentGridGroups,
  documentTreeRoots,
} from "@repo/app/documents/lib/documents-grid-groups";
import {
  documentsGroupingState,
  LEGACY_GROUP_SECTIONS_KEY_SUFFIX,
} from "@repo/app/documents/lib/documents-group-link";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  collectBulkMoveEntities,
  computeMoveEntities,
  findMergeCandidates,
  runBulkDelete,
} from "@repo/app/documents/lib/table-row-actions";
import {
  buildFlatItems,
  buildParentMap,
  buildRenderedItems,
  buildSortedGroups,
  filterByCategory,
  treeHasRenderableArtifacts,
} from "@repo/app/documents/lib/table-view-pipeline";
import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import { ProductGridInteractionContract } from "@repo/app/shared/components/product-grid-table-v2";
import { useProductNarrowGridview } from "@repo/app/shared/feature-flags/use-responsive-narrow-gridview";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import {
  groupExpansionKey,
  useGroupExpansion,
} from "@repo/app/shared/hooks/use-group-expansion";
import { useSortParams } from "@repo/app/shared/hooks/use-sort-params";
import { NAME_SORT_OPTIONS } from "@repo/app/shared/lib/sort-comparators";
import {
  type TableCollapsedGroups,
  tableGroupCollapsePort,
} from "@repo/app/shared/lib/table-collapsed-groups";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { ariaTableProps } from "@repo/design-system/lib/grid-table-aria";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { GitPullRequestIcon, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";

export type DocumentsViewProps = {
  documents: DocumentRowData[];
  /** Server-owned permission for row and keyboard reorder controls. */
  canReorderArtifacts?: boolean;
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
   *
   * ISS-9726: `null` means the owning surface has an organization-namespaced
   * key that has not resolved yet, so expansion is held in memory. That is NOT
   * the same as omitting it — omitting still takes the `projectId` default,
   * which is already organization-isolated because a project id is unique
   * across organizations.
   */
  storageKey?: string | null;
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
  /**
   * localStorage key for sort state persistence. `null` (ISS-9726) keeps the
   * sort in the URL and memory only, for the window before the owning
   * organization resolves.
   */
  sortPersistenceKey?: string | null;
  /**
   * FEA-4165: reorder the data columns. Receives the reordered VISIBLE column-id
   * order the owning page merges into its persisted order. Omit → header drag
   * handles are hidden (static columns).
   */
  onReorderColumns?: (nextVisibleOrder: string[]) => void;
  /**
   * ISS-4704: each group section's size over the caller's FULL unpaged list, by
   * `GroupSectionDescriptor.key`. A paged caller passes it so a header states
   * the section's population instead of the slice this page happens to hold.
   *
   * Omit on an unpaged surface — there the rendered rows ARE the population.
   * When it IS supplied, a section missing from it renders NO count rather than
   * falling back to the page-local length: a number that silently means "on
   * this page" is the defect, not the fix.
   */
  sectionTotalsByKey?: ReadonlyMap<string, number>;
  /**
   * ISS-10472: the section ordering the SERVER packed this page in, when a
   * server-paged caller was told one.
   *
   * Supplied, it replaces this view's own PostHog resolution. Two of the three
   * orderings key a status band on the RAW status and the third coerces it to
   * the subtype's vocabulary, and the server evaluates its own flags — so a
   * view re-deciding could band a row under a key the caller's
   * {@link sectionTotalsByKey} was never computed for, printing one section's
   * total over the wrong rows and no count at all beside the other (whitlockk).
   *
   * Omit on every surface whose page the browser drew; there the view's own
   * resolution is the only one in play.
   */
  sectionOrdering?: ArtifactSectionOrdering;
  /**
   * ISS-4704: section keys on this page whose rows began on an earlier page, so
   * a section too large for one page says it is continuing.
   */
  continuedSectionKeys?: ReadonlySet<string>;
  /**
   * PRD-720 AC3: band collapse held by the owning surface, per grouping axis.
   * The project board passes its linked state (`useDocumentsGroupLink`) so a
   * closed band survives a refresh and a shared link. Omitted, the view keeps
   * the collapse it remembers under `storageKey`, as before.
   */
  collapsedGroups?: Readonly<TableCollapsedGroups>;
  onCollapsedGroupsChange?: (next: TableCollapsedGroups) => void;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: orchestrator component
export function DocumentsView({
  documents,
  canReorderArtifacts = true,
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
  sectionTotalsByKey,
  sectionOrdering,
  continuedSectionKeys,
  collapsedGroups,
  onCollapsedGroupsChange,
}: DocumentsViewProps) {
  const buildOrgPath = useOrgPath();
  const useNarrowGridview = useProductNarrowGridview();
  // ISS-9726: `null` is the owner saying "my key has not resolved", which is
  // distinct from the omitted case that falls back to the project-scoped
  // default. `??` would collapse the two and write this organization's group
  // expansion into a bucket shared by every organization.
  const expansionKey =
    storageKey === undefined
      ? `project-artifacts:${projectId ?? "all"}`
      : storageKey;
  const {
    isExpanded: isGroupExpanded,
    isLoadingTree,
    toggleGroup,
    treeData,
  } = useDocumentsProjectTree({
    expansionStorageKey: groupExpansionKey(expansionKey, ""),
    isProvidedTreeLoading: isTreeDataLoading,
    projectId,
    providedTree: providedTreeData,
  });
  const {
    isExpanded: isStoredSectionExpanded,
    toggleGroup: toggleStoredSection,
  } = useGroupExpansion(
    groupExpansionKey(expansionKey, LEGACY_GROUP_SECTIONS_KEY_SUFFIX),
    {
      defaultExpanded: true,
    }
  );

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when filterCategory changes
  useEffect(() => {
    actions.clearSelection();
  }, [filterCategory]);

  const mergeMutation = useMergeDocuments();

  // PLN-755 Phase D: the page defaults to "Stack rank ASC" so a no-params URL
  // renders the canonical server-supplied ordering. URL params (set by clicking
  // column headers) still take precedence over the default.
  const { sortBy, sortDir, setSort, clearSort } = useSortParams<SortKey>({
    validColumns: SORT_KEYS,
    defaultColumn: SortKey.StackRank,
    defaultDirection: "asc",
    persistenceKey: sortPersistenceKey,
  });

  // ISS-9437: the resolved sort/section order. Read HERE for a browser-paged
  // caller — `useTableViewPagination` calls the same hook for itself, so the
  // order this view renders and the order it slices page membership in cannot
  // disagree. A SERVER-paged caller hands the name its response carried, which
  // is the only way the two agree when the server's flag read differs from this
  // browser's (ISS-10472, whitlockk).
  const ordering = useTableViewOrdering(sectionOrdering);

  const filteredDocuments = useMemo(
    () => filterByCategory(documents, filterCategory, filterText),
    [documents, filterCategory, filterText]
  );

  const isGroupedView = filterCategory === "all";
  // Branch rows have no bulk operations (no merge/move/batch-delete), so the
  // Branches tab renders without selection checkboxes.
  const baseShowCheckbox = !isGroupedView && filterCategory !== "branches";
  const selectedDocumentsForMerge = useMemo(
    () => findMergeCandidates(selectedIds, documents),
    [selectedIds, documents]
  );
  const selectedDocumentIds = useMemo(
    () => new Set(documents.map((document) => document.id)),
    [documents]
  );
  const canUseDocumentBulkActions =
    selectedIds.size > 0 &&
    [...selectedIds].every((artifactId) => selectedDocumentIds.has(artifactId));

  const parentMap = useMemo(
    () => buildParentMap(treeData ?? null, buildOrgPath),
    [treeData, buildOrgPath]
  );

  const { groups, contextExpandedIds } = useMemo(
    () =>
      buildSortedGroups({
        treeData: treeData ?? null,
        documents,
        applyProjectFilters,
        filterText,
        sortBy,
        sortDir,
        ordering,
      }),
    [
      documents,
      filterText,
      sortBy,
      sortDir,
      treeData,
      applyProjectFilters,
      ordering,
    ]
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

  const flatItems: DocumentRowItem[] = useMemo(
    () =>
      buildFlatItems(
        filterCategory === "branches"
          ? branchItems
          : filteredDocuments.map(toRowItem),
        applyProjectFilters,
        sortBy,
        sortDir,
        ordering
      ),
    [
      filterCategory,
      branchItems,
      filteredDocuments,
      sortBy,
      sortDir,
      applyProjectFilters,
      ordering,
    ]
  );

  const derivedGridGroups = useMemo(
    () =>
      buildDocumentGridGroups({
        continuedSectionKeys,
        flatItems,
        groupBy,
        groupOptions: ordering.groupOptions,
        groups,
        isGroupedView,
        sectionTotalsByKey,
      }),
    [
      continuedSectionKeys,
      flatItems,
      groupBy,
      groups,
      isGroupedView,
      ordering,
      sectionTotalsByKey,
    ]
  );
  const gridGroups = useUniversalStatusGroupPresentation(
    groupBy,
    derivedGridGroups
  );
  const treeRoots = useMemo(() => documentTreeRoots(groups), [groups]);
  let ungroupedGridItems: DocumentRowItem[] | undefined;
  if (groupBy === GroupByMode.None) {
    ungroupedGridItems = isGroupedView ? treeRoots : flatItems;
  }
  const bandCollapsePort = useMemo(
    () =>
      // Bands are cut from one tab and, when paged, one page of the board, so
      // a key missing here may name a band elsewhere: never complete.
      tableGroupCollapsePort({
        collapsedGroups,
        grouping: documentsGroupingState(groupBy),
        groups: gridGroups,
        isCompletePopulation: false,
        onCollapsedGroupsChange,
      }) ?? toBandCollapsePort(isStoredSectionExpanded, toggleStoredSection),
    [
      collapsedGroups,
      groupBy,
      gridGroups,
      isStoredSectionExpanded,
      onCollapsedGroupsChange,
      toggleStoredSection,
    ]
  );
  const isSectionExpanded = useCallback(
    (key: string) => !bandCollapsePort.isCollapsed(key),
    [bandCollapsePort]
  );
  const rowExpansionPort = useMemo(
    () => toRowExpansionPort(isTreeGroupExpanded, toggleTreeGroup),
    [isTreeGroupExpanded, toggleTreeGroup]
  );
  const renderedItems = useMemo(
    (): DocumentRowItem[] =>
      buildRenderedItems({
        groupBy,
        gridGroups,
        isGroupedView,
        flatItems,
        groups,
        isGroupExpanded: isTreeGroupExpanded,
      }),
    [groupBy, gridGroups, isGroupedView, flatItems, groups, isTreeGroupExpanded]
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
  const canonicalHierarchyEnabled =
    isGroupedView && treeData?.hierarchy !== undefined;
  const hierarchyColumns = useMemo(
    () =>
      canonicalHierarchyEnabled
        ? visibleColumns.filter((column) => column !== DocumentColumn.Parent)
        : visibleColumns,
    [canonicalHierarchyEnabled, visibleColumns]
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
    enabled: canReorderArtifacts,
    projectId,
    filterCategory,
    sortBy,
    groupBy,
    isGroupedView,
    groups,
    flatItems,
    renderedItems,
  });
  const {
    hierarchyPlacement,
    manualExpansion,
    paintedItems,
    selectablePaintedItems,
    selectableRenderedItems,
    visibleRenderedItems,
  } = useDocumentsHierarchySelectionRows({
    contextExpandedIds,
    isGroupExpanded,
    toggleGroup,
    isTreeGroupExpanded,
    projectId,
    projectVersion: treeData?.projectVersion,
    currentOrderingEnabled: isDndEnabled,
    renderedItems,
    selectedIds,
    treeRoots,
    groupBy,
    gridGroups,
    isGroupedView,
    flatItems,
    groups,
    isSectionExpanded,
  });
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
        hierarchyColumns,
        paintedItems,
        collapseContext
      ),
    [hierarchyColumns, paintedItems, collapseContext]
  );
  const ariaColumnCount = getDocumentTableColumnCount(effectiveColumns.length);
  const canBulkMove = canBulkMoveDocumentsSelection({
    canUseDocumentBulkActions,
    filterCategory,
    hierarchyPlacementEnabled: hierarchyPlacement.enabled,
  });
  const showCheckbox =
    baseShowCheckbox || canonicalHierarchyEnabled || hierarchyPlacement.enabled;

  useEffect(() => {
    if (
      (!canonicalHierarchyEnabled || hierarchyPlacement.enabled) &&
      (groupBy === GroupByMode.None || selectableRenderedItems.length === 0)
    ) {
      actions.pruneSelection(
        new Set(selectableRenderedItems.map((i: DocumentRowItem) => i.data.id))
      );
    }
  }, [
    actions,
    canonicalHierarchyEnabled,
    groupBy,
    hierarchyPlacement.enabled,
    selectableRenderedItems,
  ]);

  const selectablePaintedRowIds = useMemo(
    () => selectablePaintedItems.map((item: DocumentRowItem) => item.data.id),
    [selectablePaintedItems]
  );
  const changeLegacyRowSelection = useDocumentsLegacyRowSelection({
    paintedRowIds: selectablePaintedRowIds,
    replaceSelection: actions.replaceSelection,
    selectedIds,
  });

  const reconcileGridSelection = useCallback(
    (items: readonly DocumentRowItem[]) =>
      actions.pruneSelection(new Set(items.map((item) => item.data.id))),
    [actions]
  );

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
  const isPostFilterEmpty = visibleRenderedItems.length === 0;
  const shouldShowEmptyState =
    isSourceEmpty || (isFilterActive === true && isPostFilterEmpty);
  // Prefer the caller's unpaged signal (My Tasks pages upstream, so the local
  // `documents`/`treeData` are only the current page's subset — a zero-match
  // filter would otherwise read as an empty board and drop "Clear filters").
  // Falls back to the local sources for unpaged callers (ISS-4466).
  const hasAnyItems =
    hasUnpagedItems ??
    (documents.length > 0 || treeHasRenderableArtifacts(treeData));

  const selectMode = selectedIds.size > 0;
  const allSelected =
    showCheckbox &&
    selectablePaintedItems.length > 0 &&
    selectedIds.size === selectablePaintedItems.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  // ISS-12640 AC-3 (operator ruling 2026-10-20, Asana precedent): select-all
  // takes the painted rows, so a collapsed band's rows are never selected.
  function handleSelectAll(checked: boolean) {
    if (checked) {
      actions.replaceSelection(
        new Set(selectablePaintedItems.map((i: DocumentRowItem) => i.data.id))
      );
    } else {
      actions.clearSelection();
    }
  }

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

  // Branches: wait for the tree before declaring the list empty

  if (filterCategory === "branches" && isLoadingTree) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

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

  // Table body rendering (extracted to avoid nested ternaries)

  // FEA-4242: build the per-row overflow ("More actions") menu. Each row owns
  // its own `DropdownMenu` (via `DocumentRowActions`), triggered by the row's
  // real button — replacing the former single view-level menu anchored to an
  // invisible, manually-positioned span. The Radix trigger both anchors the
  // popover and receives focus on close, so the stale-rect positioning and the
  // focus-stranding are gone by construction.
  function renderRowActions(item: DocumentRowItem) {
    return (
      <DocumentRowActions
        item={item}
        onDelete={() => actions.requestDelete(item)}
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
        onSelectionChange={changeLegacyRowSelection}
        parentHref={parentMap.get(item.data.id)?.href}
        parentTitle={parentMap.get(item.data.id)?.title}
        selectMode={selectMode}
        showCheckbox={showCheckbox}
        visibleColumns={effectiveColumns}
      />
    );
  }

  function renderTableBody() {
    if (isGroupedView) {
      return (
        <DocumentsUngroupedTreeBody
          editHandlers={editHandlers}
          insideAriaTable={insideAriaTable}
          isExpanded={
            hierarchyPlacement.enabled
              ? manualExpansion.isTreeGroupExpanded
              : isTreeGroupExpanded
          }
          items={treeRoots}
          manualPlacementEnabled={hierarchyPlacement.enabled}
          onKeyboardPlacement={hierarchyPlacement.handleKeyboardPlacement}
          onSelectionChange={changeLegacyRowSelection}
          parentMap={parentMap}
          placementPreview={hierarchyPlacement.preview}
          rankInteractionMode={rankInteractionMode}
          renderRowActions={renderRowActions}
          selectedIds={selectedIds}
          selectMode={selectMode}
          showCheckbox={showCheckbox}
          toggleRow={
            hierarchyPlacement.enabled
              ? manualExpansion.toggleTreeGroup
              : toggleTreeGroup
          }
          visibleColumns={effectiveColumns}
        />
      );
    }

    return flatItems.map(renderFlatRow);
  }

  const deleteDialogCopy = computeDeleteDialogCopy({
    bulkCount: pendingBulkIds.size,
    deleteTarget,
    config: deleteTarget ? getRowTypeConfig(deleteTarget) : null,
  });

  return (
    <>
      <span aria-live="polite" className="sr-only">
        {hierarchyPlacement.announcement}
      </span>
      <div
        // A project hierarchy scrolls sideways inside its own band at narrow
        // widths, never as cards (Daveth, 2026-10-21; ISS-6560).
        className={
          hierarchyPlacement.enabled ? "min-w-0 overflow-x-auto" : "min-w-0"
        }
      >
        {isFilterActive === true &&
          rankInteractionMode === RankInteractionMode.Enabled && (
            <div className="border-b bg-muted/40 px-4 py-2 text-muted-foreground text-xs">
              Reordering applies to the whole project, not just the current
              filter.
            </div>
          )}
        {groupBy === GroupByMode.None &&
        !useNarrowGridview &&
        !canonicalHierarchyEnabled ? (
          /* ISS-4761: the ARIA table wraps the header + body ONLY. The filter
             banner above and the floating selection bar below are not rows, and
             a `role="table"` may not own them. */
          <ProductGridInteractionContract>
            <DocumentsPlacementBody
              enabled={isDndEnabled}
              itemIds={
                hierarchyPlacement.enabled
                  ? hierarchyPlacement.itemIds
                  : rankItemIds
              }
              manualPlacementEnabled={hierarchyPlacement.enabled}
              onDragCancel={hierarchyPlacement.handleDragCancel}
              onDragEnd={
                hierarchyPlacement.enabled
                  ? hierarchyPlacement.handleDragEnd
                  : handleDragEnd
              }
              onDragMove={hierarchyPlacement.handleDragMove}
              onDragOver={hierarchyPlacement.handleDragOver}
              placementPreview={hierarchyPlacement.preview}
            >
              <div
                {...ariaTableProps(insideAriaTable, ariaColumnCount)}
                className={hierarchyPlacement.enabled ? "min-w-fit" : undefined}
              >
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
                {renderTableBody()}
              </div>
            </DocumentsPlacementBody>
          </ProductGridInteractionContract>
        ) : (
          <DocumentsGridGroupsBody
            allSelected={allSelected}
            canDragRow={
              canonicalHierarchyEnabled && hierarchyPlacement.enabled
                ? hierarchyPlacement.canDragRow
                : undefined
            }
            canDropOnRow={
              canonicalHierarchyEnabled && hierarchyPlacement.enabled
                ? hierarchyPlacement.canDropOnRow
                : undefined
            }
            editHandlers={editHandlers}
            groupCollapse={bandCollapsePort}
            groups={
              canonicalHierarchyEnabled || groupBy === GroupByMode.None
                ? undefined
                : gridGroups
            }
            isNested={isGroupedView}
            items={canonicalHierarchyEnabled ? treeRoots : ungroupedGridItems}
            leadingSortOptions={NAME_SORT_OPTIONS}
            onClearSort={clearSort}
            onKeyboardPlacement={
              canonicalHierarchyEnabled && hierarchyPlacement.enabled
                ? hierarchyPlacement.handleKeyboardPlacement
                : undefined
            }
            onRenderedItemsChange={
              canonicalHierarchyEnabled ? undefined : reconcileGridSelection
            }
            onReorderColumns={onReorderColumns}
            onRowDrop={
              canonicalHierarchyEnabled && hierarchyPlacement.enabled
                ? hierarchyPlacement.handleGridRowDrop
                : undefined
            }
            onSelectAll={handleSelectAll}
            onSelectionChange={actions.changeSelection}
            onSort={(col, dir) => setSort(col as SortKey, dir)}
            parentMap={parentMap}
            rankInteractionMode={rankInteractionMode}
            renderRowActions={renderRowActions}
            rowExpansion={rowExpansionPort}
            selectedIds={selectedIds}
            selectMode={selectMode}
            showCheckbox={showCheckbox}
            someSelected={someSelected}
            sortBy={sortBy}
            sortDir={sortDir}
            visibleColumns={effectiveColumns}
          />
        )}

        <DocumentsSelectionBar
          canBulkDelete={canUseDocumentBulkActions}
          canBulkMove={canBulkMove}
          canMerge={Boolean(selectedDocumentsForMerge)}
          canUseDocumentActions={canUseDocumentBulkActions}
          manualPlacementEnabled={hierarchyPlacement.enabled}
          onBulkDelete={actions.requestBulkDelete}
          onBulkMove={() =>
            actions.requestBulkMove(
              hierarchyPlacement.enabled
                ? collectHierarchyMoveEntities(
                    selectedIds,
                    visibleRenderedItems
                  )
                : collectBulkMoveEntities(selectedIds, documents)
            )
          }
          onClear={actions.clearSelection}
          onMerge={actions.openMergeDialog}
          onRetain={(rowIds) => actions.replaceSelection(new Set(rowIds))}
          selectedIds={[...selectedIds]}
          selectedRows={documents.filter((document) =>
            selectedIds.has(document.id)
          )}
          users={editHandlers?.teamMembers}
        />
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
          placementSourceProjectId={
            hierarchyPlacement.enabled ? projectId : undefined
          }
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
