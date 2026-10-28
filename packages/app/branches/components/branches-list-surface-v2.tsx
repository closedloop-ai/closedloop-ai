"use client";

import { CollaboratorArtifactType } from "@repo/api/src/types/artifact-collaborators";
import type { BranchAnalytics } from "@repo/api/src/types/branch";
import { BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY } from "@repo/api/src/types/branches-list-column-controls-flag";
import { BranchesListRolloutDecisionReason } from "@repo/api/src/types/branches-list-rollout";
import {
  GridviewRolloutDecisionOutcome,
  SharedAnalyticsComponent,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import type { EntityListCustomFieldsController } from "@repo/app/custom-fields/hooks/use-entity-list-custom-fields-controller";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { useApiAdapterOptional } from "@repo/app/shared/api/provider";
import { useOptionalAuthSnapshot } from "@repo/app/shared/auth/use-auth-snapshot";
import { ProductGridTableListSurface } from "@repo/app/shared/components/product-grid-table-v2";
import {
  useFeatureFlagEnabledOptional,
  useFeatureFlagGateOptional,
} from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useArtifactCollaboratorSource } from "@repo/app/shared/hooks/use-artifact-collaborators";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  type TableCollapsedGroups,
  tableGroupCollapsePort,
} from "@repo/app/shared/lib/table-collapsed-groups";
import {
  useSharedComponentRenderedEvent,
  useSurfaceAnalytics,
} from "@repo/app/shared/observability/surface-analytics-context";
import type { GridTableListSurfaceMode } from "@repo/design-system/components/ui/grid-table-list-surface";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { TableBulkActionDescriptor } from "@repo/design-system/components/ui/table-bulk-actions";
import type { TableGroupingState } from "@repo/design-system/components/ui/table-toolbar-model";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { GridInteractionState } from "@repo/design-system/lib/grid-interaction-contract";
import type {
  GridTableV2Group,
  GridTableV2Props,
  GridTableV2SelectionProps,
} from "@repo/design-system/lib/grid-table-v2-types";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useListBulkSelection } from "../../shared/components/generic-artifact-surface/use-list-bulk-selection";
import { ListSurfacePaginationFooter } from "../../shared/components/list-surface-pagination-footer";
import { CompleteSurfaceState } from "../../shared/lib/complete-surface-contract";
import { shouldRenderListPagination } from "../../shared/lib/list-pagination-visibility";
import type { LoadingStallPhase } from "../../shared/lib/loading-stall-phase";
import type { BranchesDataSource } from "../data-source/branches-data-source";
import {
  useBranchesDataSourceOptional,
  useBranchesQueryContext,
} from "../data-source/provider";
import { useBranchGroups } from "../hooks/use-branch-groups";
import { useBranchesListRolloutTelemetry } from "../hooks/use-branches-list-rollout-telemetry";
import { branchRowsWithArtifactInteractions } from "../lib/branch-artifact-interactions";
import type { BranchCohortNoticeModel } from "../lib/branch-cohort-transparency";
import {
  withoutBranchPriorityColumn,
  withoutBranchProjectColumn,
  withoutBranchTagsColumn,
} from "../lib/branch-column-view-model";
import {
  type BranchesListState,
  BranchesListStateKind,
  resolveBranchesListState,
  selectBranchesListSurfaceState,
} from "../lib/branch-list-state";
import type { BranchRow, BranchRowSession } from "../lib/branch-row";
import {
  DEFAULT_BRANCH_SORT_DIR,
  DEFAULT_BRANCH_SORT_KEY,
} from "../lib/branch-sort-group";
import { BRANCHES_NOUN } from "../lib/branches-noun";
import { branchesRangeReadout } from "../lib/branches-range-readout";
import { resolveBranchesSummaryCardVisibility } from "../lib/branches-summary-card-visibility";
import {
  APPROVED_BRANCH_COLUMN_SPECS,
  type ApprovedBranchColumnSpec,
  type ApprovedBranchLeadRenderInput,
} from "./approved-branches-grid-adapter";
import {
  type BranchesCustomFieldColumns,
  useBranchesCustomFieldColumns,
} from "./branch-custom-field-columns";
import {
  BranchesGridV2,
  BranchesGridV2WithRowActions,
} from "./branches-grid-v2";
import { BranchesListStateView } from "./branches-list-state-view";
import { BranchesListSummaryBand } from "./branches-list-summary-band";
import {
  type BranchesColumnControls,
  BranchesListToolbarV2,
} from "./branches-list-toolbar-v2";
import type { BranchesStallCta } from "./branches-stall-cta";
import type { BranchesToolbarProps } from "./branches-toolbar-model";

