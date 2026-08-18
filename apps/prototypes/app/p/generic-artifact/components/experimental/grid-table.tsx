// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: Preserve the reviewed prototype interaction contract in this isolated copy.
// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Preserve the reviewed prototype keyboard behavior in this isolated copy.
// biome-ignore-all lint/a11y/noStaticElementInteractions: Preserve the reviewed prototype interaction contract in this isolated copy.
// biome-ignore-all lint/a11y/useKeyWithClickEvents: Keyboard navigation is handled by the prototype's cell-level handlers.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Preserve the reviewed prototype behavior in this isolated copy.
// biome-ignore-all lint/style/noNestedTernary: Preserve the reviewed prototype render branches in this isolated copy.
"use client";

// Experimental variant scoped to Generic Artifact pending explicit promotion review.

import {
  Card,
  CardContent,
  CardHeader,
} from "@repo/design-system/components/ui/card";
import { GroupSectionHeader } from "@repo/design-system/components/ui/group-section-header";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { useContainerWidth } from "@repo/design-system/hooks/use-container-width";
import {
  MIN_COLUMN_WIDTH_PX,
  orderColumns,
} from "@repo/design-system/lib/column-order";
import { cn } from "@repo/design-system/lib/utils";
import {
  type DragEvent,
  Fragment,
  isValidElement,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useState,
} from "react";
import {
  TableGridHeader,
  type TableGridHeaderActions,
} from "./table-grid-header";

// The `md` breakpoint (768px). Below it the card fallback renders; at/above it
// the CSS grid renders. Kept in sync with the Tailwind `md` breakpoint.
const CARD_FALLBACK_BREAKPOINT = 768;

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
 *
 * Column reorder is opt-in (FEA-4021): pass `columnOrder` + `onColumnOrderChange`
 * and each data-column header becomes a native drag surface; the table reorders
 * its own columns by `columnOrder` and the caller keeps its
 * `gridTemplateColumns` tracks in the same order (via the `orderColumns`
 * helper). The header action menu provides the keyboard-accessible move path.
 * Column show/hide is a companion
 * generic `TableViewMenu` (its "Show / Hide Columns" section) a caller places in
 * its toolbar; dropping a hidden column's grid track stays with the caller
 * because a `gridTemplateColumns` string cannot be sliced generically.
 *
 * Responsive card fallback (FEA-3865): pass `cardRender` to get a stacked card
 * list on narrow surfaces instead of a horizontally-scrolling grid. The table
 * measures its own container width (not the viewport) and renders exactly one
 * layout — below the `md` breakpoint (768px) the card list, at `md+` the CSS
 * grid. `mode` forces one path: `auto` (default) follows the measured width,
 * `expanded` always renders the grid, `compact` always renders cards. A caller
 * that passes no `cardRender` is byte-unchanged: the grid always renders with no
 * container wrapper, so desktop and the existing mini-tables look exactly as
 * before. First paint (and SSR) renders the grid until the width is measured, so
 * the desktop default never flashes a card list.
 */

export type GridTableMode = "auto" | "compact" | "expanded";

export type GridTableColumn = {
  id: string;
  label: string;
  className?: string;
  /** When true (and `onSort` is provided), the header is a clickable sort control. */
  sortable?: boolean;
  /** Whether the column exposes Filter in its action menu. */
  filterable?: boolean;
  /** Whether the column exposes Group in its action menu. */
  groupable?: boolean;
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
  /** Optional value-specific icon, such as an assignee avatar. */
  icon?: ReactNode;
  /** Optional second grouping level rendered as nested list sections. */
  subgroups?: GridTableGroup<T>[];
};

