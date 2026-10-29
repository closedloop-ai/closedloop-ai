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

  // Unconditional, unlike the two Gridview headers: this component IS the
  // sortable cell, so there is no static arm that would have to omit the
  // attribute. A host renders a plain `<TableHead>` for a column that does
  // not sort.
  return (
    <TableHead aria-sort={getAriaSort(isActive, sortDir)} className={className}>
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
 *
 * The explicit `none` on an inactive column is DELIBERATE, and ISS-10425 ruled
 * it so after it was raised a second time. `none` is the DEFINED DEFAULT of
 * `aria-sort` ("There is no defined sort applied to the column"), so a header
 * carrying `aria-sort="none"` and a header carrying no `aria-sort` at all
 * compute to the same value in the accessibility tree: returning `undefined`
 * here would change nothing a screen-reader user can perceive. What it would
 * change is the only thing the ATTRIBUTE'S PRESENCE encodes in this family —
 * that this column is a sort control at all. Both Gridview headers gate the
 * attribute on `column.sortable` and emit NOTHING for a static column
 * (`table-grid-header.tsx`, `table-grid-header-v2.tsx`), so absent means "not
 * sortable" and `none` means "sortable, not currently sorted". Folding the
 * second onto the first erases a distinction and buys no user anything.
 *
 * The guidance that keeps being read as a prohibition — "The `aria-sort`
 * attribute should only be added to a single table or grid header at a time"
 * (MDN, `aria-sort`; the APG sortable-table example moves the attribute rather
 * than resetting it) — is about the SORT STATE, and this helper already holds
 * that line: it returns a direction for exactly one column and `none` for
 * every other. Do not re-raise this without a user-observable behavior to cite.
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