/** Shared Branch list surface; the sessions cell owns its count/chips swap. */
export function BranchesListSurfaceV2(props: BranchesListSurfaceV2Props) {
  useSharedComponentRenderedEvent(
    SharedAnalyticsComponent.BranchesListSurfaceV2
  );
  const source = useBranchesDataSourceOptional();
  if (source?.collaborators) {
    return <BranchesListWithArtifactInteractions {...props} source={source} />;
  }
  return <BranchesListSurfaceV2Shell {...props} />;
}

function BranchesListSurfaceV2Shell({
  allRows,
  bulkActions,
  className,
  collapsedGroups,
  columnOrder,
  columnWidths,
  customFields,
  getBranchHref,
  getSessionsHref,
  getSessionHref,
  grouping,
  hasActiveFilters,
  hasWindow,
  hasCompletePopulation = false,
  historyListTestId,
  includePriorityColumn = false,
  includeProjectColumn = false,
  includeTagsColumn = false,
  isError,
  isPending,
  isPlaceholderData,
  items,
  githubConnect,
  githubConnectOutcome,
  githubReturnStatus,
  onPageChange,
  onPageSizeChange,
  onRetry,
  onShowAllTime,
  onSummaryRetry,
  onColumnOrderChange,
  onColumnWidthChange,
  onCollapsedGroupsChange,
  onGroupingChange,
  onSort,
  page,
  pageSize,
  renderBranchLink,
  renderBranchStatus,
  sortBy,
  sortDir,
  stallCta,
  stallPhase = "none",
  tableScrollRef,
  tableScrollAttributes,
  tableScrollTestId,
  tagsReadOnly = false,
  toolbar,
  total,
  totalPages,
  cohortNotice,
  comparisonSuppressedByFilter,
  summaryAnalyticsErrored,
  summaryCards,
  summaryCardsErrored,
  summaryCardsPending,
  summaryCardsReloading,
  trendSparkline,
  visibleColumns,
}: BranchesListSurfaceV2Props) {
  // ISS-9216: this surface decides whether its own footer renders. Both hosts
  // used to compute a `showPagination` boolean and put it through
  // `shouldShowBranchListV2Pagination` — a rule that lived outside the component
  // it governs, which is how Sessions ended up answering the same question a
  // third way.
  const surfaceState = selectBranchesListSurfaceState({
    hasActiveFilters,
    hasCompletePopulation,
    hasWindow,
    isError,
    isPending,
    totalRows: total,
    visibleRowCount: items.length,
  });
  // The body mounts the grid only on this ladder's Rows rung, so the host
  // reconciles whenever the grid is not there to report its own rows.
  const bodyState = resolveBranchesListState({
    hasActiveFilters,
    hasWindow,
    isError,
    isPending,
    totalRows: total,
    visibleRowCount: items.length,
  });
  useBranchesListRolloutTelemetry({
    rows: allRows,
    total,
    hasCompletePopulation,
    isPending,
  });
  const selection = useListBulkSelection<BranchRow>({
    actions: bulkActions ?? [],
    enabled: (bulkActions?.length ?? 0) > 0,
    getRowLabel: (row) => row.branchName,
    noun: BRANCHES_NOUN,
    reconcileVisibleRows: bodyState.kind !== BranchesListStateKind.Rows,
    rows: items,
  });
  const showPagination = shouldRenderListPagination({
    hasPageableRows:
      total > 0 &&
      (surfaceState === CompleteSurfaceState.Ready ||
        surfaceState === CompleteSurfaceState.Partial),
    isGroupedClientSide: false,
    isPagingPlaceholder: isPlaceholderData,
  });
  const columnControls = useBranchColumnControls({
    grouping,
    onGroupingChange,
    onSort,
    sortBy,
    sortDir,
  });
  // Memoized for identity: the column registry is cached per spec array.
  const renderedColumnSpecs = useMemo(() => {
    const withPriorityOptIn = includePriorityColumn
      ? APPROVED_BRANCH_COLUMN_SPECS
      : withoutBranchPriorityColumn(APPROVED_BRANCH_COLUMN_SPECS);
    const withTagsOptIn = includeTagsColumn
      ? withPriorityOptIn
      : withoutBranchTagsColumn(withPriorityOptIn);
    return includeProjectColumn
      ? withTagsOptIn
      : withoutBranchProjectColumn(withTagsOptIn);
  }, [includePriorityColumn, includeProjectColumn, includeTagsColumn]);
  // ISS-9676: bands over the rows the table is RENDERING, not over the corpus.
  // `items` is one server page in bounded List mode, so a corpus-wide band would
  // be a claim this component cannot make; the paginator stays for the same
  // reason (`isGroupedClientSide` above means "the groups ARE the page unit",
  // which this is not) and the bands carry no counts, so nothing on screen
  // reports a population it did not read.
  //
  // `allRows` is the label CONTEXT and not the partition set: the repository
  // cells name themselves against the whole filtered corpus, so a band naming
  // itself against the page alone would contradict its own rows (whitlockk review).
  const groups = useBranchGroups(items, allRows, columnControls.grouping);
  const customFieldColumns = useBranchesCustomFieldColumns(
    customFields,
    visibleColumns
  );
  // ISS-9582: a collapsed key with no band here is provably stale only when the
  // rows on screen are the WHOLE corpus: served complete, not client-paged, and
  // not narrowed by a facet or a date window. Otherwise its band may be on
  // another page or outside the current scope, and dropping the key would
  // reopen that band the moment the reader came back to it.
  const rendersWholeCorpus =
    hasCompletePopulation &&
    !hasActiveFilters &&
    !hasWindow &&
    items.length === allRows.length;
  const groupCollapse = columnControls.grouping
    ? tableGroupCollapsePort({
        collapsedGroups,
        grouping: columnControls.grouping,
        groups,
        isCompletePopulation: rendersWholeCorpus,
        onCollapsedGroupsChange,
      })
    : undefined;
  const renderTableContent = (mode: GridTableListSurfaceMode) => (
    <BranchesListSurfaceV2Body
      allRows={allRows}
      columnOrder={columnOrder}
      columnSpecs={renderedColumnSpecs}
      columnWidths={columnWidths}
      customFieldColumns={customFieldColumns}
      getBranchHref={getBranchHref}
      getSessionHref={getSessionHref}
      getSessionsHref={getSessionsHref}
      groupCollapse={groupCollapse}
      groups={groups}
      interactionState={resolveBranchesGridInteractionState({
        isError,
        isPlaceholderData,
      })}
      items={items}
      mode={mode}
      onColumnOrderChange={onColumnOrderChange}
      onColumnWidthChange={onColumnWidthChange}
      onRetry={onRetry}
      onShowAllTime={onShowAllTime}
      onSort={onSort}
      renderBranchLink={renderBranchLink}
      renderBranchStatus={getBranchHref ? undefined : renderBranchStatus}
      selection={selection.gridSelection}
      sortBy={sortBy}
      sortDir={sortDir}
      stallCta={stallCta}
      stallPhase={stallPhase}
      state={bodyState}
      tagsReadOnly={tagsReadOnly}
      visibleColumns={visibleColumns}
    />
  );
  const hiddenSummaryCards = toolbar.onToggleSummaryCard
    ? toolbar.hiddenSummaryCards
    : undefined;
  // The band also carries the GitHub connection feedback, which must outlive
  // the cards being hidden.
  const hasSummaryBandContent =
    !resolveBranchesSummaryCardVisibility(hiddenSummaryCards).allHidden ||
    Boolean(githubConnectOutcome) ||
    Boolean(githubReturnStatus);
  return (
    <>
      <ProductGridTableListSurface
        bulkActions={selection.selectionBand}
        className={className}
        metrics={
          hasSummaryBandContent ? (
            <div className="flex min-w-0 flex-col gap-3">
              <BranchesListSummaryBand
                cohortNotice={cohortNotice}
                comparisonSuppressedByFilter={comparisonSuppressedByFilter}
                dateRange={toolbar.dateRange}
                githubConnect={githubConnect}
                githubConnectOutcome={githubConnectOutcome}
                githubReturnStatus={githubReturnStatus}
                hiddenSummaryCards={hiddenSummaryCards}
                onSummaryRetry={onSummaryRetry}
                summaryAnalyticsErrored={summaryAnalyticsErrored}
                summaryCards={summaryCards}
                summaryCardsErrored={summaryCardsErrored}
                summaryCardsPending={summaryCardsPending}
                summaryCardsReloading={summaryCardsReloading}
                trendSparkline={trendSparkline}
              />
            </div>
          ) : undefined
        }
        pagination={
          showPagination ? (
            <ListSurfacePaginationFooter
              formatRange={branchesRangeReadout}
              isPlaceholderPage={isPlaceholderData}
              isRangeUnsettled={isPending}
              onPageChange={onPageChange}
              onPageSizeChange={onPageSizeChange}
              page={page}
              pageSize={pageSize}
              rowsOnPage={items.length}
              total={total}
              totalPages={totalPages}
            />
          ) : null
        }
        table={(mode) => (
          <div data-testid={historyListTestId}>{renderTableContent(mode)}</div>
        )}
        tableScrollAttributes={tableScrollAttributes}
        tableScrollRef={tableScrollRef}
        tableScrollTestId={tableScrollTestId}
        toolbar={(mode) => (
          <BranchesListToolbarV2
            {...toolbar}
            columnControls={columnControls}
            customFieldColumns={customFieldColumns}
            includePriorityColumn={includePriorityColumn}
            includeProjectColumn={includeProjectColumn}
            includeTagsColumn={includeTagsColumn}
            mode={mode}
          />
        )}
      />
      {customFieldColumns.addFieldDialog}
    </>
  );
}

