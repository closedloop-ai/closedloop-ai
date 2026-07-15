"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import { type ReactNode, useState } from "react";
import { GroupSectionHeader } from "./group-section-header";
import type { SortDirection } from "./sortable-column-header";
import { TableGridHeader } from "./table-grid-header";

/**
 * Generic grid table built on the shared `TableGridHeader` + a `grid min-w-fit`
 * row. Data-agnostic: callers supply the row type, column descriptors, the CSS
 * grid template, and render functions for the leading cell and each data cell.
 * Shared across surfaces (web `apps/app`, desktop renderer) so tables stay
 * structurally identical.
 *
 * The component renders no `overflow` wrapper — the host owns the scroll
 * container (e.g. a full-bleed `<main className="overflow-auto">`), so the
 * sticky header and horizontal scroll resolve against it. Each row + the header
 * are `min-w-fit`, so the container scrolls horizontally when columns exceed the
 * viewport.
 *
 * Sorting is opt-in: pass `onSort` (+ `sortBy`/`sortDir`) and mark sortable
 * columns with `sortable: true` to get clickable headers with sort indicators
 * (the leading cell sorts via `leadingSortKey`). Without `onSort`, headers
 * render as plain labels. Set a column's `className` to `"opacity-50"` to flag
 * it as a placeholder.
 */

export type GridTableColumn = {
  id: string;
  label: string;
  className?: string;
  /** When true (and `onSort` is provided), the header is a clickable sort control. */
  sortable?: boolean;
  /** Optional help text shown via an info icon + tooltip in the column header. */
  tooltip?: string;
};

/**
 * A contiguous section of rows rendered under a collapsible `GroupSectionHeader`
 * inside a single table (one column header shared across all groups).
 */
export type GridTableGroup<T> = {
  key: string;
  label: string;
  items: T[];
};

type GridTableProps<T> = {
  items: T[];
  getRowId: (item: T) => string;
  /** Columns after the leading (wide) column. */
  columns: readonly GridTableColumn[];
  /** CSS grid template: lead column + one track per column + trailing slot. */
  gridTemplateColumns: string;
  leadingLabel: string;
  /** Content of the leading (wide) cell — typically a name link + id. */
  renderLead: (item: T) => ReactNode;
  /** Content of a data cell. Return `null` for an intentionally empty cell. */
  renderCell: (columnId: string, item: T) => ReactNode;
  /** Sort state — wire all three to enable clickable column-header sorting. */
  sortBy?: string | null;
  sortDir?: SortDirection;
  onSort?: (column: string, direction: SortDirection) => void;
  /** Sort key for the leading column; clicking the lead header sorts by it. */
  leadingSortKey?: string;
  /**
   * When provided, the body renders one collapsible `GroupSectionHeader` per
   * group followed by that group's rows — a single table, not separate tables.
   * `items` is ignored in this mode.
   */
  groups?: GridTableGroup<T>[];
  /** Icon shown in each group section header (the grouping dimension's icon). */
  groupIcon?: ReactNode;
};

export function GridTable<T>({
  items,
  getRowId,
  columns,
  gridTemplateColumns,
  leadingLabel,
  renderLead,
  renderCell,
  sortBy,
  sortDir = "asc",
  onSort,
  leadingSortKey,
  groups,
  groupIcon = null,
}: GridTableProps<T>) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set()
  );
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  const renderRow = (item: T): ReactNode => (
    <div
      className="group grid h-11 min-w-fit items-center border-b bg-[var(--grid-table-surface,var(--background))] hover:bg-muted/40"
      key={getRowId(item)}
      style={{ gridTemplateColumns }}
    >
      <div className="flex min-w-0 flex-col justify-center py-1 pr-3 pl-4">
        {renderLead(item)}
      </div>
      {/* No trailing border cell: columns are separated by `border-l`; the
          table's left and right edges are intentionally open. (A fixed-size
          phantom trailing cell here used to overlap the first row's lead cell
          when a caller's template lacked a track for it.) */}
      {columns.map((column) => (
        <GridTableCell key={column.id}>
          {renderCell(column.id, item)}
        </GridTableCell>
      ))}
    </div>
  );

  return (
    <div className="min-w-fit border-t">
      <TableGridHeader
        columns={columns.map((column) => ({
          id: column.id,
          label: column.label,
          sortable: onSort != null && column.sortable === true,
          className: column.className,
          tooltip: column.tooltip,
        }))}
        gridTemplateColumns={gridTemplateColumns}
        leadingLabel={leadingLabel}
        leadingSortKey={onSort ? leadingSortKey : undefined}
        onSort={onSort ?? noopSort}
        sortBy={sortBy ?? null}
        sortDir={sortDir}
      />
      {groups
        ? groups.map((group) => {
            const isOpen = !collapsedGroups.has(group.key);
            return (
              <div key={group.key}>
                <GroupSectionHeader
                  count={group.items.length}
                  icon={groupIcon}
                  isOpen={isOpen}
                  label={group.label}
                  onToggle={() => toggleGroup(group.key)}
                />
                {isOpen ? group.items.map(renderRow) : null}
              </div>
            );
          })
        : items.map(renderRow)}
    </div>
  );
}

export function GridTableCell({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full min-w-0 items-center gap-2 border-l px-3",
        className
      )}
    >
      {children}
    </div>
  );
}

export function GridEmptyValue() {
  return <span className="text-muted-foreground/50 text-sm">—</span>;
}

function noopSort() {
  // Column sorting is not wired in this view yet.
}
