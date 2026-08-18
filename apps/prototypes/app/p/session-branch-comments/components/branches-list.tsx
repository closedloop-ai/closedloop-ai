"use client";

import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination";
import { useMemo, useState } from "react";
import {
  type BranchRow,
  branchRows,
  type DateRange,
  shortRepoName,
} from "../mock";
import { sortBranchRows } from "./branch-sort";
import { BranchesTable } from "./branches-table";
import {
  activityRange,
  BranchesToolbar,
  type BranchFilters,
  changesRange,
  NO_COLLABORATORS,
  OWNER_UNATTRIBUTED,
  PullRequestPresence,
  TOGGLEABLE_COLUMNS,
} from "./branches-toolbar";
import { BranchesSummaryCards } from "./summary-cards";

const PAGE_SIZE = 20;
const DEFAULT_COLUMN_IDS = TOGGLEABLE_COLUMNS.map((column) => column.id);

export function BranchesList({
  onOpenDetail,
}: {
  onOpenDetail: (item: BranchRow) => void;
}) {
  const [dateRange, setDateRange] = useState<DateRange>("30d");
  const [filters, setFilters] = useState<BranchFilters>({
    names: [],
    statuses: [],
    owners: [],
    collaborators: [],
    changes: [],
    pullRequests: [],
    activity: [],
    repos: [],
    tags: [],
  });
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    () => new Set(DEFAULT_COLUMN_IDS)
  );
  const [sortBy, setSortBy] = useState("name");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [page, setPage] = useState(0);

  const filteredRows = useMemo(() => {
    const filtered = branchRows.filter(
      (row) =>
        (filters.names.length === 0 ||
          filters.names.includes(row.branchName)) &&
        (filters.statuses.length === 0 ||
          filters.statuses.includes(row.status)) &&
        (filters.owners.length === 0 ||
          filters.owners.includes(row.owner ?? OWNER_UNATTRIBUTED)) &&
        (filters.collaborators.length === 0 ||
          (row.collaborators.length === 0
            ? filters.collaborators.includes(NO_COLLABORATORS)
            : row.collaborators.some((name) =>
                filters.collaborators.includes(name)
              ))) &&
        (filters.changes.length === 0 ||
          filters.changes.includes(changesRange(row))) &&
        (filters.pullRequests.length === 0 ||
          filters.pullRequests.includes(
            row.prUrl ? PullRequestPresence.Linked : PullRequestPresence.None
          )) &&
        (filters.activity.length === 0 ||
          filters.activity.includes(activityRange(row))) &&
        (filters.repos.length === 0 ||
          filters.repos.includes(shortRepoName(row.repo))) &&
        (filters.tags.length === 0 ||
          row.tags.some((tag) => filters.tags.includes(tag)))
    );
    return sortBranchRows(filtered, sortBy, sortDir);
  }, [filters, sortBy, sortDir]);

  const totalPages = Math.ceil(filteredRows.length / PAGE_SIZE);
  const clampedPage = Math.min(page, Math.max(0, totalPages - 1));
  const pagedRows = filteredRows.slice(
    clampedPage * PAGE_SIZE,
    clampedPage * PAGE_SIZE + PAGE_SIZE
  );

  const handleSort = (column: string, direction: SortDirection) => {
    setSortBy(column);
    setSortDir(direction);
  };

  const toggleColumn = (id: string) =>
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="border-b px-4 py-3">
        <BranchesToolbar
          dateRange={dateRange}
          filters={filters}
          onDateRangeChange={(range) => {
            setDateRange(range);
            setPage(0);
          }}
          onFiltersChange={(next) => {
            setFilters(next);
            setPage(0);
          }}
          onToggleColumn={toggleColumn}
          rows={branchRows}
          visibleColumns={visibleColumns}
        />
      </div>

      {/* Not a <main>: the AppShell's SidebarInset already renders the page's
          single <main> landmark. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="sticky left-0 flex flex-col gap-3 px-4 pt-4 pb-3">
          <BranchesSummaryCards showDelta={dateRange === "30d"} />
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
            sortBy={sortBy}
            sortDir={sortDir}
            visibleColumns={visibleColumns}
          />
        )}
      </div>

      {totalPages > 1 ? (
        <div className="overflow-x-auto border-t px-4 py-3">
          <TablePagination
            className="min-w-max"
            onPageChange={setPage}
            page={clampedPage}
            totalPages={totalPages}
          />
        </div>
      ) : null}
    </div>
  );
}