type BranchesListSurfaceV2Props = {
  allRows: BranchRow[];
  /**
   * Host-supplied operations; absent or empty, the list is not selectable. A
   * host's adapter returns them by capability, never by the rows on a page.
   */
  bulkActions?: readonly TableBulkActionDescriptor[];
  className?: string;
  /**
   * ISS-9582: the bands collapsed under each grouping axis, held with the
   * grouping it belongs to so a saved view and a link restore both. Absent — a
   * story, a unit mount — the grid remembers collapse for the mount only.
   */
  collapsedGroups?: TableCollapsedGroups;
  columnOrder?: readonly string[];
  columnWidths?: Readonly<Record<string, number>>;
  cohortNotice: BranchCohortNoticeModel;
  /**
   * ISS-12663: the org custom-field columns this host can read and write —
   * `useBranchesCustomFieldsController`. Absent (the desktop local store, a
   * story), the list offers built-in columns only.
   */
  customFields?: EntityListCustomFieldsController;
  comparisonSuppressedByFilter: boolean;
  getBranchHref?: (item: BranchRow) => string;
  getSessionsHref?: (item: BranchRow) => string;
  /**
   * ISS-8972 — where one linked Session's chip goes in THIS shell's routing.
   *
   * A host capability, not presentation: the Session detail path is the host's
   * (web prefixes the org slug, the desktop renderer resolves an unprefixed path
   * through its route table), so the surface cannot build one. A host that omits
   * it gets read-only chips rather than dead links.
   */
  getSessionHref?: (session: BranchRowSession) => string;
  /**
   * The host's persisted grouping axis (ISS-9676, davetho review).
   *
   * Grouping is a saved-view dimension, so the state has to live where the
   * saved view is captured and applied — `useBranchViewState`, beside sort and
   * the column set — or a reader groups the list, saves the view, and gets it
   * back ungrouped. Optional so a mount with no view state (a story, a unit
   * test) still renders; a HOST that omits it is a wiring bug, which the
   * Branches host-capability parity ledger fails on.
   */
  grouping?: TableGroupingState;
  /** A facet filter is narrowing the corpus — `branchFiltersAreActive`. */
  hasActiveFilters: boolean;
  /** A bounded date window is narrowing the corpus. */
  hasWindow: boolean;
  /** Whether visible rows represent the complete served population. */
  hasCompletePopulation?: boolean;
  historyListTestId?: string;
  /**
   * ISS-10332 (#7762 review): the host's source serves `priority`. Absent, the
   * surface renders no Priority column and offers no Columns, Sort or Filter
   * entry for it — the desktop local store omits the field on every row.
   */
  includePriorityColumn?: boolean;
  /**
   * ISS-12456: the host's source serves `project`. Absent, the surface
   * renders no Project column and offers no Columns-picker entry for it —
   * same cloud Artifact-identity gap as `includeTagsColumn`.
   */
  includeProjectColumn?: boolean;
  /**
   * ISS-12456: the host's source serves `tags`. Absent, the surface renders
   * no Tags column and offers no Columns-picker entry for it — the desktop
   * local store's rows carry no cloud Artifact identity to look tags up by.
   */
  includeTagsColumn?: boolean;
  isError: boolean;
  isPending: boolean;
  /** A placeholder page is in flight — query state, not a render decision. */
  isPlaceholderData: boolean;
  items: BranchRow[];
  githubReturnStatus?: string | null;
  /** The connect ask a summary card with an unavailable value offers. */
  githubConnect?: GitHubConnectTarget;
  /** See {@link BranchesListSummaryBandProps}'s `githubConnectOutcome`. */
  githubConnectOutcome?: ReactNode;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onRetry: () => void;
  onShowAllTime: () => void;
  onSummaryRetry: () => unknown;
  onColumnOrderChange?: (nextOrder: string[]) => void;
  onColumnWidthChange?: (columnId: string, widthPx: number) => void;
  onCollapsedGroupsChange?: (collapsedGroups: TableCollapsedGroups) => void;
  onGroupingChange?: (grouping: TableGroupingState) => void;
  onSort: (column: string, direction: SortDirection) => void;
  page: number;
  pageSize: number;
  renderBranchLink?: (input: ApprovedBranchLeadRenderInput) => ReactNode;
  /** Optional status-cell renderer for fixture adapters with a wider source vocabulary. */
  renderBranchStatus?: (item: BranchRow) => ReactNode;
  sortBy: string;
  sortDir: SortDirection;
  /** ISS-10645 @see BranchesListStateView.stallCta */
  stallCta?: BranchesStallCta;
  /** ISS-10645: how long this host's blocking read has run. */
  stallPhase?: LoadingStallPhase;
  tableScrollRef?: (node: HTMLElement | null) => void;
  tableScrollAttributes?: ComponentProps<
    typeof ProductGridTableListSurface
  >["tableScrollAttributes"];
  tableScrollTestId?: string;
  tagsReadOnly?: boolean;
  toolbar: BranchesToolbarProps;
  summaryAnalyticsErrored: boolean;
  summaryCards: BranchAnalytics | undefined;
  summaryCardsErrored: boolean;
  summaryCardsPending: boolean;
  summaryCardsReloading: boolean;
  /**
   * ISS-10544: forwarded straight to the summary band, which explains it. The
   * surface takes no view on it — it is the HOST's answer, and the two hosts
   * answer differently.
   */
  trendSparkline?: boolean;
  total: number;
  totalPages: number;
  visibleColumns: Set<string>;
};

