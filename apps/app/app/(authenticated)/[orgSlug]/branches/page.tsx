"use client";

import { BranchesTable } from "@repo/app/branches/components/branches-table";
import { BranchesToolbar } from "@repo/app/branches/components/branches-toolbar";
import { useBranchFilterState } from "@repo/app/branches/hooks/use-branch-filter-state";
import { useBranchViewState } from "@repo/app/branches/hooks/use-branch-view-state";
import { BRANCH_SAMPLE_ROWS } from "@repo/app/branches/lib/branch-sample-data";
import {
  type BranchSortDir,
  type BranchSortKey,
  filterBranchRowsByWindow,
  sortBranchRows,
} from "@repo/app/branches/lib/branch-sort-group";
import { ArtifactFlag } from "@repo/app/shared/lib/feature-flags";
import {
  type DateRange,
  getStartDateForRange,
} from "@repo/app/shared/lib/format-utils";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination";
import { useMemo } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { FeatureFlagGate } from "@/components/feature-flag-gate";

export default function BranchesPage() {
  const {
    sortKey,
    sortDir,
    dateRange,
    visibleColumns,
    setSort,
    setDateRange,
    toggleColumn,
  } = useBranchViewState("branches:web");

  // Client-side time window on the raw activity timestamp (the sample scaffold
  // has no REST source yet). Rows with no timestamp pass through.
  const startDate = useMemo(() => getStartDateForRange(dateRange), [dateRange]);
  const windowedRows = useMemo(
    () => filterBranchRowsByWindow(BRANCH_SAMPLE_ROWS, startDate),
    [startDate]
  );

  // Client-side sort feeds the filter/pagination hook (window → sort → filter →
  // paginate).
  const sortedRows = useMemo(
    () => sortBranchRows(windowedRows, sortKey, sortDir),
    [windowedRows, sortKey, sortDir]
  );

  const { filters, page, setPage, pagedRows, totalPages, handleFiltersChange } =
    useBranchFilterState(sortedRows);

  const handleSort = (column: string, direction: SortDirection) =>
    setSort(column as BranchSortKey, direction as BranchSortDir);

  const handleDateRangeChange = (next: DateRange) => {
    setDateRange(next);
    setPage(0);
  };

  return (
    <FeatureFlagGate flag={ArtifactFlag.Branches}>
      <div className="flex min-h-0 flex-1 flex-col">
        <Header breadcrumbs={[{ label: "Branches" }]} />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Filter bar — pinned above the scroll area. The table header sticks
              to the top of <main> right beneath it. */}
          <div className="border-b px-4 py-3">
            <BranchesToolbar
              dateRange={dateRange}
              filters={filters}
              onDateRangeChange={handleDateRangeChange}
              onFiltersChange={handleFiltersChange}
              onToggleColumn={toggleColumn}
              rows={windowedRows}
              visibleColumns={visibleColumns}
            />
          </div>

          {/* The web Branches surface is a deferred, flag-gated static scaffold
              (sample rows). It intentionally does NOT mount BranchesSummaryCards:
              after B6 those cards fetch via `useBranchAnalytics`, and the web
              `/branches/analytics` REST route does not exist yet (it lands with
              the authed REST source). Mounting them here would 404 on render.
              The cards return to this page once those routes ship. */}
          <main className="min-h-0 flex-1 overflow-auto">
            <BranchesTable
              items={pagedRows}
              onSort={handleSort}
              sortBy={sortKey}
              sortDir={sortDir}
              visibleColumns={visibleColumns}
            />
          </main>

          {totalPages > 1 ? (
            <div className="border-t px-4 py-3">
              <TablePagination
                onPageChange={setPage}
                page={page}
                totalPages={totalPages}
              />
            </div>
          ) : null}
        </div>
      </div>
    </FeatureFlagGate>
  );
}