type GridTableProps<T> = {
  items: T[];
  getRowId: (item: T) => string;
  /** Columns after the leading (wide) column. */
  columns: readonly GridTableColumn[];
  /** CSS grid template: lead column + one track per column + trailing slot. */
  gridTemplateColumns: string;
  leadingLabel: string;
  /** Optional hover guidance for the fixed leading column. */
  leadingTooltip?: string;
  /** Current width of the fixed leading identity column. */
  leadingColumnWidth?: number;
  /** Enables pointer and keyboard resize for the fixed leading column. */
  onLeadingColumnWidthChange?: (widthPx: number) => void;
  /** Content of the leading (wide) cell — typically a name link + id. */
  renderLead: (item: T) => ReactNode;
  /** Optional fixed utility cell rendered before the leading identity cell. */
  renderLeadingUtility?: (item: T) => ReactNode;
  /** Header content for `renderLeadingUtility`. */
  leadingUtilityHeader?: ReactNode;
  /** Marks selected rows for the shared selected-row treatment. */
  isRowSelected?: (item: T) => boolean;
  /** Row-level selection/activation. Interactive controls inside cells are ignored. */
  onRowClick?: (item: T, event: MouseEvent<HTMLDivElement>) => void;
  /**
   * Called when arrow-key navigation lands on a row. Hosts use this to keep
   * keyboard focus and row selection in sync, including Shift+Arrow ranges.
   */
  onRowKeyboardNavigate?: (
    item: T,
    event: KeyboardEvent<HTMLDivElement>
  ) => void;
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
  /** Enables row drag and reports the primary + optional secondary destination. */
  onGroupDrop?: (
    item: T,
    group: GridTableGroup<T>,
    subgroup?: GridTableGroup<T>
  ) => void;
  /**
   * Responsive card renderer (FEA-3865). When provided, the table can fall back
   * to a stacked card list on narrow surfaces instead of a scrolling grid. It
   * receives the row and the table's `columns` so the card can lay the lead cell
   * out as a header and the data columns as a key/value body. Without it, the
   * table only ever renders the grid (unchanged behavior).
   */
  cardRender?: (item: T, columns: readonly GridTableColumn[]) => ReactNode;
  /**
   * Layout mode (FEA-3865). `auto` (default): follow the measured container
   * width — cards below the `md` breakpoint (768px), grid at `md+`. `expanded`:
   * always the grid. `compact`: always cards. `compact` and the card half of
   * `auto` only take effect when `cardRender` is supplied; otherwise the grid
   * always renders.
   */
  mode?: GridTableMode;
  /**
   * Column-reorder (FEA-4021). `columnOrder` is the current order of the DATA
   * column ids (the leading column is fixed and never reorders); pass it with
   * `onColumnOrderChange` to get drag-to-reorder + keyboard-reorder handles on
   * each data-column header. The table reorders its own `columns` by this order
   * before rendering; the CALLER must supply `gridTemplateColumns` tracks in the
   * SAME order (typically by ordering its own width-carrying specs with the
   * shared `orderColumns` helper) so a column and its track stay paired. Absent
   * → static headers, byte-identical to before.
   */
  columnOrder?: readonly string[];
  onColumnOrderChange?: (nextOrder: string[]) => void;
  /**
   * Column-width resize (FEA-4168). `columnWidths` is the current RENDERED pixel
   * width of each DATA column keyed by id — the base a drag/keyboard resize
   * adjusts from (typically the caller's per-column widths after applying its
   * persisted overrides via `applyColumnWidths`). Pass it with
   * `onColumnWidthChange` to grow a right-edge resize handle on each data-column
   * header (pointer drag AND keyboard `ArrowLeft`/`ArrowRight`); the handle
   * reports the new width (already clamped to the shared floor) and the CALLER
   * must fold that width back into its `gridTemplateColumns` track for the same
   * column so the header and body stay paired — exactly like `columnOrder`.
   * Absent → no resize handle, byte-identical to before.
   */
  columnWidths?: Readonly<Record<string, number>>;
  onColumnWidthChange?: (columnId: string, widthPx: number) => void;
  /** Optional column action menus for sorting, filtering, grouping, and discovery. */
  headerActions?: TableGridHeaderActions;
  /** Optional fixed trailing header control, such as an Add field button. */
  trailingHeader?: ReactNode;
  /** Optional row rendered after the ungrouped item collection. */
  renderAfterRows?: ReactNode;
  /** Optional row rendered directly after a specific item. */
  renderAfterItem?: (item: T) => ReactNode;
  /** Optional row rendered after each expanded group's item collection. */
  renderAfterGroup?: (group: GridTableGroup<T>) => ReactNode;
};