/**
 * The ordering the shared toolbar always drives, plus grouping while its flag is
 * enabled.
 *
 * Owned HERE rather than by each host: the web page and the desktop view both
 * mount this surface and neither has a grouping concept of its own, so the state
 * living in the one component they share is what stops the two lists offering
 * different menus. Ordering is deliberately NOT duplicated — it reuses the
 * host's existing `onSort`/`sortBy`/`sortDir`, so cards retain the sort
 * capability the grid exposes through its headers. Grouping remains behind its
 * existing gate.
 */
function useBranchColumnControls({
  grouping,
  onGroupingChange,
  onSort,
  sortBy,
  sortDir,
}: {
  grouping?: TableGroupingState;
  onGroupingChange?: (grouping: TableGroupingState) => void;
  onSort: (column: string, direction: SortDirection) => void;
  sortBy: string;
  sortDir: SortDirection;
}): BranchesColumnControls {
  const columnControlsEnabled = useFeatureFlagEnabledOptional(
    BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY
  );
  // The uncontrolled fallback for a mount with no view state behind it. Both
  // hosts supply the pair, so this never decides what a reader's saved view
  // restores; it only keeps a story or a unit mount from rendering a dead menu.
  const [localGrouping, setLocalGrouping] =
    useState<TableGroupingState>(EMPTY_TABLE_GROUPING);
  return {
    ...(columnControlsEnabled
      ? {
          grouping: grouping ?? localGrouping,
          onGroupingChange: onGroupingChange ?? setLocalGrouping,
        }
      : {}),
    onResetSort: () => onSort(DEFAULT_BRANCH_SORT_KEY, DEFAULT_BRANCH_SORT_DIR),
    onSortChange: onSort,
    sortDir,
    sortKey: sortBy,
  };
}

