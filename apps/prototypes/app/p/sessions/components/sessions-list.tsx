"use client";

import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination";
import { BotIcon, CircleDotIcon, HistoryIcon, UserIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
  type DateRange,
  GroupBy,
  type SessionRow,
  sessionRows,
  shortRepoName,
  WINDOW_MINUTES,
} from "../mock";
import { computeSummaryKpis } from "../mock-kpis";
import { buildSessionGroups } from "./session-grouping";
import { SessionsTable } from "./sessions-table";
import {
  OWNER_UNATTRIBUTED,
  type SessionFilters,
  SessionsToolbar,
  TOGGLEABLE_COLUMNS,
} from "./sessions-toolbar";
import { SessionsSummaryCards } from "./summary-cards";

const PAGE_SIZES = [25, 50, 100] as const;
// Default the lowest-glance columns off so the table fits without clipping on a
// laptop; each stays one click away in the View / "+" menus. Started and Updated
// collapse to the same coarse "3h ago" label as Last active, so only Last active
// shows by default.
const DEFAULT_HIDDEN_COLUMNS = new Set([
  "tags",
  "collaborators",
  "projects",
  "issues",
  "agents",
  "started",
  "updated",
]);

// The row field each group-by dimension bands on; when active, that column is
// hidden in the table so the value is not printed twice (band header + cell).
const GROUP_COLUMN_ID: Record<GroupBy, string | undefined> = {
  [GroupBy.None]: undefined,
  [GroupBy.Status]: "status",
  [GroupBy.Harness]: "harness",
  [GroupBy.Owner]: "owner",
};
const DEFAULT_COLUMN_IDS = TOGGLEABLE_COLUMNS.map((column) => column.id).filter(
  (id) => !DEFAULT_HIDDEN_COLUMNS.has(id)
);

const GROUP_ICONS: Record<GroupBy, ReactNode> = {
  [GroupBy.None]: null,
  [GroupBy.Status]: <CircleDotIcon className="size-4 text-muted-foreground" />,
  [GroupBy.Harness]: <BotIcon className="size-4 text-muted-foreground" />,
  [GroupBy.Owner]: <UserIcon className="size-4 text-muted-foreground" />,
};

// Sort on the numeric source fields, never the formatted labels — sorting the
// label strings puts "yesterday" above "just now" and "9m" above "1h 18m"
// (review). Recency columns return the negated age so "desc" reads as
// newest-first, matching cost/duration where higher = more.
function sortValue(row: SessionRow, key: string): string | number {
  switch (key) {
    case "name":
      return row.name;
    case "status":
      return row.status;
    case "repo":
      return row.repo ? shortRepoName(row.repo) : "";
    case "harness":
      return row.harness;
    case "model":
      return row.model ?? "";
    case "duration":
      return row.durationMs;
    case "cost":
      return row.cost;
    case "started":
      return -row.startedAgoMinutes;
    case "updated":
      return -row.updatedAgoMinutes;
    case "lastActivity":
      return -row.lastActivityAgoMinutes;
    default:
      return row.name;
  }
}

