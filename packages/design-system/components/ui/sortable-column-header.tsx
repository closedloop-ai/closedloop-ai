"use client";

import { TableHead } from "@closedloop-ai/design-system/components/ui/table";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

export type SortDirection = "asc" | "desc";

type SortableColumnHeaderProps<TColumn extends string> = {
  column: TColumn;
  label: string;
  sortBy: TColumn | null;
  sortDir: SortDirection;
  onSort: (column: TColumn, direction: SortDirection) => void;
  className?: string;
};

type SortIndicatorProps = {
  isActive: boolean;
  direction: SortDirection;
  className?: string;
};

export function getNextSortDirection(
  isActive: boolean,
  currentDirection: SortDirection
): SortDirection {
  if (!isActive) {
    return "desc";
  }

  return currentDirection === "desc" ? "asc" : "desc";
}

export function SortIndicator({
  isActive,
  direction,
  className,
}: SortIndicatorProps) {
  if (!isActive) {
    return (
      <ArrowUpDown
        className={cn("h-3.5 w-3.5 text-muted-foreground", className)}
      />
    );
  }

  if (direction === "asc") {
    return <ArrowUp className={cn("h-3.5 w-3.5", className)} />;
  }

  return <ArrowDown className={cn("h-3.5 w-3.5", className)} />;
}

export function SortableColumnHeader<TColumn extends string>({
  column,
  label,
  sortBy,
  sortDir,
  onSort,
  className,
}: SortableColumnHeaderProps<TColumn>) {
  const isActive = sortBy === column;

  function handleClick() {
    onSort(column, getNextSortDirection(isActive, sortDir));
  }

  return (
    <TableHead className={className}>
      <button
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={handleClick}
        type="button"
      >
        {label}
        <SortIndicator direction={sortDir} isActive={isActive} />
      </button>
    </TableHead>
  );
}

/**
 * The `aria-sort` values a `role="columnheader"` cell may carry. Kept as the
 * canonical const object rather than inline strings: these are contract values
 * assistive technology reads, not free text.
 */
export const AriaSort = {
  Ascending: "ascending",
  Descending: "descending",
  None: "none",
} as const;
export type AriaSort = (typeof AriaSort)[keyof typeof AriaSort];

/**
 * `aria-sort` for a sortable column header (ISS-4672). `SortIndicator` conveys
 * the same state visually; this is its screen-reader half, so a non-sighted user
 * hears "sorted descending" instead of nothing at all. Only the ACTIVE sort
 * column may announce a direction — every other sortable header is `none`.
 */
export function getAriaSort(
  isActive: boolean,
  direction: SortDirection
): AriaSort {
  if (!isActive) {
    return AriaSort.None;
  }
  return direction === "asc" ? AriaSort.Ascending : AriaSort.Descending;
}