export function GridTable<T>({
  items,
  getRowId,
  columns,
  gridTemplateColumns,
  leadingLabel,
  leadingTooltip,
  leadingColumnWidth,
  onLeadingColumnWidthChange,
  renderLead,
  renderLeadingUtility,
  leadingUtilityHeader,
  isRowSelected,
  onRowClick,
  onRowKeyboardNavigate,
  renderCell,
  sortBy,
  sortDir = "asc",
  onSort,
  leadingSortKey,
  groups,
  groupIcon = null,
  onGroupDrop,
  cardRender,
  mode = "auto",
  columnOrder,
  onColumnOrderChange,
  columnWidths,
  onColumnWidthChange,
  headerActions,
  trailingHeader,
  renderAfterRows,
  renderAfterItem,
  renderAfterGroup,
}: GridTableProps<T>) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set()
  );

  // FEA-4021: reorder the data columns by the caller's persisted `columnOrder`
  // before rendering. The caller pairs `gridTemplateColumns` tracks to the same
  // order (see the props doc), so a column and its track stay aligned. Absent →
  // the input order is preserved unchanged.
  const orderedColumns = orderColumns(columns, columnOrder);
  // Reorder targets the RENDERED order. An empty (or absent) `columnOrder` is
  // the natural-order convention (`orderColumns` treats `[]` as natural), so
  // fall back to the rendered ids — otherwise `[]` would pass no id the header's
  // `columnOrder.includes` check and every drag surface would vanish, leaving a
  // controlled caller unable to start the first reorder.
  const reorder =
    onColumnOrderChange == null
      ? undefined
      : {
          columnOrder:
            columnOrder && columnOrder.length > 0
              ? columnOrder
              : orderedColumns.map((column) => column.id),
          onReorder: onColumnOrderChange,
        };
  // FEA-4168: resize wiring for the header. `getColumnWidth` resolves a column's
  // current rendered px width from the caller's `columnWidths` map (the base a
  // drag/keyboard resize adjusts from); a column absent from the map (a caller
  // that has not measured it yet) degrades to the shared floor so a resize still
  // starts from a sane, grabbable width. The caller folds the emitted width back
  // into its `gridTemplateColumns`, mirroring the reorder contract.
  const resize =
    onColumnWidthChange == null
      ? undefined
      : {
          // Only columns the caller seeds into `columnWidths` are resizable, so
          // trailing chrome columns (actions/extra, absent from the map) never
          // get a lying resize handle — mirrors how reorder gates on columnOrder.
          columnIds: Object.keys(columnWidths ?? {}),
          getColumnWidth: (columnId: string) =>
            columnWidths?.[columnId] ?? MIN_COLUMN_WIDTH_PX,
          onResize: onColumnWidthChange,
        };
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

  const { ref: containerRef, width: containerWidth } =
    useContainerWidth<HTMLDivElement>();

  // Exactly one layout renders (no duplicated DOM): the card fallback is only
  // reachable with a `cardRender`, and then `auto` picks by the measured
  // container width, `compact` forces cards, `expanded` forces the grid. A table
  // with no `cardRender` always renders the bare grid, byte-identical to before.
  const hasCardFallback = cardRender != null;
  const showCards =
    hasCardFallback &&
    (mode === "compact" ||
      (mode === "auto" && containerWidth < CARD_FALLBACK_BREAKPOINT));

  const renderRow = (item: T): ReactNode => (
    <div
      className={cn(
        "group grid h-11 min-w-fit items-center border-b bg-[var(--grid-table-surface,var(--background))] hover:bg-muted/40",
        isRowSelected?.(item) && "bg-primary/10 hover:bg-primary/10"
      )}
      data-grid-row-id={getRowId(item)}
      data-state={isRowSelected?.(item) ? "selected" : undefined}
      draggable={onGroupDrop != null}
      key={getRowId(item)}
      onClick={(event) => {
        if (event.target instanceof HTMLElement) {
          const selectionSurface = event.target.closest(
            "[data-row-selection-surface]"
          );
          if (
            !selectionSurface &&
            event.target.closest(
              "button, a, input, textarea, select, [role='button'], [role='checkbox'], [data-no-row-select]"
            )
          ) {
            return;
          }
          event.target.closest<HTMLElement>("[data-grid-cell]")?.focus();
        }
        onRowClick?.(item, event);
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/grid-row-id", getRowId(item));
        event.dataTransfer.effectAllowed = "move";
      }}
      style={{ gridTemplateColumns }}
    >
      {renderLeadingUtility ? (
        <div className="flex h-full min-w-0 items-center">
          {renderLeadingUtility(item)}
        </div>
      ) : null}
      <div
        className="flex min-w-0 flex-col justify-center py-1 pr-3 pl-4 outline-none"
        data-grid-cell=""
        onKeyDown={(event) =>
          handleGridCellKeyDown(event, (rowId) => {
            const destination = items.find(
              (candidate) => getRowId(candidate) === rowId
            );
            if (destination) {
              onRowKeyboardNavigate?.(destination, event);
            }
          })
        }
        tabIndex={0}
      >
        {renderLead(item)}
      </div>
      {/* No trailing border cell: columns are separated by `border-l`; the
          table's left and right edges are intentionally open. (A fixed-size
          phantom trailing cell here used to overlap the first row's lead cell
          when a caller's template lacked a track for it.) */}
      {orderedColumns.map((column) => (
        <GridTableCell
          columnId={column.id}
          key={column.id}
          onKeyboardNavigate={(rowId, event) => {
            const destination = items.find(
              (candidate) => getRowId(candidate) === rowId
            );
            if (destination) {
              onRowKeyboardNavigate?.(destination, event);
            }
          }}
        >
          {renderCell(column.id, item)}
        </GridTableCell>
      ))}
      {trailingHeader ? <GridTableCell aria-hidden /> : null}
    </div>
  );

  const renderCardItem = (item: T): ReactNode => (
    <Fragment key={getRowId(item)}>
      <div>{cardRender?.(item, orderedColumns)}</div>
      {renderAfterItem?.(item)}
    </Fragment>
  );

  const renderGridItem = (item: T): ReactNode => (
    <Fragment key={getRowId(item)}>
      {renderRow(item)}
      {renderAfterItem?.(item)}
    </Fragment>
  );

  const findItemByDragEvent = (event: DragEvent<HTMLElement>) => {
    const rowId = event.dataTransfer.getData("text/grid-row-id");
    return items.find((candidate) => getRowId(candidate) === rowId);
  };

  const groupDropHandlers = (
    group: GridTableGroup<T>,
    subgroup?: GridTableGroup<T>
  ) =>
    onGroupDrop
      ? {
          onDragOver: (event: DragEvent<HTMLElement>) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          },
          onDrop: (event: DragEvent<HTMLElement>) => {
            event.preventDefault();
            event.stopPropagation();
            const item = findItemByDragEvent(event);
            if (item) {
              onGroupDrop(item, group, subgroup);
            }
          },
        }
      : {};

  const cardList = (
    <div className="flex flex-col gap-3 p-3">
      {groups ? (
        groups.map((group) => {
          const isOpen = !collapsedGroups.has(group.key);
          return (
            <div className="flex flex-col gap-3" key={group.key}>
              <GroupSectionHeader
                count={group.items.length}
                icon={group.icon ?? groupIcon}
                isOpen={isOpen}
                label={group.label}
                onToggle={() => toggleGroup(group.key)}
              />
              {isOpen && group.subgroups
                ? group.subgroups.map((subgroup) => {
                    const subgroupKey = `${group.key}/${subgroup.key}`;
                    const subgroupOpen = !collapsedGroups.has(subgroupKey);
                    return (
                      <div
                        className="ml-3 flex flex-col gap-3 border-l pl-3"
                        key={subgroupKey}
                        {...groupDropHandlers(group, subgroup)}
                      >
                        <GroupSectionHeader
                          className="rounded-md"
                          count={subgroup.items.length}
                          icon={subgroup.icon ?? groupIcon}
                          isOpen={subgroupOpen}
                          label={subgroup.label}
                          onToggle={() => toggleGroup(subgroupKey)}
                        />
                        {subgroupOpen
                          ? subgroup.items.map(renderCardItem)
                          : null}
                      </div>
                    );
                  })
                : isOpen
                  ? group.items.map(renderCardItem)
                  : null}
              {isOpen ? renderAfterGroup?.(group) : null}
            </div>
          );
        })
      ) : (
        <>
          {items.map(renderCardItem)}
          {renderAfterRows}
        </>
      )}
    </div>
  );

  const grid = (
    // `min-w-fit` keeps the header/rows sized to the columns so the host scrolls
    // horizontally when the columns exceed the container.
    <div className="min-w-fit border-t">
      <TableGridHeader
        actions={headerActions}
        columns={orderedColumns.map((column) => ({
          id: column.id,
          label: column.label,
          sortable: onSort != null && column.sortable === true,
          filterable: column.filterable,
          groupable: column.groupable,
          className: column.className,
          tooltip: column.tooltip,
        }))}
        gridTemplateColumns={gridTemplateColumns}
        leadingLabel={leadingLabel}
        leadingResize={
          leadingColumnWidth != null && onLeadingColumnWidthChange
            ? {
                width: leadingColumnWidth,
                onResize: onLeadingColumnWidthChange,
              }
            : undefined
        }
        leadingSortKey={onSort ? leadingSortKey : undefined}
        leadingTooltip={leadingTooltip}
        leadingUtilityCell={leadingUtilityHeader}
        onSort={onSort ?? noopSort}
        reorder={reorder}
        resize={resize}
        sortBy={sortBy ?? null}
        sortDir={sortDir}
        trailingCell={trailingHeader}
      />
      {groups ? (
        groups.map((group) => {
          const isOpen = !collapsedGroups.has(group.key);
          return (
            <div key={group.key} {...groupDropHandlers(group)}>
              <GroupSectionHeader
                className="bg-background py-3 font-semibold"
                count={group.items.length}
                icon={group.icon ?? groupIcon}
                isOpen={isOpen}
                label={group.label}
                onToggle={() => toggleGroup(group.key)}
              />
              {isOpen && group.subgroups
                ? group.subgroups.map((subgroup) => {
                    const subgroupKey = `${group.key}/${subgroup.key}`;
                    const subgroupOpen = !collapsedGroups.has(subgroupKey);
                    return (
                      <div
                        className=""
                        key={subgroupKey}
                        {...groupDropHandlers(group, subgroup)}
                      >
                        <GroupSectionHeader
                          className="bg-background py-3 pl-10 font-semibold"
                          count={subgroup.items.length}
                          icon={subgroup.icon ?? groupIcon}
                          isOpen={subgroupOpen}
                          label={subgroup.label}
                          onToggle={() => toggleGroup(subgroupKey)}
                        />
                        {subgroupOpen
                          ? subgroup.items.map(renderGridItem)
                          : null}
                      </div>
                    );
                  })
                : isOpen
                  ? group.items.map(renderGridItem)
                  : null}
              {isOpen ? renderAfterGroup?.(group) : null}
            </div>
          );
        })
      ) : (
        <>
          {items.map(renderGridItem)}
          {renderAfterRows}
        </>
      )}
    </div>
  );

  // Without a card fallback the table renders the bare grid (no wrapper, no
  // observer), so every existing caller is structurally identical.
  if (!hasCardFallback) {
    return grid;
  }

  // With a fallback, wrap in the measured container. The observed wrapper is
  // ALWAYS full-width (`w-full`, never `min-w-fit`): if the ref sat on the same
  // element the grid grows past with `min-w-fit`, the ResizeObserver would
  // measure the overflowed grid's intrinsic width — wider than 768 on a phone
  // whose columns overflow — so `containerWidth < 768` would never fire and the
  // card fallback would never render. The grid's own `min-w-fit` therefore lives
  // on an inner wrapper, so the host still scrolls horizontally to the grid's
  // intrinsic width while the outer wrapper reports the real available width. The
  // card list is full-width and never scrolls sideways.
  return (
    <div className="w-full" ref={containerRef}>
      {showCards ? cardList : <div className="min-w-fit">{grid}</div>}
    </div>
  );
}

