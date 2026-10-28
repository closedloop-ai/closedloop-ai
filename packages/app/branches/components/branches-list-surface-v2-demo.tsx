"use client";

import type { BranchAnalytics } from "@repo/api/src/types/branch";
import {
  EMPTY_TABLE_COLLAPSED_GROUPS,
  type TableCollapsedGroups,
} from "@repo/app/shared/lib/table-collapsed-groups";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import {
  type ComponentProps,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  DateRange as DateRangeValue,
  type DateRange as FormatDateRange,
  getDateWindowForRange,
} from "../../shared/lib/format-utils";
import {
  APPROVED_BRANCH_TOGGLEABLE_COLUMNS,
  type BranchColumnId,
} from "../hooks/use-branch-view-state";
import { BranchCohortNoticeKind } from "../lib/branch-cohort-transparency";
import { branchFiltersAreActive } from "../lib/branch-list-state";
import { resolveBranchDisplayRows } from "../lib/branch-page-state";
import {
  type BranchFilters,
  type BranchRow,
  DEFAULT_BRANCH_FILTERS,
  filterBranchRows,
} from "../lib/branch-row";
import {
  type BranchSortDir,
  BranchSortDir as BranchSortDirection,
  BranchSortKey,
} from "../lib/branch-sort-group";
import { BranchesListSurfaceV2 } from "./branches-list-surface-v2";
import {
  createPreviewBranchRow,
  type PreviewBranchRowInput,
  PreviewBranchStatus,
  PreviewPullRequestState,
} from "./branches-list-surface-v2-demo-row";
import {
  createPreviewBranchAnalytics,
  type PreviewSummaryState,
  previewSummaryPresentation,
  PreviewSummaryState as SummaryState,
} from "./branches-list-surface-v2-demo-summary";

export const BranchesListSurfaceV2PreviewSummaryState = SummaryState;
export type BranchesListSurfaceV2PreviewSummaryState = PreviewSummaryState;
export const BranchesListSurfaceV2PreviewStatus = PreviewBranchStatus;
export const BranchesListSurfaceV2PreviewPullRequestState =
  PreviewPullRequestState;
export type BranchesListSurfaceV2PreviewRowInput = PreviewBranchRowInput;
export const DateRange = DateRangeValue;
export type DateRange = FormatDateRange;

/** Route-owned view state retained across preview list/detail replacement. */
export type BranchesListSurfaceV2PreviewState = {
  collapsedGroups: TableCollapsedGroups;
  columnOrder: string[];
  columnWidths: Record<string, number>;
  dateRange: DateRange;
  filters: BranchFilters;
  grouping: TableGroupingState;
  page: number;
  pageSize: number;
  sortBy: BranchSortKey;
  sortDir: BranchSortDir;
  visibleColumns: Set<string>;
};

type PreviewSurfaceProps = Partial<
  ComponentProps<typeof BranchesListSurfaceV2>
>;

export type BranchesListSurfaceV2PreviewProps = {
  rows: readonly BranchRow[];
  now: Date;
  pageSize?: number;
  resolveSummaryCards?: (
    rows: readonly BranchRow[],
    dateRange: DateRange
  ) => BranchAnalytics | undefined;
  state?: BranchesListSurfaceV2PreviewState;
  onStateChange?: Dispatch<SetStateAction<BranchesListSurfaceV2PreviewState>>;
  summaryState?: BranchesListSurfaceV2PreviewSummaryState;
  surfaceProps?: PreviewSurfaceProps;
};