function BranchesListSurfaceV2Body({
  allRows,
  columnOrder,
  columnSpecs,
  columnWidths,
  customFieldColumns,
  getBranchHref,
  getSessionsHref,
  getSessionHref,
  groupCollapse,
  groups,
  interactionState,
  items,
  mode,
  onRetry,
  onShowAllTime,
  onColumnOrderChange,
  onColumnWidthChange,
  onSort,
  renderBranchLink,
  renderBranchStatus,
  selection,
  sortBy,
  sortDir,
  stallCta,
  stallPhase,
  state,
  tagsReadOnly,
  visibleColumns,
}: {
  allRows: BranchRow[];
  columnOrder?: readonly string[];
  columnSpecs: readonly ApprovedBranchColumnSpec[];
  columnWidths?: Readonly<Record<string, number>>;
  customFieldColumns: BranchesCustomFieldColumns;
  getBranchHref?: (item: BranchRow) => string;
  getSessionsHref?: (item: BranchRow) => string;
  getSessionHref?: (session: BranchRowSession) => string;
  groupCollapse?: GridTableV2Props<BranchRow>["groupCollapse"];
  /** Bands over `items`, or absent for the flat list this table has always been. */
  groups?: GridTableV2Group<BranchRow>[];
  interactionState?: GridInteractionState;
  items: BranchRow[];
  mode: GridTableListSurfaceMode;
  onRetry: () => void;
  onShowAllTime: () => void;
  onColumnOrderChange?: (nextOrder: string[]) => void;
  onColumnWidthChange?: (columnId: string, widthPx: number) => void;
  onSort: (column: string, direction: SortDirection) => void;
  renderBranchLink?: (input: ApprovedBranchLeadRenderInput) => ReactNode;
  renderBranchStatus?: (item: BranchRow) => ReactNode;
  selection?: GridTableV2SelectionProps<BranchRow>;
  sortBy: string;
  sortDir: SortDirection;
  stallCta: BranchesStallCta | undefined;
  stallPhase: LoadingStallPhase;
  /** The shell's one read of the Branches ladder, shared with its selection. */
  state: BranchesListState;
  tagsReadOnly: boolean;
  visibleColumns: Set<string>;
}) {
  const gridviewAdoption = useFeatureFlagGateOptional(
    GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
  );
  const gridviewAdoptionEnabled = gridviewAdoption.enabled;
  const { capture } = useSurfaceAnalytics();
  // The start of the load the next settle measures: mount, then each time the
  // rows leave the screen or a page change starts. Null once a settle has
  // reported it, so a later emit with no load behind it carries no duration.
  const startedAtRef = useRef<number | null>(globalThis.performance.now());
  const loadInFlightRef = useRef(true);
  const emittedSignatureRef = useRef("");
  const loadInFlight =
    state.kind !== BranchesListStateKind.Rows ||
    interactionState === GridInteractionState.Loading;
  useEffect(() => {
    if (loadInFlight) {
      if (!loadInFlightRef.current) {
        startedAtRef.current = globalThis.performance.now();
      }
      loadInFlightRef.current = true;
      return;
    }
    loadInFlightRef.current = false;
    // An unresolved flag reads false; reporting it would count an assigned
    // reader as Disabled before PostHog answers (marisolashgrove, PR #9098).
    if (!gridviewAdoption.isResolved) {
      return;
    }
    const signature = `${gridviewAdoptionEnabled}:${items.length}`;
    if (signature === emittedSignatureRef.current) {
      return;
    }
    emittedSignatureRef.current = signature;
    const startedAt = startedAtRef.current;
    startedAtRef.current = null;
    capture(SurfaceAnalyticsEvent.GridviewRolloutDecision, {
      component: SharedAnalyticsComponent.BranchesListSurfaceV2,
      ...(startedAt === null
        ? {}
        : {
            duration_ms: Math.max(0, globalThis.performance.now() - startedAt),
          }),
      outcome: gridviewAdoptionEnabled
        ? GridviewRolloutDecisionOutcome.Enabled
        : GridviewRolloutDecisionOutcome.Disabled,
      reason: BranchesListRolloutDecisionReason.RenderSettled,
      row_count: items.length,
    });
  }, [
    capture,
    gridviewAdoption.isResolved,
    gridviewAdoptionEnabled,
    items.length,
    loadInFlight,
  ]);
  if (state.kind === BranchesListStateKind.Rows) {
    const Grid = gridviewAdoptionEnabled
      ? BranchesGridV2WithRowActions
      : BranchesGridV2;
    return (
      <Grid
        allRows={allRows}
        columnOrder={columnOrder}
        columnSpecs={columnSpecs}
        columnWidths={columnWidths}
        customFieldColumns={customFieldColumns.columns}
        getBranchHref={getBranchHref}
        getSessionHref={getSessionHref}
        getSessionsHref={getSessionsHref}
        groupCollapse={groupCollapse}
        groups={groups}
        interactionState={interactionState}
        items={items}
        mode={mode}
        onAddField={customFieldColumns.onAddField}
        onColumnOrderChange={onColumnOrderChange}
        onColumnWidthChange={onColumnWidthChange}
        onSort={onSort}
        renderBranchLink={renderBranchLink}
        renderBranchStatus={renderBranchStatus}
        renderCustomFieldCell={customFieldColumns.renderCell}
        selection={selection}
        sortBy={sortBy}
        sortDir={sortDir}
        tagsReadOnly={tagsReadOnly}
        visibleColumns={visibleColumns}
      />
    );
  }
  return (
    <BranchesListStateView
      onRetry={onRetry}
      onShowAllTime={onShowAllTime}
      stallCta={stallCta}
      stallPhase={stallPhase}
      state={state}
    />
  );
}