export function GridTableCell({
  children,
  className,
  columnId,
  onKeyboardNavigate,
  ...props
}: {
  children?: ReactNode;
  className?: string;
  /**
   * The owning column's id, surfaced as `data-column-id` so a cell can be
   * targeted unambiguously (in tests or query selectors) by which column it
   * belongs to, independent of what the caller's renderer emits inside it.
   */
  columnId?: string;
  onKeyboardNavigate?: (
    rowId: string,
    event: KeyboardEvent<HTMLDivElement>
  ) => void;
} & React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "group/cell @container/cell flex h-full min-w-0 items-center gap-2 overflow-hidden border-l px-3 outline-none [&>*]:min-w-0",
        className
      )}
      data-column-id={columnId}
      data-grid-cell=""
      onKeyDown={(event) => handleGridCellKeyDown(event, onKeyboardNavigate)}
      tabIndex={columnId ? 0 : undefined}
      {...props}
    >
      {children}
    </div>
  );
}

function handleGridCellKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  onKeyboardNavigate?: (
    rowId: string,
    event: KeyboardEvent<HTMLDivElement>
  ) => void
) {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  if (event.key === "Enter") {
    if (event.target !== event.currentTarget) {
      return;
    }
    const editor =
      event.currentTarget.querySelector<HTMLElement>(
        "[data-grid-primary-editor]"
      ) ??
      event.currentTarget.querySelector<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [role='button']"
      );
    editor?.click();
    return;
  }
  if (
    !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
  ) {
    return;
  }
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    event.target instanceof HTMLSelectElement
  ) {
    return;
  }
  const row = event.currentTarget.parentElement;
  const table = row?.parentElement;
  if (!(row && table)) {
    return;
  }
  const rowCells = Array.from(
    row.querySelectorAll<HTMLElement>("[data-grid-cell]")
  );
  const cellIndex = rowCells.indexOf(event.currentTarget);
  const rows = Array.from(
    table.querySelectorAll<HTMLElement>(":scope > .group.grid")
  );
  const rowIndex = rows.indexOf(row);
  let nextCell: HTMLElement | undefined;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    nextCell = rowCells[cellIndex + (event.key === "ArrowLeft" ? -1 : 1)];
  } else {
    const nextRow = rows[rowIndex + (event.key === "ArrowUp" ? -1 : 1)];
    nextCell = nextRow
      ? Array.from(nextRow.querySelectorAll<HTMLElement>("[data-grid-cell]"))[
          cellIndex
        ]
      : undefined;
  }
  if (nextCell) {
    event.preventDefault();
    nextCell.focus();
    const nextRowId = nextCell.parentElement?.dataset.gridRowId;
    if (nextRowId && onKeyboardNavigate) {
      onKeyboardNavigate(nextRowId, event);
    } else {
      nextCell.click();
    }
  }
}

