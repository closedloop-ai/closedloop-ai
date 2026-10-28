"use client";

import { ActiveFiltersBar } from "@repo/design-system/components/ui/active-filters-bar";
import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  ColumnMoveDirection,
  mergeColumnOrder,
  moveColumnByDirection,
} from "@repo/design-system/lib/column-order";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useListBulkSelection } from "../../shared/components/generic-artifact-surface/use-list-bulk-selection";
import { ListLayoutToggle } from "../../shared/components/list-layout-toggle";
import {
  TableToolbarGroupMenu,
  TableToolbarOptionsMenu,
  TableToolbarSavedViewsMenu,
  TableToolbarSortMenu,
  TableToolbarViewMenu,
} from "../../shared/components/table-toolbar-controls";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import { PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY } from "../../shared/lib/feature-flags";
import {
  useProjectColumnPreferences,
  useProjectSavedViews,
} from "../hooks/use-project-view-state";
import type { ProjectViewState } from "../lib/project-saved-views";
import { PROJECT_SUMMARY_COLUMNS } from "../lib/project-summary-columns";
import {
  buildProjectColumnFilterGroups,
  buildProjectFilterController,
  buildProjectFilterViewModel,
} from "../lib/project-summary-filter-model";
import type { ProjectSummaryRow } from "../lib/project-summary-row";
import {
  applyProjectGroupValue,
  buildProjectGroups,
  INITIAL_PROJECT_FILTERS,
  matchesProjectFilters,
  matchesProjectSearch,
  type ProjectGroupOrder,
  type ProjectLayout,
  type ProjectSummaryFilters,
  type ProjectSummaryGroup,
  sortProjects,
} from "../lib/project-summary-view";
import { ProjectBoard } from "./project-board";
import type { ProjectIndexBulkSelection } from "./project-index-bulk-actions";
import {
  PROJECT_LAYOUT_LABEL,
  ProjectListSharedToolbar,
} from "./project-list-shared-toolbar";
import {
  type ProjectCellEditors,
  ProjectsEmptyState,
  type ProjectsEmptyStateCopy,
  ProjectsTable,
} from "./projects-table";

const EMPTY_METRICS: [] = [];

export type ProjectListProps = {
  readonly bulkSelection?: ProjectIndexBulkSelection;
  /** Every project this surface may show. Filtering and grouping happen here. */
  readonly rows: readonly ProjectSummaryRow[];
  /**
   * The host's own "no projects yet, make one" control, forwarded to the empty
   * state. A read-only host has no mutation to offer and passes nothing; a host
   * that does must, or a team's first view of Projects is passive copy where the
   * surface it replaces offered Create.
   */
  readonly emptyStateAction?: ReactNode;
  readonly emptyStateCopy?: ProjectsEmptyStateCopy;
  readonly getRowHref?: (row: ProjectSummaryRow) => string;
  /**
   * Clock the "Updated" date-window filter measures against. A host with a
   * frozen fixture date passes that date; production passes the wall clock.
   */
  readonly nowMs?: number;
  /**
   * Persist a board drop. ABSENT DISABLES DRAG — a card that animates into a
   * lane the host will not record is a control that reports a state it cannot
   * reach.
   */
  readonly onProjectGroupChange?: (
    nextRow: ProjectSummaryRow,
    previousRow: ProjectSummaryRow
  ) => void;
  /**
   * The host's own per-row project-management menu, shared by list and board.
   * Absent disables the column: a read-only host has no mutation to offer.
   */
  readonly rowActions?: (row: ProjectSummaryRow) => ReactNode;
  /**
   * The host's own inline editors for the value columns, forwarded to the
   * list. Absent leaves each column read-only, which is a read-only host's
   * whole contract — but a host that owns the mutations must pass them, or its
   * rows lose the cell edits the surface they replace offers.
   */
  readonly cellEditors?: ProjectCellEditors;
  /**
   * The already-namespaced `localStorage` key this surface persists the
   * reader's columns and named views under. `null` or absent holds both in
   * memory and writes nothing — the prototype host has no identity to key a
   * store on, and on the product route `null` is ISS-9726's unresolved
   * organization, where there is no key the preference can honestly be
   * written under.
   */
  readonly viewStateKey?: string | null;
};