/** In-memory preview adapter for the production Branches list surface. */
export function BranchesListSurfaceV2Preview({
  rows: seedRows,
  now,
  pageSize: requestedPageSize = DEFAULT_PREVIEW_PAGE_SIZE,
  resolveSummaryCards,
  state: controlledState,
  onStateChange,
  summaryState = BranchesListSurfaceV2PreviewSummaryState.Complete,
  surfaceProps,
}: BranchesListSurfaceV2PreviewProps) {
  const { className = "min-h-0 flex-1", ...resolvedSurfaceProps } =
    surfaceProps ?? {};
  const [internalState, setInternalState] = useState(() =>
    createDefaultBranchesListSurfaceV2PreviewState(requestedPageSize)
  );
  const state = controlledState ?? internalState;
  const rows = useMemo(() => [...seedRows], [seedRows]);

  const updateState = useCallback(
    (
      updater: (
        current: BranchesListSurfaceV2PreviewState
      ) => BranchesListSurfaceV2PreviewState
    ) => {
      if (onStateChange) {
        onStateChange(updater);
        return;
      }
      setInternalState(updater);
    },
    [onStateChange]
  );

  const nowMs = now.getTime();
  const dateScopedRows = useMemo(
    () => resolvePreviewDateScopedRows(rows, state, now),
    [now, rows, state]
  );
  const filteredRows = useMemo(
    () =>
      filterBranchRows(dateScopedRows, state.filters, {
        approved: true,
        now: nowMs,
      }),
    [dateScopedRows, nowMs, state.filters]
  );
  const visibleRows = useMemo(
    () =>
      resolveBranchDisplayRows(filteredRows, {
        evaluationNow: now,
        serverPageActive: false,
        sortDir: state.sortDir,
        sortKey: state.sortBy,
      }).sortedRows,
    [filteredRows, now, state.sortBy, state.sortDir]
  );
  const totalPages = Math.ceil(visibleRows.length / state.pageSize);
  const resolvedPage = Math.min(state.page, Math.max(0, totalPages - 1));
  const pageRows = visibleRows.slice(
    resolvedPage * state.pageSize,
    resolvedPage * state.pageSize + state.pageSize
  );
  const summaryCards = useMemo(
    () => resolveSummaryCards?.(visibleRows, state.dateRange),
    [resolveSummaryCards, state.dateRange, visibleRows]
  );
  const summary = previewSummaryPresentation(summaryCards, summaryState);
  const hasActiveFilters = branchFiltersAreActive(state.filters);

  useEffect(() => {
    if (resolvedPage !== state.page) {
      updateState((current) => ({ ...current, page: resolvedPage }));
    }
  }, [resolvedPage, state.page, updateState]);

  const onFiltersChange = useCallback(
    (next: BranchFilters) => {
      updateState((current) => ({ ...current, filters: next, page: 0 }));
    },
    [updateState]
  );
  const onDateRangeChange = useCallback(
    (next: DateRange) => {
      updateState((current) => ({ ...current, dateRange: next, page: 0 }));
    },
    [updateState]
  );
  const onToggleColumn = useCallback(
    (id: BranchColumnId) => {
      updateState((current) => {
        const visibleColumns = new Set(current.visibleColumns);
        if (visibleColumns.has(id)) {
          visibleColumns.delete(id);
        } else {
          visibleColumns.add(id);
        }
        return { ...current, visibleColumns };
      });
    },
    [updateState]
  );
  const resetColumns = useCallback(() => {
    updateState((current) => {
      const ids = APPROVED_BRANCH_TOGGLEABLE_COLUMNS.map(({ id }) => id);
      return {
        ...current,
        columnOrder: ids,
        columnWidths: {},
        visibleColumns: new Set(ids),
      };
    });
  }, [updateState]);

  return (
    <BranchesListSurfaceV2
      {...resolvedSurfaceProps}
      allRows={visibleRows}
      className={className}
      cohortNotice={{
        kind: BranchCohortNoticeKind.Hidden,
        total: visibleRows.length,
      }}
      collapsedGroups={state.collapsedGroups}
      columnOrder={state.columnOrder}
      columnWidths={state.columnWidths}
      comparisonSuppressedByFilter={hasActiveFilters}
      grouping={state.grouping}
      hasActiveFilters={hasActiveFilters}
      hasCompletePopulation
      hasWindow={state.dateRange !== DateRangeValue.AllTime}
      includePriorityColumn
      includeProjectColumn
      includeTagsColumn
      isError={false}
      isPending={false}
      isPlaceholderData={false}
      items={pageRows}
      onCollapsedGroupsChange={(collapsedGroups) =>
        updateState((current) => ({ ...current, collapsedGroups }))
      }
      onColumnOrderChange={(columnOrder) =>
        updateState((current) => ({ ...current, columnOrder }))
      }
      onColumnWidthChange={(columnId, widthPx) =>
        updateState((current) => ({
          ...current,
          columnWidths: { ...current.columnWidths, [columnId]: widthPx },
        }))
      }
      onGroupingChange={(grouping) =>
        updateState((current) => ({ ...current, grouping }))
      }
      onPageChange={(page) => updateState((current) => ({ ...current, page }))}
      onPageSizeChange={(nextPageSize) => {
        updateState((current) => ({
          ...current,
          page: 0,
          pageSize: nextPageSize,
        }));
      }}
      onRetry={() => undefined}
      onShowAllTime={() => onDateRangeChange(DateRangeValue.AllTime)}
      onSort={(column, direction) => {
        const sortBy = Object.values(BranchSortKey).find(
          (sortKey) => sortKey === column
        );
        if (!sortBy) {
          return;
        }
        updateState((current) => ({
          ...current,
          page: 0,
          sortBy,
          sortDir: direction,
        }));
      }}
      onSummaryRetry={() => undefined}
      page={resolvedPage}
      pageSize={state.pageSize}
      sortBy={state.sortBy}
      sortDir={state.sortDir}
      stallCta={
        resolvedSurfaceProps.stallCta ?? {
          signals: {
            hasAccount: true,
            isGitHubConnected: true,
          },
        }
      }
      summaryAnalyticsErrored={summary.errored}
      summaryCards={summary.cards}
      summaryCardsErrored={summary.errored}
      summaryCardsPending={summary.pending}
      summaryCardsReloading={false}
      tagsReadOnly
      toolbar={{
        approved: true,
        dateRange: state.dateRange,
        filters: state.filters,
        now: nowMs,
        onDateRangeChange,
        onFiltersChange,
        onResetView: resetColumns,
        onToggleColumn,
        rows: dateScopedRows,
        visibleColumns: state.visibleColumns,
      }}
      total={visibleRows.length}
      totalPages={totalPages}
      visibleColumns={state.visibleColumns}
    />
  );
}

