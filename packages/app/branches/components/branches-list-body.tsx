"use client";

import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { BranchRow } from "../lib/branch-row";
import {
  BranchesEmptyState,
  BranchesEmptyVariant,
} from "./branches-empty-state";
import { BranchesTable } from "./branches-table";

const STATUS_CLASS_NAME =
  "py-12 text-center text-[var(--muted-foreground)] text-sm";

/** Shared web/Desktop Branches list state controller and table composition. */
export function BranchesListBody({
  approved,
  allRows,
  isPending,
  isError,
  hasRows,
  hasWindow,
  windowedEmptyIsNoMatches,
  items,
  visibleColumns,
  getBranchHref,
  getSessionsHref,
  sortBy,
  sortDir,
  onSort,
  columnOrder,
  onColumnOrderChange,
  columnWidths,
  onColumnWidthChange,
  onShowAllTime,
  onRetry,
  tagsReadOnly = false,
}: {
  approved: boolean;
  allRows: BranchRow[];
  isPending: boolean;
  isError: boolean;
  hasRows: boolean;
  hasWindow: boolean;
  /** The bounded window, rather than facet filters, produced the empty set. */
  windowedEmptyIsNoMatches: boolean;
  items: BranchRow[];
  visibleColumns: Set<string>;
  getBranchHref?: (item: BranchRow) => string;
  getSessionsHref?: (item: BranchRow) => string;
  sortBy: string;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
  columnOrder: readonly string[];
  onColumnOrderChange: (nextOrder: string[]) => void;
  columnWidths: Readonly<Record<string, number>>;
  onColumnWidthChange: (columnId: string, widthPx: number) => void;
  onShowAllTime: () => void;
  onRetry: () => void;
  tagsReadOnly?: boolean;
}) {
  if (isPending) {
    return <div className={STATUS_CLASS_NAME}>Loading branches…</div>;
  }
  if (isError && !hasRows) {
    return (
      <BranchesEmptyState
        onRetry={onRetry}
        variant={BranchesEmptyVariant.Unavailable}
      />
    );
  }
  if (!hasRows) {
    return hasWindow && windowedEmptyIsNoMatches ? (
      <BranchesEmptyState
        onShowAllTime={onShowAllTime}
        variant={BranchesEmptyVariant.NoMatches}
      />
    ) : (
      <BranchesEmptyState variant={BranchesEmptyVariant.NoBranches} />
    );
  }
  if (items.length === 0) {
    return (
      <BranchesEmptyState
        onShowAllTime={
          hasWindow && windowedEmptyIsNoMatches ? onShowAllTime : undefined
        }
        variant={BranchesEmptyVariant.NoMatches}
      />
    );
  }
  return (
    <BranchesTable
      allRows={allRows}
      approved={approved}
      columnOrder={columnOrder}
      columnWidths={columnWidths}
      getBranchHref={getBranchHref}
      getSessionsHref={getSessionsHref}
      items={items}
      onColumnOrderChange={onColumnOrderChange}
      onColumnWidthChange={onColumnWidthChange}
      onSort={onSort}
      sortBy={sortBy}
      sortDir={sortDir}
      tagsReadOnly={tagsReadOnly}
      visibleColumns={visibleColumns}
    />
  );
}