export function GridEmptyValue() {
  return <span className="text-muted-foreground/50 text-sm">—</span>;
}

/**
 * True when a cell value is the shared empty-value sentinel (`GridEmptyValue`)
 * or renders nothing (`null`/`undefined`). On the grid an em-dash reads as "no
 * value in this column"; stacked down a card, a run of "Model —", "PR —" lines
 * reads as a broken card, so the card builder drops these rows instead of
 * listing them (see `GridTableCard`).
 */
export function isEmptyCellValue(value: ReactNode): boolean {
  if (value == null) {
    return true;
  }
  return isValidElement(value) && value.type === GridEmptyValue;
}

/**
 * One key/value line in a `GridTableCard` body. `label` is the column name; the
 * `value` is whatever the caller's cell renderer returns for that row (a chip, a
 * status badge, plain text). Skip a row entirely rather than passing an empty
 * value so the card body has no blank lines.
 */
export type GridTableCardField = {
  key: string;
  label: string;
  value: ReactNode;
};

/**
 * The card a `GridTable` renders per row on narrow surfaces (FEA-3865). The lead
 * cell becomes the card header (name + status); the remaining columns become a
 * two-column key/value body. Built on the shared `Card` so radius, border, and
 * background match every other card in the product — consumers supply only the
 * header content and the field list, never bespoke card chrome.
 *
 * Spacing rhythm (deliberate, defined once here): a mobile *list* card is denser
 * than a standalone content Card — `gap-3 py-4` with `px-4` on header/content,
 * vs the product's default `gap-6 py-6 px-6` — so a scrolled list of rows stays
 * scannable without wasting vertical space per row. This is THE canonical
 * mobile-list card: every table→card fallback composes it rather than hand-
 * rolling a divergent rhythm, so the density is picked once and can't drift.
 */