/** Project mock-friendly row values into the canonical Branch row contract. */
export function createBranchesListSurfaceV2PreviewRow(
  input: BranchesListSurfaceV2PreviewRowInput
): BranchRow {
  return createPreviewBranchRow(input);
}

/** Wrap canonical list metrics in the analytics envelope consumed by the surface. */
export function createBranchesListSurfaceV2PreviewAnalytics(
  canonicalMetrics: Parameters<typeof createPreviewBranchAnalytics>[0]
): BranchAnalytics {
  return createPreviewBranchAnalytics(canonicalMetrics);
}

/** Resolves the population used by both preview facets and row filtering. */
export function resolvePreviewDateScopedRows(
  rows: readonly BranchRow[],
  state: BranchesListSurfaceV2PreviewState,
  now: Date
): BranchRow[] {
  const { startDate, endDate } = getDateWindowForRange(state.dateRange, now);
  return resolveBranchDisplayRows([...rows], {
    endDate,
    evaluationNow: now,
    serverPageActive: false,
    sortDir: state.sortDir,
    sortKey: state.sortBy,
    startDate,
  }).sortedRows;
}

/** Create the complete in-memory view state owned by a preview route. */
export function createDefaultBranchesListSurfaceV2PreviewState(
  requestedPageSize = DEFAULT_PREVIEW_PAGE_SIZE
): BranchesListSurfaceV2PreviewState {
  const columnIds = APPROVED_BRANCH_TOGGLEABLE_COLUMNS.map(({ id }) => id);
  return {
    collapsedGroups: { ...EMPTY_TABLE_COLLAPSED_GROUPS },
    columnOrder: columnIds,
    columnWidths: {},
    dateRange: DateRangeValue.Last30Days,
    filters: DEFAULT_BRANCH_FILTERS,
    grouping: {
      primary: { ...EMPTY_TABLE_GROUPING.primary },
      secondary: { ...EMPTY_TABLE_GROUPING.secondary },
    },
    page: 0,
    pageSize: Math.max(1, requestedPageSize),
    sortBy: BranchSortKey.Name,
    sortDir: BranchSortDirection.Asc,
    visibleColumns: new Set(columnIds),
  };
}

const DEFAULT_PREVIEW_PAGE_SIZE = 25;

export type BranchesListSurfaceV2PreviewAdapterProps<SourceRow> = Omit<
  BranchesListSurfaceV2PreviewProps,
  "rows" | "surfaceProps"
> & {
  onOpenDetail: (item: SourceRow) => void;
  projectRow: (item: SourceRow) => BranchRow;
  rows: readonly SourceRow[];
};

/** Bind source fixtures to the shared preview while preserving source-row callbacks. */
export function BranchesListSurfaceV2PreviewAdapter<SourceRow>({
  onOpenDetail,
  projectRow,
  rows,
  ...previewProps
}: BranchesListSurfaceV2PreviewAdapterProps<SourceRow>) {
  const { previewRows, sourceRows } = useMemo(() => {
    const projectedRows: BranchRow[] = [];
    const projectedSources = new Map<string, SourceRow>();
    for (const sourceRow of rows) {
      const previewRow = projectRow(sourceRow);
      projectedRows.push(previewRow);
      projectedSources.set(previewRow.id, sourceRow);
    }
    return { previewRows: projectedRows, sourceRows: projectedSources };
  }, [projectRow, rows]);

  return (
    <>
      <h1 className="sr-only">Branches</h1>
      <BranchesListSurfaceV2Preview
        {...previewProps}
        rows={previewRows}
        surfaceProps={{
          renderBranchLink: ({ children, className, item }) => (
            <button
              className={`${className} text-left`}
              onClick={() => {
                const sourceRow = sourceRows.get(item.id);
                if (sourceRow) {
                  onOpenDetail(sourceRow);
                }
              }}
              type="button"
            >
              {children}
            </button>
          ),
          renderBranchStatus: renderPreviewBranchStatus,
        }}
      />
    </>
  );
}

function renderPreviewBranchStatus(item: BranchRow) {
  if (item.rawStatus !== BranchesListSurfaceV2PreviewStatus.Canceled) {
    return undefined;
  }
  return <ToneLabel variant="muted">Canceled</ToneLabel>;
}