export function SessionsList({
  onOpenDetail,
}: {
  onOpenDetail: (item: SessionRow) => void;
}) {
  const [dateRange, setDateRange] = useState<DateRange>("30d");
  const [filters, setFilters] = useState<SessionFilters>({
    statuses: [],
    harnesses: [],
    owners: [],
    repos: [],
  });
  const [groupBy, setGroupBy] = useState<GroupBy>(GroupBy.None);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    () => new Set(DEFAULT_COLUMN_IDS)
  );
  const [sortBy, setSortBy] = useState("lastActivity");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const [page, setPage] = useState(0);

  const filteredRows = useMemo(() => {
    const windowMinutes = WINDOW_MINUTES[dateRange];
    const filtered = sessionRows.filter(
      (row) =>
        row.startedAgoMinutes <= windowMinutes &&
        (filters.statuses.length === 0 ||
          filters.statuses.includes(row.status)) &&
        (filters.harnesses.length === 0 ||
          filters.harnesses.includes(row.harness)) &&
        (filters.owners.length === 0 ||
          filters.owners.includes(row.user?.name ?? OWNER_UNATTRIBUTED)) &&
        (filters.repos.length === 0 ||
          filters.repos.includes(
            row.repo ? shortRepoName(row.repo) : "No repository"
          ))
    );
    const sorted = [...filtered].sort((a, b) => {
      const aValue = sortValue(a, sortBy);
      const bValue = sortValue(b, sortBy);
      if (aValue < bValue) {
        return sortDir === "asc" ? -1 : 1;
      }
      if (aValue > bValue) {
        return sortDir === "asc" ? 1 : -1;
      }
      return 0;
    });
    return sorted;
  }, [dateRange, filters, sortBy, sortDir]);

  // True when any non-date filter narrows the set — used to suppress the KPI
  // delta chips (no honest prior-period comparison once filtered).
  const filtersActive =
    filters.statuses.length > 0 ||
    filters.harnesses.length > 0 ||
    filters.owners.length > 0 ||
    filters.repos.length > 0;

  // KPI cards summarize the CURRENT filtered set so the aggregate always
  // reconciles with the rows on screen (review: static 148/$1,284 over 8 rows).
  const summaryKpis = useMemo(
    () => computeSummaryKpis(filteredRows, dateRange, filtersActive),
    [filteredRows, dateRange, filtersActive]
  );

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageStart = clampedPage * pageSize;
  const pagedRows = filteredRows.slice(pageStart, pageStart + pageSize);
  const grouped = groupBy !== GroupBy.None;
  // Group-by bands the full filtered set (not just the current page), so a band
  // is never split across page boundaries; the grouped view shows every match
  // and the pager steps aside.
  const groups = grouped
    ? buildSessionGroups(filteredRows, groupBy)
    : undefined;
  const bodyRows = grouped ? filteredRows : pagedRows;

  const resetToFirstPage = () => setPage(0);

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
        <SessionsToolbar
          dateRange={dateRange}
          filters={filters}
          groupBy={groupBy}
          onDateRangeChange={(range) => {
            setDateRange(range);
            resetToFirstPage();
          }}
          onFiltersChange={(next) => {
            setFilters(next);
            resetToFirstPage();
          }}
          onGroupByChange={setGroupBy}
          onToggleColumn={toggleColumn}
          rows={sessionRows}
          visibleColumns={visibleColumns}
        />
      </div>

      {/* Not a <main>: the AppShell's SidebarInset already renders the page's
          single <main> landmark. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="sticky left-0 flex flex-col gap-3 px-4 pt-4 pb-3">
          <SessionsSummaryCards kpis={summaryKpis} />
        </div>

        {bodyRows.length === 0 ? (
          <EmptyState
            className="py-12"
            description="No synced sessions match your current time window and filters."
            icon={HistoryIcon}
            title="No sessions found"
          />
        ) : (
          <SessionsTable
            groupedColumnId={GROUP_COLUMN_ID[groupBy]}
            groupIcon={GROUP_ICONS[groupBy]}
            groups={groups}
            items={bodyRows}
            onOpenDetail={onOpenDetail}
            onSort={handleSort}
            sortBy={sortBy}
            sortDir={sortDir}
            visibleColumns={visibleColumns}
          />
        )}
      </div>

      {/* Pagination applies to the flat list; when grouped, every match is
          banded on one page, so the pager steps aside. */}
      {grouped ? null : (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
          <RowsPerPage
            onPageSizeChange={(size) => {
              setPageSize(size);
              resetToFirstPage();
            }}
            pageSize={pageSize}
            rangeEnd={Math.min(
              pageStart + pagedRows.length,
              filteredRows.length
            )}
            rangeStart={filteredRows.length === 0 ? 0 : pageStart + 1}
            total={filteredRows.length}
          />
          <TablePagination
            className="min-w-max"
            onPageChange={setPage}
            page={clampedPage}
            totalPages={totalPages}
          />
        </div>
      )}
    </div>
  );
}

// Rows-per-page control (PRD-557 FEA-4199) plus a range summary, so the footer
// stays informative even when the sample fits on a single page.
function RowsPerPage({
  pageSize,
  onPageSizeChange,
  rangeStart,
  rangeEnd,
  total,
}: {
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  rangeStart: number;
  rangeEnd: number;
  total: number;
}) {
  return (
    <div className="flex items-center gap-3 text-muted-foreground text-sm">
      <span className="flex items-center gap-2">
        <span>Rows per page</span>
        <Select
          onValueChange={(value) => onPageSizeChange(Number(value))}
          value={String(pageSize)}
        >
          <SelectTrigger aria-label="Rows per page" className="w-20" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
      <span className="tabular-nums">
        {rangeStart}–{rangeEnd} of {total}
      </span>
    </div>
  );
}
