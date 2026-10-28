"use client";

import { SharedAnalyticsComponent } from "@repo/api/src/types/surface-analytics";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { SessionsSeamCellRenderer } from "@repo/app/agents/lib/session-list-row";
import { ProductGridTableListSurface } from "@repo/app/shared/components/product-grid-table-v2";
import {
  useFeatureFlagEnabledOptional,
  useFeatureFlagGateOptional,
} from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { SESSIONS_FOCUS_RESTORATION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { TABLE_DATE_RANGE_OPTIONS } from "@repo/app/shared/lib/table-date-range-options";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { GridInteractionState } from "@repo/design-system/lib/grid-interaction-contract";
import { useEffect, useMemo, useRef, useState } from "react";
import { ListSurfacePaginationFooter } from "../../../shared/components/list-surface-pagination-footer";
import { useCoarseNow } from "../../../shared/hooks/use-coarse-now";
import { CompleteSurfaceState } from "../../../shared/lib/complete-surface-contract";
import {
  DateRange,
  DEFAULT_DATE_RANGE,
  parseDateRange,
} from "../../../shared/lib/format-utils";
import { useSharedComponentRenderedEvent } from "../../../shared/observability/surface-analytics-context";
import { useSessionsGroupLink } from "../../hooks/use-sessions-group-link";
import { useUniversalSessionGridGroups } from "../../hooks/use-universal-session-grid-groups";
import { DEFAULT_SESSION_FACET_FILTERS } from "../../lib/session-filter-adapter";
import {
  isSessionsListReadPending,
  SessionsListReadState,
  selectSessionsListSurfaceState,
  sessionsListReadModelFromState,
} from "../../lib/sessions-list-read-state";
import { sessionsRangeSentence } from "../../lib/sessions-range-readout";
import {
  SESSIONS_ISSUES_COLUMN_ID,
  SESSIONS_PRIORITY_COLUMN_ID,
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_STATUS_COLUMN_ID,
  SESSIONS_TAGS_COLUMN_ID,
} from "../../lib/sessions-table-columns";
import { renderSessionsListBody } from "./sessions-list-body-v2";
import { useSessionsListBulkSelection } from "./sessions-list-bulk-actions";
import { createSessionsListCardCompatibility } from "./sessions-list-card-compatibility";
import {
  buildSessionsCustomFieldColumns,
  isSessionsCustomFieldGroupable,
  SessionsAddFieldDialog,
} from "./sessions-list-custom-fields";
import { SessionsListGridV2 } from "./sessions-list-grid-v2";
import { useSessionsInlineCreate } from "./sessions-list-inline-create";
import { renderSummaryMetricBand } from "./sessions-list-summary-band";
import {
  resolveGroupDropHandler,
  summaryCardMetricOptions,
} from "./sessions-list-surface-controls";
import {
  applyGroupDropWiring,
  resolveAddFieldAction,
  resolveCustomFieldGroups,
  resolveSessionsPageSize,
  resolveSessionsRows,
  resolveSessionsSortControls,
  SESSIONS_DATE_WINDOW_TICK_MS,
} from "./sessions-list-surface-model";
import {
  resolveSessionsListSurfacePaging,
  resolveSessionsListSurfaceReadState,
} from "./sessions-list-surface-paging";
import { createSessionsListSurfaceRenderers } from "./sessions-list-surface-renderers";
import {
  defaultVisibleColumnIds,
  GROUP_OPTIONS,
} from "./sessions-list-surface-rows";
import type { SessionsListSurfaceV2Props } from "./sessions-list-surface-v2-props";
import { SessionsListToolbarV2 } from "./sessions-list-toolbar-v2";
import {
  EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
  resolveSessionsListSorts,
  resolveSessionsSearchTerm,
  useSessionsListView,
} from "./sessions-list-view-state";
import {
  areAllSummaryCardsHidden,
  resolveHiddenSummaryCardIds,
  SESSIONS_SUMMARY_CARD_LABELS,
} from "./sessions-summary-card-visibility";
import { useSessionStatusColumnWidth } from "./use-session-status-column-width";
import {
  resolveSessionsFocusRestoration,
  useSessionsFocusRestoration,
} from "./use-sessions-focus-restoration";
import { useSessionsListAnalytics } from "./use-sessions-list-analytics";
import { useSessionsListColumns } from "./use-sessions-list-columns";
import { useSessionsListFilterModel } from "./use-sessions-list-filter-model";
import { useSessionsListViewActions } from "./use-sessions-list-view-actions";
import {
  sessionsLiveUpdateViewKey,
  useSessionsLiveUpdateAnnouncement,
} from "./use-sessions-live-update-announcement";

/**
 * Portable Sessions list composed from the production row model, summary
 * cards, and Grid Table v2. Hosts may supply the navigation, linked-entity,
 * persistence, mutation, and server-query seams; otherwise the surface owns a
 * complete client-side view.
 */
export function SessionsListSurfaceV2({
  bulkActions,
  className,
  columnOrder,
  columnWidths: persistedColumnWidths,
  controlledView,
  customFields,
  errorRecoveryAction,
  exportItem,
  favorites,
  getSessionHref,
  groupDrop,
  groupOptions: hostGroupOptions = GROUP_OPTIONS,
  hasConnectedAgent = true,
  hasSessionsOutsideWindow,
  hiddenSummaryCards,
  includeProjectFilter = false,
  initialDateRange = DEFAULT_DATE_RANGE,
  initialFacets = DEFAULT_SESSION_FACET_FILTERS,
  initialGrouping = EMPTY_TABLE_GROUPING,
  initialScopeUserId = null,
  initialSearch = "",
  inlineCreate,
  isError = false,
  isLoading = false,
  isPending = false,
  isPlaceholderPage = false,
  customDateWindow,
  isSyncing = false,
  loadingLabel,
  maxOffset,
  maxSortRules,
  mode = "auto",
  onAddField,
  onColumnOrderChange,
  onColumnWidthChange,
  onCustomDateWindowChange,
  onPageSizeChange,
  onResetView,
  onRetry,
  onTimezoneModeChange,
  onToggleSummaryCard,
  onboardingAction,
  pageInfo,
  pageSize = DEFAULT_TABLE_PAGE_SIZE,
  renderIssues,
  renderPriority,
  renderProjects,
  renderTags,
  resolveOwnerName,
  resolveProjectName,
  rows,
  selection,
  savedViews,
  stallPhase = "none",
  summaryCards,
  tableScrollRef,
  toolbarPrimary,
  toolbarTrailing,
  usage,
  timezoneMode,
}: SessionsListSurfaceV2Props) {
  useSharedComponentRenderedEvent(
    SharedAnalyticsComponent.SessionsListSurfaceV2
  );
  const customFieldColumns = useMemo(
    () => buildSessionsCustomFieldColumns(customFields),
    [customFields]
  );
  const customColumnIds = useMemo(
    () => customFieldColumns.map((column) => column.id),
    [customFieldColumns]
  );
  // The host's built-in set, not `GROUP_OPTIONS` directly: a CONTROLLED host
  // persists only the dimensions its own view state can round-trip, and an
  // option it cannot store is a control that moves and snaps back. Groupable
  // custom fields are appended either way — they come from the host's own field
  // definitions, so a host that supplied them can always store them.
  const groupOptions = useMemo(
    () => [
      ...hostGroupOptions,
      ...customFieldColumns
        .filter((column) => isSessionsCustomFieldGroupable(column.customField))
        .map((column) => ({ id: column.id, label: column.label })),
    ],
    [customFieldColumns, hostGroupOptions]
  );
  const [uncontrolledPageSize, setUncontrolledPageSize] = useState(pageSize);
  // The ROWS region, not the scroll band: focus restoration resolves the grid's
  // own roving tab stop, and the band also holds the toolbar and the footer.
  const listRegionRef = useRef<HTMLDivElement | null>(null);
  const [addFieldOpen, setAddFieldOpen] = useState(false);
  const addFieldAction =
    onAddField ?? resolveAddFieldAction(customFields, setAddFieldOpen);
  useEffect(() => setUncontrolledPageSize(pageSize), [pageSize]);
  const resolvedPageSize = resolveSessionsPageSize(
    pageSize,
    uncontrolledPageSize,
    Boolean(onPageSizeChange)
  );
  // Which seam-required columns THIS MOUNT can fill. A property of the host, not
  // of the build — see {@link SESSIONS_SEAM_REQUIRED_COLUMN_IDS}.
  const seamRenderers = useMemo(() => {
    const renderers = new Map<string, SessionsSeamCellRenderer>();
    if (renderProjects) {
      renderers.set(SESSIONS_PROJECTS_COLUMN_ID, renderProjects);
    }
    if (renderIssues) {
      renderers.set(SESSIONS_ISSUES_COLUMN_ID, renderIssues);
    }
    if (renderTags) {
      renderers.set(SESSIONS_TAGS_COLUMN_ID, renderTags);
    }
    if (renderPriority) {
      renderers.set(SESSIONS_PRIORITY_COLUMN_ID, renderPriority);
    }
    return renderers;
  }, [renderIssues, renderPriority, renderProjects, renderTags]);
  const [view, updateView] = useSessionsListView(controlledView, () => ({
    sortBy: null,
    sortDir: "asc",
    grouping: initialGrouping,
    facets: initialFacets,
    dateRange: initialDateRange,
    visibleColumnIds: new Set([
      ...defaultVisibleColumnIds(seamRenderers),
      ...customColumnIds,
    ]),
    page: 0,
    scopeUserId: initialScopeUserId,
    search: initialSearch,
  }));
  const {
    dateRange,
    facets,
    grouping,
    page,
    scopeUserId,
    sortBy,
    sortDir,
    visibleColumnIds,
  } = view;
  const renderedVisibleColumnIds = useMemo(
    () => withoutGroupedColumn(visibleColumnIds, grouping.primary.fieldId),
    [grouping.primary.fieldId, visibleColumnIds]
  );
  // ISS-8966: resolved ONCE, so the row filter, the active-filter count and the
  // chip cannot disagree about whether a term is a term. See
  // {@link resolveSessionsSearchTerm}.
  const searchTerm = resolveSessionsSearchTerm(view.search);
  // ISS-8216: an absent key is a view that predates this axis, not one that
  // selected nothing — see `SessionsListViewState.customFieldFilters`. Both
  // narrow nothing, so both resolve to the same shared empty map here.
  const customFieldFilters =
    view.customFieldFilters ?? EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS;
  // Clamped so the header arrow, the client-side `sortRows` and the menu cannot
  // disagree with each other about an order a capped host never applied.
  const sorts = useMemo(() => {
    const resolved = resolveSessionsListSorts(view);
    return maxSortRules === undefined
      ? resolved
      : resolved.slice(0, maxSortRules);
  }, [view, maxSortRules]);
  // FEA-4217: the host's own `hiddenSummaryCards` still seeds the strip. The
  // view state is what a READER's toggle writes, so it wins once there is one;
  // until then a host that persists hidden ids keeps being honoured rather than
  // silently rendering every card.
  const hiddenSummaryCardIds = resolveHiddenSummaryCardIds(
    view.hiddenSummaryCardIds,
    hiddenSummaryCards
  );

  const serverTotalRows = controlledView?.totalRows;
  const controlledReadState = controlledView?.readState;
  const isServerDriven =
    controlledReadState !== undefined || serverTotalRows !== undefined;

  const statusColumnWidth = useSessionStatusColumnWidth(listRegionRef);
  const {
    canChangeColumnOrder,
    columns,
    columnWidths,
    gridTemplateColumns,
    handleColumnOrderChange,
    handleColumnWidthChange,
    leadingColumnWidth,
    moveColumnFromHeader,
    renderedSpecs,
    setLeadingColumnWidth,
    toggleableColumns,
  } = useSessionsListColumns({
    statusColumnWidth,
    columnOrder,
    columnWidths: persistedColumnWidths,
    customFieldColumns,
    favoritesEnabled: Boolean(favorites),
    isServerDriven,
    onColumnOrderChange,
    onColumnWidthChange,
    onCustomColumnsAdded: (nextIds) =>
      updateView((current) => ({
        visibleColumnIds: new Set([...current.visibleColumnIds, ...nextIds]),
      })),
    seamRenderers,
    showAddField: Boolean(customFields?.onCreateField),
    visibleColumnIds: renderedVisibleColumnIds,
  });

  // Re-filtering and re-sorting a server-supplied page would narrow ONE page of
  // an already-narrowed result and re-rank it by a comparator that is not the
  // server's — dropping rows the server matched and reordering the rest.
  // ISS-8217: the window bound is time-relative, and this memo's inputs can stay
  // referentially stable indefinitely (TanStack structural sharing hands back
  // the same page across refetches), so reading the clock INSIDE the derivation
  // would freeze the window at whatever it said on the last real input change.
  // The instant is therefore an input, exactly as `useCoarseNow` documents. No
  // timer runs while the window cannot move (server-driven, or `all`), and
  // leaving `all` re-reads the clock instead of resuming from the mount instant.
  const windowNow = useCoarseNow(
    SESSIONS_DATE_WINDOW_TICK_MS,
    !isServerDriven && dateRange !== "all"
  );
  const { sorted } = useMemo(
    () =>
      resolveSessionsRows({
        customFieldFilters,
        customFields,
        dateRange,
        facets,
        isServerDriven,
        now: windowNow,
        rows,
        scopeUserId,
        search: searchTerm,
        sorts,
      }),
    [
      customFieldFilters,
      customFields,
      dateRange,
      facets,
      isServerDriven,
      rows,
      scopeUserId,
      searchTerm,
      sorts,
      windowNow,
    ]
  );

  // Read BEFORE the paging block: `changePageSize` is what the footer's page-size
  // control runs, and `resolveSessionsListSurfacePaging` decides whether to offer
  // it at all.
  const {
    applySavedView,
    applySort,
    applySorts,
    changePageSize,
    clearAllFilters,
    clearSort,
    groupFromHeader,
    saveCurrentView,
    toggleColumn,
    toggleSummaryCard,
  } = useSessionsListViewActions({
    grouping,
    hiddenSummaryCards,
    onCustomDateWindowChange,
    onPageSizeChange,
    onToggleSummaryCard,
    savedViews,
    setUncontrolledPageSize,
    sorts,
    updateView,
    view,
  });

  // Client-side, grouping and pagination are mutually exclusive: the whole
  // population is in `rows`, so every group renders whole, and a page boundary
  // cutting through one would render a section header with rows missing
  // beneath it.
  //
  // Server-driven the population is NOT in hand — `rows` is one page of it — so
  // a grouped view is page-scoped, which is what the desktop host does today.
  // That is why the groups state no COUNT there: a page is not the population.
  // It is also why the paginator has to STAY (review cid 3845403843): scoping
  // the groups to a page while removing the only control that reaches the other
  // pages strands the reader on whichever page grouping was switched on from.
  // Whether grouping should instead mean the whole result set is a product
  // question ISS-7865 escalated rather than answered.
  const isGrouped = grouping.primary.fieldId !== null;
  // Server-driven, the page count comes from the SERVER's settled total; an
  // unknown total must not be folded into a confident page-1 clamp.
  const readState = resolveSessionsListSurfaceReadState({
    controlledReadState,
    isError,
    isPending,
    isPlaceholderPage,
    isServerDriven,
    isSyncing,
    serverTotalRows,
  });
  const readModel = sessionsListReadModelFromState(
    readState,
    isServerDriven ? serverTotalRows : sorted.length
  );
  const isListReadPending = isPending || isSessionsListReadPending(readState);
  const isListReadSyncing =
    isSyncing || readState === SessionsListReadState.Syncing;
  const {
    footerOnPageSizeChange,
    footerTotalRows,
    isAwaitingClampedPage,
    isRangeUnsettled,
    pagedRows,
    safePage,
    showPagination,
    totalPages,
  } = resolveSessionsListSurfacePaging({
    changePageSize,
    isGrouped,
    isPending: isListReadPending,
    isPlaceholderPage,
    isServerDriven,
    maxOffset,
    onPageSizeChange,
    page,
    pageInfo,
    readState,
    resolvedPageSize,
    rows: sorted,
    serverTotalRows,
  });
  const isPageCorrectionPending = isServerDriven && safePage !== page;
  // Client-side the clamp also governed the slice, so correcting the footer
  // corrected the rows. Server-driven there is no slice: the host built its read
  // from its OWN page, so a page the rows did not come from has to be reported
  // back or the footer says "3 of 3" over the empty answer to a request for
  // page 12.
  useEffect(() => {
    if (isPageCorrectionPending && !isListReadPending) {
      updateView({ page: safePage });
    }
  });
  /*
   * ISS-9555: has this surface stopped moving its own page index?
   *
   * `safePage` is DERIVED, and it moves for reasons that are not the reader: a
   * clamp that only becomes a clamp once the total lands, a producer echo naming
   * a different page, and the write-back above correcting an out-of-range
   * request down to the last real page. Each of those settles ONTO the page the
   * reader is looking at, so the focus resume must not read any of them as the
   * reader turning away — that spent the resume on a cold return to a deep page
   * and cleared the very row that had just been painted.
   *
   * Both halves are load-bearing. A read still in flight has no page index worth
   * believing, and a clamp that has not yet agreed with the host's own `page` is
   * one write-back away from moving again.
   */
  const isViewPageSettled = !(isListReadPending || isPageCorrectionPending);
  const legacyGroups = useMemo(
    () => resolveCustomFieldGroups(isGrouped, sorted, grouping, customFields),
    [customFields, grouping, isGrouped, sorted]
  );
  const presentedGroups = useUniversalSessionGridGroups(legacyGroups, grouping);
  const groups = useMemo(
    () => applyGroupDropWiring(presentedGroups, grouping, groupDrop),
    [groupDrop, grouping, presentedGroups]
  );
  const {
    activeFiltersViewModel,
    filterController,
    filterViewModel,
    filtersActive,
    getHeaderFilterContent,
    listNarrowed,
    showAllTimeOffered,
  } = useSessionsListFilterModel({
    clearAllFilters,
    customDateWindow,
    customFieldColumns,
    customFieldFilters,
    customFields,
    dateRange,
    facets,
    hasSessionsOutsideWindow,
    includeProjectFilter,
    isServerDriven,
    resolveOwnerName,
    resolveProjectName,
    rows,
    scopeUserId,
    searchTerm,
    sorted,
    updateView,
    usage,
  });
  const surfaceState = selectSessionsListSurfaceState({
    hasActiveFilters: listNarrowed,
    hasCompletePopulation:
      readModel.hasKnownTotal && readModel.totalRows === sorted.length,
    readModel,
    visibleRowCount: sorted.length,
  });
  const isListReadError = isSessionsListReadError(surfaceState, sorted.length);

  // No producer can sort by session NAME: it is absent from
  // `AGENT_SESSION_SORT_COLUMNS` and from `SessionSortKey`. Client-side
  // `sortRows` reads it, so the lead column sorts for real; server-driven it
  // would light the header arrow and the Sort menu over the server's untouched
  // default order.
  const { leadSortKey, sortOptions } =
    resolveSessionsSortControls(isServerDriven);
  const availableSortOptions = isServerDriven
    ? sortOptions
    : [
        ...sortOptions,
        ...customFieldColumns
          .filter((column) => column.customField.isSortable)
          .map((column) => ({ id: column.id, label: column.label })),
      ];
  const groupCollapse = useSessionsGroupLink({
    view,
    grouping,
    groupOptions,
    groups,
    updateView,
  });
  const handleGroupDrop = resolveGroupDropHandler(groupDrop, grouping);
  // ISS-9555: where the reader's keyboard goes when the rows underneath it are
  // replaced. The gate picks between three whole shapes HERE, at its one read
  // site, and what crosses the boundary below is a cell KEY or nothing — never
  // the booleans, which would turn one answer into several that can settle at
  // different moments (`scripts/lint/rules/no-threaded-feature-flag.ts`).
  //
  // The GATE reader, not the bare one: `useFeatureFlagEnabledOptional` reports
  // `false` while PostHog has not answered, and on web that answer lands after
  // mount. The resume below is read from a module store exactly once per visit,
  // so a gate that reads closed at that instant loses the reader's row for the
  // whole visit even after the flag flips on. `isReady` is that distinction, and
  // its deadline is why a flag service that never answers still settles closed.
  const focusRestorationGate = useFeatureFlagGateOptional(
    SESSIONS_FOCUS_RESTORATION_FEATURE_FLAG_KEY
  );
  const focusRestoration =
    resolveSessionsFocusRestoration(focusRestorationGate);
  const preferredActiveCellKey = useSessionsFocusRestoration({
    ...focusRestoration,
    pageIndex: safePage,
    pageSettled: isViewPageSettled,
    regionRef: listRegionRef,
  });
  const { renderGridCell, renderGridLead } = createSessionsListSurfaceRenderers(
    {
      customFieldColumns,
      customFields,
      getSessionHref,
      seamRenderers,
    }
  );
  const universalArtifactStatusEnabled = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  const inlineCreateRows = useSessionsInlineCreate({
    controller: inlineCreate,
    gridTemplateColumns,
    isGrouped,
  });

  const changeDateRange = (next: DateRange) => {
    // The explicit window supersedes the preset, and while one is active NO
    // preset reads as selected — so the preset the reader clicks may equal the
    // stored `dateRange` and move nothing. The window is dropped first so that
    // click is never a dead control.
    onCustomDateWindowChange?.(null);
    updateView({ dateRange: next, page: 0 });
  };
  const body = renderSessionsListBody({
    errorRecoveryAction,
    filtersActive,
    hasConnectedAgent,
    isAwaitingClampedPage,
    isError: isListReadError,
    isPending: isListReadPending,
    isPlaceholderPage,
    isSyncing: isListReadSyncing,
    listNarrowed,
    loadingLabel,
    onboardingAction,
    onClearFilters: clearAllFilters,
    onRetry,
    onShowAllTime: () => changeDateRange(DateRange.AllTime),
    rowCount: sorted.length,
    showAllTimeOffered,
    stallPhase,
  });
  const rowSelection = useSessionsListBulkSelection({
    bulkActions,
    controller: selection,
    favorites,
    reconcileVisibleRows: body !== null,
    rows: pagedRows,
  });
  const cardCompatibility = createSessionsListCardCompatibility({
    customFieldColumns,
    customFields,
    getSelectionLabel:
      rowSelection.gridSelection?.getCompatibilityCardSelectionLabel,
    getSessionHref,
    seamRenderers,
    showStatus: !(
      universalArtifactStatusEnabled &&
      grouping.primary.fieldId === SESSIONS_STATUS_COLUMN_ID
    ),
  });
  // The READ's own failure, not the surface's presentation verdict: an empty
  // page past the end of the list is a successful read awaiting page
  // correction, which `isListReadError` also folds in (whitlockk review, #9123).
  useSessionsListAnalytics({
    isError: isSessionsListReadFailure(readState),
    isPending: !isViewPageSettled,
    isPlaceholderPage,
    isServerDriven,
    rowCount: pagedRows.length,
  });
  const liveUpdateAnnouncement = useSessionsLiveUpdateAnnouncement({
    isError: isListReadError,
    isPending: isListReadPending,
    isPlaceholderPage,
    pageIndex: safePage,
    pageSize: resolvedPageSize,
    rows: pagedRows,
    total: footerTotalRows,
    viewKey: sessionsLiveUpdateViewKey({
      customDateWindow,
      customFieldFilters,
      dateRange,
      facets,
      grouping,
      scopeUserId,
      searchTerm,
      sorts,
    }),
  });
  const listContent = (
    <SessionsListGridV2
      cardCompatibility={cardCompatibility}
      columnOrder={renderedSpecs.map((spec) => spec.id)}
      columns={columns}
      columnWidths={columnWidths}
      favorites={favorites}
      gridTemplateColumns={gridTemplateColumns}
      groupCollapse={groupCollapse}
      groups={groups}
      headerActions={{
        getFilterContent: getHeaderFilterContent,
        onGroup: groupFromHeader,
        onMove: canChangeColumnOrder ? moveColumnFromHeader : undefined,
      }}
      interactionState={resolveSessionsGridInteractionState({
        isError: isListReadError,
        isPlaceholderPage,
      })}
      items={groups ? [] : [...pagedRows]}
      leadingColumnWidth={leadingColumnWidth}
      leadingSortKey={leadSortKey}
      mode={mode}
      onAddField={addFieldAction}
      onColumnOrderChange={
        canChangeColumnOrder ? handleColumnOrderChange : undefined
      }
      onColumnWidthChange={handleColumnWidthChange}
      onGroupDrop={handleGroupDrop}
      onLeadingColumnWidthChange={setLeadingColumnWidth}
      onSort={(fieldId, direction) => applySort(fieldId, direction)}
      preferredActiveCellKey={preferredActiveCellKey}
      renderAfterGroup={inlineCreateRows.renderAfterGroup}
      renderAfterRows={inlineCreateRows.renderAfterRows}
      renderCell={renderGridCell}
      renderLead={renderGridLead}
      selection={rowSelection.gridSelection}
      showGroupCounts={!isServerDriven}
      sortBy={sortBy}
      sortDir={sortDir}
    />
  );
  const summaryCardMetrics = summaryCardMetricOptions(
    hiddenSummaryCards,
    onToggleSummaryCard,
    SESSIONS_SUMMARY_CARD_LABELS
  );
  const tableContent = body ?? listContent;

  return (
    <>
      <ProductGridTableListSurface
        bulkActions={rowSelection.selectionBand}
        className={className}
        metrics={renderSummaryMetricBand({
          allHidden: areAllSummaryCardsHidden(hiddenSummaryCardIds),
          hiddenSummaryCards: hiddenSummaryCardIds,
          isLoading,
          summaryCards,
          usage,
        })}
        pagination={
          // Genuinely `null`, not an element that renders null: the surface
          // wraps a truthy `pagination` in a bordered footer, so returning null
          // from inside would leave an empty bordered strip under the table.
          showPagination ? (
            <ListSurfacePaginationFooter
              formatRange={sessionsRangeSentence}
              isPlaceholderPage={isPlaceholderPage}
              isRangeUnsettled={isRangeUnsettled}
              onPageChange={(next) => updateView({ page: next })}
              onPageSizeChange={footerOnPageSizeChange}
              page={safePage}
              pageSize={resolvedPageSize}
              rowsOnPage={pagedRows.length}
              total={footerTotalRows}
              totalPages={totalPages}
            />
          ) : null
        }
        table={
          <div data-testid={SESSIONS_HISTORY_LIST_TEST_ID} ref={listRegionRef}>
            <SessionsLiveUpdateStatus
              announcement={liveUpdateAnnouncement}
              besideRows={body === null}
            />
            {tableContent}
          </div>
        }
        tableScrollRef={tableScrollRef}
        toolbar={
          <SessionsListToolbarV2
            activeFiltersViewModel={
              filtersActive ? activeFiltersViewModel : undefined
            }
            columns={toggleableColumns}
            customDateWindow={customDateWindow}
            dateRange={dateRange}
            dateRangeOptions={TABLE_DATE_RANGE_OPTIONS}
            exportItem={exportItem}
            filterController={filterController}
            filterViewModel={filterViewModel}
            hiddenSummaryCardIds={hiddenSummaryCardIds}
            onAddField={addFieldAction}
            onApplySavedView={applySavedView}
            onClearFilters={clearAllFilters}
            onCustomDateWindowChange={
              onCustomDateWindowChange === undefined
                ? undefined
                : (next) => {
                    onCustomDateWindowChange(next);
                    // Always followed by a view change, so a host folding a
                    // CLEAR into `onChange` is never left holding an unspent
                    // one. That does not exempt a PICK from the one-write rule:
                    // a host whose window callback has already written the URL,
                    // page reset included, must not read this `page: 0` as a
                    // move still to make, or it writes a second time off the
                    // pre-click params and drops the window. Page 0 because the
                    // row set moves underneath: page N of one window is not
                    // page N of another.
                    updateView({ page: 0 });
                  }
            }
            onDateRangeChange={(next) => changeDateRange(parseDateRange(next))}
            onResetView={onResetView}
            onSaveView={saveCurrentView}
            onTimezoneModeChange={onTimezoneModeChange}
            onToggleColumn={toggleColumn}
            onToggleSummaryCard={toggleSummaryCard}
            savedViews={savedViews}
            search={{
              onChange: (next) => updateView({ page: 0, search: next }),
              value: view.search ?? "",
            }}
            sortGrouping={{
              grouping,
              groupOptions,
              maxSortRules,
              onClearSort: clearSort,
              onGroupingChange: (next) =>
                updateView({ grouping: next, page: 0 }),
              onSort: applySort,
              onSortsChange: applySorts,
              sortBy,
              sortOptions: availableSortOptions,
              sorts,
            }}
            summaryCards={summaryCardMetrics}
            timezoneMode={timezoneMode}
            toolbarPrimary={toolbarPrimary}
            toolbarTrailing={toolbarTrailing}
            visibleColumnIds={visibleColumnIds}
          />
        }
      />
      <SessionsAddFieldDialog
        controller={customFields}
        onOpenChange={setAddFieldOpen}
        open={addFieldOpen}
      />
    </>
  );
}

/**
 * The Sessions listing's stable anchor on the ROWS region — skeleton, empty
 * state and grid alike — as distinct from the scrolling band around it
 * (`GRID_TABLE_SCROLL_BAND_TEST_ID`).
 *
 * ISS-7052 Part A: this is the same anchor the v1 host renders, and it has to
 * survive the surface swap. The flag decides which listing mounts, not whether
 * the listing can be addressed: every Sessions e2e scopes its row assertions
 * through this id, so a v2 surface without it makes each of them resolve
 * against nothing the moment `grid-table-v2` opens. Exported so the v1 host
 * spells it once rather than keeping a second copy.
 */
export const SESSIONS_HISTORY_LIST_TEST_ID = "sessions-history-list";

function withoutGroupedColumn(
  visibleColumnIds: ReadonlySet<string>,
  groupedColumnId: string | null
): ReadonlySet<string> {
  if (!(groupedColumnId && visibleColumnIds.has(groupedColumnId))) {
    return visibleColumnIds;
  }
  const next = new Set(visibleColumnIds);
  next.delete(groupedColumnId);
  return next;
}

function isSessionsListReadError(
  surfaceState: CompleteSurfaceState,
  visibleRowCount: number
): boolean {
  // A zero-row partial read cannot license either canonical empty narrative.
  return (
    surfaceState === CompleteSurfaceState.Error ||
    surfaceState === CompleteSurfaceState.Unavailable ||
    (surfaceState === CompleteSurfaceState.Partial && visibleRowCount === 0)
  );
}

function resolveSessionsGridInteractionState({
  isError,
  isPlaceholderPage,
}: {
  isError: boolean;
  isPlaceholderPage: boolean;
}): GridInteractionState | undefined {
  if (isPlaceholderPage) {
    return GridInteractionState.Loading;
  }
  return isError ? GridInteractionState.Error : undefined;
}

/**
 * An implicit `status` role, not `aria-live`: Radix's hideOthers keeps every
 * `[aria-live]` ancestor exposed, so an explicit attribute left this whole page
 * readable behind a modal. Mounted only beside rows, the only state a
 * replacement can be announced over.
 */
function SessionsLiveUpdateStatus({
  announcement,
  besideRows,
}: Readonly<{ announcement: string | null; besideRows: boolean }>) {
  if (!besideRows) {
    return null;
  }
  return (
    <output
      aria-atomic="true"
      className="sr-only"
      data-testid="sessions-live-update-status"
    >
      {announcement}
    </output>
  );
}

/** Whether the list READ itself failed, as distinct from an empty page. */
function isSessionsListReadFailure(readState: SessionsListReadState): boolean {
  return (
    readState === SessionsListReadState.Error ||
    readState === SessionsListReadState.Unavailable
  );
}
