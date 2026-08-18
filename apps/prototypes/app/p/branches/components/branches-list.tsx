"use client";

import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination";
import { useEffect, useMemo, useState } from "react";
import { type BranchRow, branchRows } from "../mock";
import { filterBranchRows } from "./branch-list-filter";
import {
  BRANCH_METRIC_FIXTURE_NOW,
  branchMetricEvidence,
} from "./branch-list-fixtures";
import {
  type BranchMetricEvidence,
  type MetricPresentationState,
  MetricPresentationState as PresentationState,
} from "./branch-list-metric-types";
import { calculateBranchListMetrics } from "./branch-list-metrics";
import {
  BRANCH_LIST_PAGE_SIZE,
  type BranchListViewState,
  branchPageRange,
  createDefaultBranchListViewState,
} from "./branch-list-state";
import { sortBranchRows } from "./branch-sort";
import { BranchesTable } from "./branches-table";
import { BranchesToolbar, TOGGLEABLE_COLUMNS } from "./branches-toolbar";
import { BranchesSummaryCards } from "./summary-cards";

const DEFAULT_COLUMN_IDS = TOGGLEABLE_COLUMNS.map((column) => column.id);

export function BranchesList({
  onOpenDetail,
  state: controlledState,
  onStateChange,
  rows = branchRows,
  evidence = branchMetricEvidence,
  now = BRANCH_METRIC_FIXTURE_NOW,
  presentationState = PresentationState.Complete,
}: {
  onOpenDetail: (item: BranchRow) => void;
  state?: BranchListViewState;
  onStateChange?: (state: BranchListViewState) => void;
  rows?: readonly BranchRow[];
  evidence?: BranchMetricEvidence;
  now?: Date;
  presentationState?: MetricPresentationState;
}) {
  const [internalState, setInternalState] = useState(() =>
    createDefaultBranchListViewState(DEFAULT_COLUMN_IDS)
  );
  const state = controlledState ?? internalState;
  const updateState = onStateChange ?? setInternalState;
  const cohort = useMemo(
    () => filterBranchRows(rows, state.dateRange, state.filters, now),
    [now, rows, state.dateRange, state.filters]
  );
  const sortedRows = useMemo(
    () => sortBranchRows(cohort, state.sortBy, state.sortDir),
    [cohort, state.sortBy, state.sortDir]
  );
  const totalPages = Math.ceil(sortedRows.length / BRANCH_LIST_PAGE_SIZE);
  const clampedPage = Math.min(state.page, Math.max(0, totalPages - 1));
  const pagedRows = sortedRows.slice(
    clampedPage * BRANCH_LIST_PAGE_SIZE,
    clampedPage * BRANCH_LIST_PAGE_SIZE + BRANCH_LIST_PAGE_SIZE
  );
  const metrics = useMemo(
    () =>
      calculateBranchListMetrics(
        cohort.map((row) => row.id),
        evidence,
        state.dateRange,
        now
      ),
    [cohort, evidence, now, state.dateRange]
  );

  useEffect(() => {
    if (clampedPage !== state.page) {
      updateState({ ...state, page: clampedPage });
    }
  }, [clampedPage, state, updateState]);

  const handleSort = (column: string, direction: SortDirection) => {
    updateState({ ...state, sortBy: column, sortDir: direction, page: 0 });
  };

  const toggleColumn = (id: string) => {
    const visibleColumns = new Set(state.visibleColumns);
    if (visibleColumns.has(id)) {
      visibleColumns.delete(id);
    } else {
      visibleColumns.add(id);
    }
    updateState({ ...state, visibleColumns });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <h1 className="sr-only">Branches</h1>
      <div className="border-b px-4 py-3">
        <BranchesToolbar
          dateRange={state.dateRange}
          filters={state.filters}
          now={now}
          onDateRangeChange={(dateRange) =>
            updateState({ ...state, dateRange, page: 0 })
          }
          onFiltersChange={(filters) =>
            updateState({ ...state, filters, page: 0 })
          }
          onToggleColumn={toggleColumn}
          rows={rows}
          visibleColumns={state.visibleColumns}
        />
      </div>

      <section
        aria-label="Branches"
        className="min-h-0 flex-1 overflow-auto"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the two-axis results region must be reachable by keyboard (WCAG 2.1.1).
        tabIndex={0}
      >
        <div className="sticky left-0 flex flex-col gap-3 px-4 pt-4 pb-3">
          <BranchesSummaryCards
            metrics={metrics}
            presentationState={presentationState}
          />
        </div>

        {pagedRows.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground text-sm">
            No branches match the current filters.
          </div>
        ) : (
          <BranchesTable
            items={pagedRows}
            onOpenDetail={onOpenDetail}
            onSort={handleSort}
            sortBy={state.sortBy}
            sortDir={state.sortDir}
            visibleColumns={state.visibleColumns}
          />
        )}
      </section>

      {sortedRows.length > 0 ? (
        <div className="flex items-center justify-between gap-4 overflow-x-auto border-t px-4 py-3">
          <p
            aria-live="polite"
            className="shrink-0 text-muted-foreground text-sm"
          >
            {branchPageRange(clampedPage, sortedRows.length)}
          </p>
          <TablePagination
            className="min-w-max justify-end"
            onPageChange={(page) => updateState({ ...state, page })}
            page={clampedPage}
            totalPages={totalPages}
          />
        </div>
      ) : null}
    </div>
  );
}