function BranchesListWithArtifactInteractions({
  source,
  ...props
}: BranchesListSurfaceV2Props & { source: BranchesDataSource }) {
  const { queryClient, queryIdentity } = useBranchesQueryContext();
  const { orgId, userId } = useOptionalAuthSnapshot();
  const adapter = useApiAdapterOptional();
  const queryScope = useMemo(
    () => [
      source.scope,
      queryIdentity?.cacheScope,
      adapter?.deploymentId,
      orgId,
      userId,
    ],
    [
      source.scope,
      queryIdentity?.cacheScope,
      adapter?.deploymentId,
      orgId,
      userId,
    ]
  );
  const read = useArtifactCollaboratorSource({
    artifactType: CollaboratorArtifactType.Branch,
    artifactIds: props.items.map((row) => row.id),
    enabled: !(props.isPending || props.isError || props.isPlaceholderData),
    queryScope,
    queryClient,
    read: (ids) => source.collaborators?.(ids) ?? Promise.resolve(null),
  });
  return (
    <BranchesListSurfaceV2Shell
      {...props}
      allRows={branchRowsWithArtifactInteractions(props.allRows, read.data)}
      items={branchRowsWithArtifactInteractions(props.items, read.data)}
    />
  );
}

function resolveBranchesGridInteractionState({
  isError,
  isPlaceholderData,
}: {
  isError: boolean;
  isPlaceholderData: boolean;
}): GridInteractionState | undefined {
  if (isPlaceholderData) {
    return GridInteractionState.Loading;
  }
  return isError ? GridInteractionState.Error : undefined;
}