export function GridTableCard({
  header,
  fields,
}: {
  header: ReactNode;
  fields: readonly GridTableCardField[];
}) {
  // Drop fields whose cell renders empty (the em-dash sentinel or nothing): on a
  // card a stack of "Model —", "PR —" lines reads as broken, so a session/branch
  // missing its optional columns shows only the columns it actually has.
  const populatedFields = fields.filter(
    (field) => !isEmptyCellValue(field.value)
  );
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">{header}</CardHeader>
      {populatedFields.length > 0 ? (
        <CardContent className="px-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            {populatedFields.map((field) => (
              <div className="flex min-w-0 flex-col gap-0.5" key={field.key}>
                <dt className="text-muted-foreground text-xs">{field.label}</dt>
                <dd className="flex min-w-0 items-center text-sm">
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      ) : null}
    </Card>
  );
}

/**
 * Build a `GridTableCard`'s key/value body from the table's columns (FEA-3865).
 * Every table→card fallback derives its body identically: take the table's
 * columns, drop the ids the card promotes into its header (status + row
 * actions), then map each remaining column to a `{ key, label, value }` field
 * whose value comes from the table's own `renderCell` so the card and the grid
 * row never drift. Centralized here so this contract — and any future change to
 * it — lives once instead of being copy-pasted into each card component.
 */
export function buildGridTableCardFields<T>(
  columns: readonly GridTableColumn[],
  excludeIds: ReadonlySet<string>,
  renderCell: (columnId: string, item: T) => ReactNode,
  item: T
): GridTableCardField[] {
  return columns
    .filter((column) => !excludeIds.has(column.id))
    .map((column) => ({
      key: column.id,
      label: column.label,
      value: renderCell(column.id, item),
    }));
}

function noopSort() {
  // Column sorting is not wired in this view yet.
}