export function ProjectList({
  bulkSelection,
  cellEditors,
  emptyStateAction,
  emptyStateCopy,
  getRowHref,
  nowMs,
  onProjectGroupChange,
  rowActions,
  rows,
  viewStateKey,
}: ProjectListProps) {
  const [filters, setFilters] = useState<ProjectSummaryFilters>(
    INITIAL_PROJECT_FILTERS
  );
  const [searchText, setSearchText] = useState("");
  const searchEnabled = useFeatureFlagEnabledOptional(
    PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
  );
  const [layout, setLayout] = useState<ProjectLayout>("list");
  const [sortActive, setSortActive] = useState(false);
  const [sortBy, setSortBy] = useState("name");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [groupBy, setGroupBy] = useState("none");
  const [groupOrder, setGroupOrder] = useState<ProjectGroupOrder>("custom");
  const [secondaryGroupBy, setSecondaryGroupBy] = useState("none");
  const [secondaryGroupOrder, setSecondaryGroupOrder] =
    useState<ProjectGroupOrder>("asc");
  const [showEmptyGroups, setShowEmptyGroups] = useState(true);
  const [showEmptySubgroups, setShowEmptySubgroups] = useState(true);
  // Columns, their order and their widths are a DURABLE preference persisted
  // under the host's identity-namespaced key (ISS-9726), not per-mount state:
  // the surface this one replaces already kept them across visits, and losing
  // them here would be a capability the flag takes away.
  const {
    columnOrder,
    columnWidths,
    leadingColumnWidth,
    setColumnOrder,
    setColumnWidth,
    setLeadingColumnWidth,
    setVisibleColumnIds,
    visibleColumnIds,
  } = useProjectColumnPreferences(viewStateKey);
  const [visibleMetricKeys, setVisibleMetricKeys] = useState<Set<string>>(
    () => new Set()
  );
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false);
  // A bare `Date.now()` is a fresh value on EVERY render, so `filteredRows`,
  // `sortedRows` and `groups` all rebuild and their dependency arrays mean
  // nothing. A host with a fixture date passes `nowMs`; production gets one
  // clock per mount, which is what the coarse "Updated" windows measure against.
  const [mountedNowMs] = useState(() => Date.now());

  const filterController = useMemo(
    () => buildProjectFilterController(filters, setFilters, rows),
    [filters, rows]
  );
  const filterViewModel = useMemo(
    () => buildProjectFilterViewModel(rows),
    [rows]
  );
  const resolvedNowMs = nowMs ?? mountedNowMs;
  const filteredRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          matchesProjectFilters(row, filters, resolvedNowMs) &&
          (!searchEnabled || matchesProjectSearch(row, searchText))
      ),
    [filters, resolvedNowMs, rows, searchEnabled, searchText]
  );
  // Clearing sort has to restore the saved order, not silently re-sort by the
  // default column: `sortBy` keeps its last value so the header can restore it,
  // and `sortActive` is the only thing that says whether it applies.
  const sortedRows = useMemo(
    () =>
      sortActive ? sortProjects(filteredRows, sortBy, sortDir) : filteredRows,
    [filteredRows, sortActive, sortBy, sortDir]
  );
  const groups = useMemo(
    () =>
      buildProjectGroups({
        groupBy,
        groupOrder,
        rows: sortedRows,
        secondaryGroupBy,
        secondaryGroupOrder,
        showEmptyGroups,
        showEmptySubgroups,
      }),
    [
      groupBy,
      groupOrder,
      secondaryGroupBy,
      secondaryGroupOrder,
      showEmptyGroups,
      showEmptySubgroups,
      sortedRows,
    ]
  );
  const searchActive = searchEnabled && searchText.trim() !== "";
  const filtersActive = filterController.activeChips.length > 0 || searchActive;
  const selectionController = useMemo(
    () =>
      bulkSelection
        ? {
            selectedIds: bulkSelection.selectedIds,
            onChange: bulkSelection.onChange,
          }
        : undefined,
    [bulkSelection]
  );
  const listBulkSelection = useListBulkSelection({
    actions: bulkSelection?.actions ?? [],
    controller: selectionController,
    enabled: bulkSelection?.enabled ?? false,
    getRowLabel: (row: ProjectSummaryRow) => row.name,
    noun: PROJECT_NOUN,
    rows: sortedRows,
  });
  const columnFilterGroups = useMemo(
    () => buildProjectColumnFilterGroups(filterController, filterViewModel),
    [filterController, filterViewModel]
  );

  useEffect(() => {
    if (groupBy === secondaryGroupBy && groupBy !== "none") {
      setSecondaryGroupBy("none");
    }
  }, [groupBy, secondaryGroupBy]);

  const clearSort = () => {
    setSortActive(false);
    setSortBy("name");
    setSortDir("asc");
  };
  const applySort = (column: string, direction: SortDirection = "asc") => {
    setSortActive(true);
    setSortBy(column);
    setSortDir(direction);
  };
  const applyLayout = (nextLayout: ProjectLayout) => {
    setLayout(nextLayout);
    if (nextLayout === "board" && groupBy === "none") {
      setGroupBy("owner");
    }
  };
  const moveVisibleColumn = (
    columnId: string,
    direction: "start" | "left" | "right" | "end"
  ) =>
    setColumnOrder((current) => {
      if (direction === "left" || direction === "right") {
        return moveColumnByDirection(
          current,
          columnId,
          direction === "left"
            ? ColumnMoveDirection.Left
            : ColumnMoveDirection.Right
        );
      }
      const withoutColumn = current.filter((id) => id !== columnId);
      return direction === "start"
        ? [columnId, ...withoutColumn]
        : [...withoutColumn, columnId];
    });
  // `setLeadingColumnWidth` is part of the persisted arrangement a saved view
  // restores; the grid has no resize handle on the leading column today, so
  // `restoreViewState` below is its only caller.
  const applyGroupDrop = (
    row: ProjectSummaryRow,
    group: ProjectSummaryGroup,
    subgroup?: ProjectSummaryGroup
  ) => {
    const next = applyProjectGroupValue(
      applyProjectGroupValue(row, groupBy, group.key, rows),
      secondaryGroupBy,
      subgroup?.key,
      rows
    );
    onProjectGroupChange?.(next, row);
  };
  const restoreViewState = useCallback(
    (state: ProjectViewState) => {
      setFilters(state.filters);
      setLayout(state.layout);
      setSortActive(state.sortActive);
      setSortBy(state.sortBy);
      setSortDir(state.sortDir);
      setGroupBy(state.groupBy);
      setGroupOrder(state.groupOrder);
      setSecondaryGroupBy(state.secondaryGroupBy);
      setSecondaryGroupOrder(state.secondaryGroupOrder);
      setShowEmptyGroups(state.showEmptyGroups);
      setShowEmptySubgroups(state.showEmptySubgroups);
      setVisibleColumnIds(new Set(state.visibleColumnIds));
      setColumnOrder(() => [...state.columnOrder]);
      for (const [columnId, widthPx] of Object.entries(state.columnWidths)) {
        setColumnWidth(columnId, widthPx);
      }
      setLeadingColumnWidth(state.leadingColumnWidth);
    },
    [setColumnOrder, setColumnWidth, setLeadingColumnWidth, setVisibleColumnIds]
  );
  const captureViewState = useCallback(
    (): ProjectViewState => ({
      columnOrder: [...columnOrder],
      columnWidths: { ...columnWidths },
      filters: {
        ...filters,
        assigneeIds: [...filters.assigneeIds],
        priorities: [...filters.priorities],
        statuses: [...filters.statuses],
        tagIds: [...filters.tagIds],
      },
      groupBy,
      groupOrder,
      layout,
      leadingColumnWidth,
      secondaryGroupBy,
      secondaryGroupOrder,
      showEmptyGroups,
      showEmptySubgroups,
      sortActive,
      sortBy,
      sortDir,
      visibleColumnIds: [...visibleColumnIds],
    }),
    [
      columnOrder,
      columnWidths,
      filters,
      groupBy,
      groupOrder,
      layout,
      leadingColumnWidth,
      secondaryGroupBy,
      secondaryGroupOrder,
      showEmptyGroups,
      showEmptySubgroups,
      sortActive,
      sortBy,
      sortDir,
      visibleColumnIds,
    ]
  );
  // Every entry here is one this reader saved, and it is still here on their
  // next visit. Nothing is seeded: a built-in arrangement listed beside them
  // under "Personal views" is a record nobody created shown as one they did.
  const {
    activeViewId,
    applyView,
    saveCurrentView,
    views: savedViews,
  } = useProjectSavedViews({
    captureViewState,
    restoreViewState,
    viewStateKey,
  });

  let surface: ReactNode;
  if (sortedRows.length === 0) {
    // Hoisted above the layout switch because the board has no rows to hang an
    // empty state off: a new team, or a filter that matches nothing, would get
    // a blank grid where the list offers its no-results copy and Create.
    surface = (
      <ProjectsEmptyState
        emptyStateAction={emptyStateAction}
        emptyStateCopy={emptyStateCopy}
        filtersActive={filtersActive}
      />
    );
  } else if (layout === "board") {
    surface = (
      <ProjectBoard
        // The fallback lane is the ungrouped board. A drop there resolves to
        // the "none" group, which `applyProjectGroupValue` returns unchanged,
        // so the card would animate into place and mean nothing. A host that
        // cannot persist a move disables it for the same reason.
        dragDisabled={!(groups && onProjectGroupChange)}
        getRowHref={getRowHref}
        groupBy={groupBy}
        groups={
          groups ?? [{ items: sortedRows, key: "all", label: "All projects" }]
        }
        onGroupDrop={applyGroupDrop}
        rowActions={rowActions}
        secondaryGroupBy={secondaryGroupBy}
        selection={listBulkSelection.gridSelection}
      />
    );
  } else {
    surface = (
      <div className="min-h-0 flex-1 overflow-auto">
        <ProjectsTable
          cellEditors={cellEditors}
          columnOrder={columnOrder}
          columnWidths={columnWidths}
          emptyStateAction={emptyStateAction}
          emptyStateCopy={emptyStateCopy}
          filtersActive={filtersActive}
          getRowHref={getRowHref}
          groups={groups}
          headerActions={{
            // The shared column menu offers a Filter item and hands back the
            // column id; it does not host caller-rendered content. Opening the
            // toolbar filter popover keeps "filter from this column's header"
            // reachable without a second, header-only filter surface.
            onFilter: (columnId) => {
              if (
                columnFilterGroups.some(
                  (candidate) => candidate.id === columnId
                )
              ) {
                setFilterPopoverOpen(true);
              }
            },
            onGroup: setGroupBy,
            onMove: moveVisibleColumn,
          }}
          leadingColumnWidth={leadingColumnWidth}
          onColumnOrderChange={(visibleOrder) =>
            setColumnOrder((current) => mergeColumnOrder(current, visibleOrder))
          }
          onColumnWidthChange={setColumnWidth}
          onSort={applySort}
          rowActions={rowActions}
          rows={sortedRows}
          selection={listBulkSelection.gridSelection}
          // Cleared sort restores server order, so the header must stop
          // claiming a column: `sortBy` is retained only so the menu can
          // restore it, and `sortActive` is what says it applies.
          sortBy={sortActive ? sortBy : "none"}
          sortDir={sortDir}
          visibleColumnIds={visibleColumnIds}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {searchEnabled ? (
        <ProjectListSharedToolbar
          filterController={filterController}
          filterMenu={{
            onOpenChange: setFilterPopoverOpen,
            open: filterPopoverOpen,
          }}
          filterViewModel={filterViewModel}
          groupBy={groupBy}
          groupOrder={groupOrder}
          layout={layout}
          onClearFilters={() => setFilters(INITIAL_PROJECT_FILTERS)}
          onClearSort={clearSort}
          onLayoutChange={applyLayout}
          onSort={applySort}
          savedViews={{
            activeViewId,
            onApply: applyView,
            onSave: saveCurrentView,
            views: savedViews,
          }}
          search={{ onChange: setSearchText, value: searchText }}
          secondaryGroupBy={secondaryGroupBy}
          secondaryGroupOrder={secondaryGroupOrder}
          setGroupBy={setGroupBy}
          setGroupOrder={setGroupOrder}
          setSecondaryGroupBy={setSecondaryGroupBy}
          setSecondaryGroupOrder={setSecondaryGroupOrder}
          setShowEmptyGroups={setShowEmptyGroups}
          setShowEmptySubgroups={setShowEmptySubgroups}
          setVisibleColumnIds={setVisibleColumnIds}
          showEmptyGroups={showEmptyGroups}
          showEmptySubgroups={showEmptySubgroups}
          sortActive={sortActive}
          sortBy={sortBy}
          visibleColumnIds={visibleColumnIds}
        />
      ) : (
        <>
          <div className="border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <FilterPopover
                controller={filterController}
                onClear={() => setFilters(INITIAL_PROJECT_FILTERS)}
                onOpenChange={setFilterPopoverOpen}
                open={filterPopoverOpen}
                viewModel={filterViewModel}
              />
              <div className="ml-auto hidden flex-wrap items-center justify-end gap-2 md:flex">
                <ListLayoutToggle
                  ariaLabel={PROJECT_LAYOUT_LABEL}
                  onChange={applyLayout}
                  showLabels
                  value={layout}
                />
                <TableToolbarSortMenu
                  active={sortActive}
                  columns={PROJECT_SUMMARY_COLUMNS}
                  customFields={EMPTY_METRICS}
                  leadingLabel="Project"
                  onClear={clearSort}
                  onSort={applySort}
                  sortBy={sortBy}
                />
                <TableToolbarGroupMenu
                  columns={PROJECT_SUMMARY_COLUMNS}
                  customFields={EMPTY_METRICS}
                  groupBy={groupBy}
                  groupOrder={groupOrder}
                  secondaryGroupBy={secondaryGroupBy}
                  secondaryGroupOrder={secondaryGroupOrder}
                  setGroupBy={setGroupBy}
                  setGroupOrder={setGroupOrder}
                  setSecondaryGroupBy={setSecondaryGroupBy}
                  setSecondaryGroupOrder={setSecondaryGroupOrder}
                  setShowEmptyGroups={setShowEmptyGroups}
                  setShowEmptySubgroups={setShowEmptySubgroups}
                  showEmptyGroups={showEmptyGroups}
                  showEmptySubgroups={showEmptySubgroups}
                />
                <TableToolbarOptionsMenu
                  columnIds={visibleColumnIds}
                  columns={PROJECT_SUMMARY_COLUMNS}
                  customFields={EMPTY_METRICS}
                  metricDefinitions={EMPTY_METRICS}
                  metricKeys={visibleMetricKeys}
                  setColumnIds={setVisibleColumnIds}
                  setMetricKeys={setVisibleMetricKeys}
                />
                <TableToolbarSavedViewsMenu
                  activeViewId={activeViewId}
                  onApply={applyView}
                  onSave={saveCurrentView}
                  views={savedViews}
                />
              </div>
              <div className="ml-auto flex items-center gap-2 md:hidden">
                <ListLayoutToggle
                  ariaLabel={PROJECT_LAYOUT_LABEL}
                  onChange={applyLayout}
                  showLabels={false}
                  value={layout}
                />
                <TableToolbarSavedViewsMenu
                  activeViewId={activeViewId}
                  onApply={applyView}
                  onSave={saveCurrentView}
                  views={savedViews}
                />
                <TableToolbarViewMenu
                  columnIds={visibleColumnIds}
                  columns={PROJECT_SUMMARY_COLUMNS}
                  customFields={EMPTY_METRICS}
                  groupBy={groupBy}
                  leadingLabel="Project"
                  metricDefinitions={EMPTY_METRICS}
                  metricKeys={visibleMetricKeys}
                  onAddField={() => undefined}
                  onClearSort={clearSort}
                  onSort={applySort}
                  secondaryGroupBy={secondaryGroupBy}
                  setColumnIds={setVisibleColumnIds}
                  setGroupBy={setGroupBy}
                  setMetricKeys={setVisibleMetricKeys}
                  setSecondaryGroupBy={setSecondaryGroupBy}
                  showAddFieldButton={false}
                  sortBy={sortActive ? sortBy : "none"}
                />
              </div>
            </div>
          </div>
          {filterController.activeChips.length > 0 ? (
            <ActiveFiltersBar
              controller={filterController}
              viewModel={filterViewModel}
            />
          ) : null}
        </>
      )}
      {listBulkSelection.selectionBand}
      {surface}
    </div>
  );
}

const PROJECT_NOUN = { one: "project", other: "projects" } as const;
