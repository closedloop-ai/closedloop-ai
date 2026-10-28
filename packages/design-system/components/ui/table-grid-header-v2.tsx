// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: Preserve the approved Generic Artifact prototype interaction contract in this v2 component.
// biome-ignore-all lint/a11y/noStaticElementInteractions: Preserve the approved Generic Artifact prototype interaction contract in this v2 component.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Preserve the approved Generic Artifact prototype behavior in this v2 component.
// biome-ignore-all lint/complexity/useOptionalChain: Preserve exact boolean values in this v2 component.
// biome-ignore-all lint/style/noNestedTernary: Preserve the approved Generic Artifact prototype render branches in this v2 component.
"use client";

// Grid Table v2 promotion candidate, copied from the approved Generic Artifact prototype.

import { Checkbox } from "@closedloop-ai/design-system/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import {
  type AriaSort,
  getAriaSort,
  getNextSortDirection,
  type SortDirection,
  SortIndicator,
} from "@closedloop-ai/design-system/components/ui/sortable-column-header";
import {
  type ColumnMovePlacement,
  moveColumn,
} from "@closedloop-ai/design-system/lib/column-order";
import {
  ColumnAlignment,
} from "@closedloop-ai/design-system/lib/column-registry";
import {
  buildChromeRowProps,
  type GridChromeCellProps,
  NAVIGABLE_CHROME_CELL_CLASS,
} from "@closedloop-ai/design-system/lib/grid-table-v2-chrome-rows";
import {
  LEAD_CELL_COLUMN_KEY,
  LEADING_COLUMN_DATA_ID,
  UTILITY_CELL_COLUMN_KEY,
} from "@closedloop-ai/design-system/lib/grid-table-v2-rows";
import {
  type GridColumnTracks,
  resolveColumnControlName,
  resolveColumnHeaderAriaLabel,
  resolveGridColumnTracks,
} from "@closedloop-ai/design-system/lib/grid-table-aria";
import {
  PINNED_LEAD_AFTER_UTILITY_CELL_CLASS,
  PINNED_LEAD_CELL_CLASS,
  PINNED_LEAD_HEADER_HOVER_TINT_CLASS,
  PINNED_LEAD_TINT_CLASS,
  PINNED_LEAD_UTILITY_CELL_CLASS,
  PINNED_HEADER_STACKING_CLASS,
  resolveLeadingUtilityPinOffset,
} from "@closedloop-ai/design-system/lib/grid-table-pin";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { type ReactNode, useState } from "react";
import type { TableGridHeaderV2Resize } from "./grid-table-v2-cell";
import {
  COLUMN_DRAG_DATA_TYPE,
  ColumnResizeHandle,
  handleColumnDrop,
} from "./table-grid-header-v2-handles";
import {
  HeaderActionsMenu,
  HeaderLabel,
} from "./table-grid-header-v2-label";

export type TableGridHeaderV2Column = {
  id: string;
  label: string;
  sortable?: boolean;
  filterable?: boolean;
  groupable?: boolean;
  className?: string;
  /** Optional help text shown via an info icon + tooltip after the label. */
  tooltip?: string;
  /**
   * Accessible name for a column whose visible `label` is intentionally empty —
   * a row-actions or icon column. It names the `columnheader` element, and it is
   * also what the column's own controls (the sort button, the options button,
   * the resize handle) call the column, since none can spell a name out of a
   * blank label.
   */
  ariaLabel?: string;
  /**
   * Which end of the track the header label sits at. Absent renders exactly the
   * class list this header rendered before, because a label already starts at
   * the leading edge.
   */
  align?: ColumnAlignment;
};

/**
 * Column-reorder wiring (FEA-4021). When present, each data-column header is a
 * native drag surface; pointer users drag the label/header onto another header
 * to reorder. The column menu remains the keyboard-accessible move path.
 * `onReorder` receives the full new column-id order the caller persists.
 */
export type TableGridHeaderV2Reorder = {
  /** Current column-id order (the order the columns are rendered in). */
  columnOrder: readonly string[];
  onReorder: (nextOrder: string[]) => void;
  /**
   * Which of those columns the user may actually MOVE (ISS-9313). A column
   * outside this list still holds its slot in `columnOrder` — it is ordered,
   * just not draggable — which is why this is a second list rather than an
   * omission from the first.
   *
   * Absent means every ordered column moves, so a caller that never declared
   * per-column movability is unchanged.
   */
  movableColumnIds?: readonly string[];
};

/**
 * Column-resize wiring (FEA-4168). When present, each data-column header grows a
 * resize handle on its right edge: pointer users drag it to set the column's
 * width; keyboard users focus the handle and press `ArrowLeft`/`ArrowRight` to
 * shrink/grow it one step. `onResize` receives the resized column id and its new
 * pixel width (already clamped to the shared floor); the caller persists the map
 * and feeds current widths back via `getColumnWidth`. Absent → no resize handle.
 */
export type { TableGridHeaderV2Resize } from "./grid-table-v2-cell";

export type TableGridHeaderV2SortOption = {
  key: string;
  label: string;
};

export type TableGridHeaderV2Actions = {
  /**
   * Column-scoped filter controls rendered in a nested Filter submenu. This is
   * intentionally separate from the table-level filter trigger: a header menu
   * must keep the user in the column context instead of opening a second,
   * unrelated surface elsewhere on the page.
   */
  getFilterContent?: (columnId: string) => ReactNode;
  onFilter?: (columnId: string) => void;
  onGroup?: (columnId: string) => void;
  onMove?: (columnId: string, direction: ColumnMovePlacement) => void;
};

type TableGridHeaderV2Props = {
  gridTemplateColumns: string;
  columns: readonly TableGridHeaderV2Column[];
  sortBy: string | null;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
  leadingLabel?: string;
  /** Optional hover guidance for the fixed leading column. */
  leadingTooltip?: string;
  /**
   * Optional resize wiring for the fixed leading identity column. It stays
   * outside the reorderable data-column collection, but uses the same pointer
   * and keyboard interaction as every other resizable header.
   */
  leadingResize?: {
    width: number;
    onResize: (widthPx: number) => void;
  };
  leadingSortKey?: string;
  leadingSortOptions?: readonly TableGridHeaderV2SortOption[];
  onClearSort?: () => void;
  showSelectAll?: boolean;
  /** Matches the select-all box to the 24px row boxes of the one-column list. */
  isNarrowList?: boolean;
  allSelected?: boolean;
  someSelected?: boolean;
  onSelectAll?: (checked: boolean) => void;
  showRankSlot?: boolean;
  /** Optional fixed utility cell before the leading identity column. */
  leadingUtilityCell?: ReactNode;
  trailingCell?: ReactNode;
  className?: string;
  /** Column-reorder wiring (FEA-4021); absent → static headers. */
  reorder?: TableGridHeaderV2Reorder;
  /** Column-resize wiring (FEA-4168); absent → no resize handles. */
  resize?: TableGridHeaderV2Resize;
  /** Pin the leading identity header cell during horizontal scroll. */
  pinLeadColumn?: boolean;
  /** Optional Asana-style column action menus. */
  actions?: TableGridHeaderV2Actions;
  /**
   * ARIA table semantics (ISS-4672), the v2 twin of `TableGridHeader`'s prop of
   * the same name. Set this ONLY when the header is rendered inside an element
   * carrying `role="grid"` — as `GridTableV2` renders it. The header then
   * becomes `role="row"` and each header cell a `role="columnheader"` carrying
   * the `aria-colindex` of its grid track (plus `aria-sort` when the column is
   * sortable), which is what lets a screen reader announce a body cell as
   * "Status, Active" instead of a loose "Active".
   *
   * Opt-in rather than always-on for the same reason as v1: a
   * `row`/`columnheader` with no `grid`/`table` ancestor is itself an ARIA
   * violation (`aria-required-parent`), so a caller rendering this header
   * standalone must declare the container role and matching body indexes first.
   * `trailingCell` is caller-owned markup, so an opting-in caller that passes
   * one must give it `role="columnheader"` and the next `aria-colindex` itself.
   */
  insideAriaTable?: boolean;
  /**
   * This row's 1-based `aria-rowindex`, which for a column header is 1 — the
   * grid's first row.
   *
   * Supplied only by a grid that declares a row lattice at all, which today is
   * one whose body paints a WINDOW of its rows (ISS-12288): a reader there
   * cannot count the rows above a cell for themselves, so every row has to say
   * where it sits. Absent → the attribute is omitted and the header's markup is
   * what it always was.
   */
  ariaRowIndex?: number;
  /**
   * The grid's resolved track numbering (ISS-9564), supplied by the compositor
   * that owns both this header and the body it pairs with — `GridTableV2` — so
   * the two cannot number the grid, or anchor the pin, from different tracks.
   *
   * Absent → resolved from `leadingUtilityCell`, which is all a standalone
   * caller has, and which has no second run here to disagree with.
   */
  columnTracks?: GridColumnTracks;
  /**
   * Roving-focus wiring for the header's own cells (ISS-8930). Present → the
   * header row joins the grid's row walk and each `columnheader` becomes a
   * navigable cell, so `ArrowUp` from the first data row reaches the sort
   * control and the resize handle, and `Enter`/`F2` enters the cell to operate
   * them. Absent → byte-identical to before: no `data-grid-row`, no
   * `data-grid-cell`, and the header's controls keep their own native tab stops.
   *
   * Supplied by `GridTableV2`, which owns the roving key vocabulary; a caller
   * rendering this header standalone leaves it off, exactly as it leaves
   * `insideAriaTable` off.
   */
  navigation?: {
    rowId: string;
    getCellProps: (columnKey: string) => GridChromeCellProps;
  };
};

export function TableGridHeaderV2({
  gridTemplateColumns,
  columns,
  sortBy,
  sortDir,
  onSort,
  leadingLabel = "Name",
  leadingTooltip,
  leadingResize,
  leadingSortKey,
  leadingSortOptions,
  onClearSort,
  showSelectAll,
  isNarrowList = false,
  allSelected,
  someSelected,
  onSelectAll,
  showRankSlot = false,
  leadingUtilityCell,
  trailingCell,
  className,
  reorder,
  resize,
  pinLeadColumn = false,
  actions,
  insideAriaTable = false,
  ariaRowIndex,
  navigation,
  columnTracks,
}: TableGridHeaderV2Props) {
  // One predicate for both the resolver call and the render branch below:
  // `ReactNode` admits `""`, `0` and `false`, which are `!= null` but falsy, so
  // two spellings of "was I given a cell" would shift the numbering for a value
  // that paints nothing.
  const hasUtilityCell = Boolean(leadingUtilityCell);
  const tracks =
    columnTracks ??
    resolveGridColumnTracks({
      hasLeadingUtility: hasUtilityCell,
      dataColumnCount: columns.length,
    });
  // ISS-11837, ISS-11931: a lead cell that renders a named control (the resize
  // handle, or whichever sort control `LeadingHeaderControl` picks: the options
  // menu or plain button for a sort key, the trigger for non-empty sort
  // options) is named by its label alone. Chromium otherwise appends each
  // control's `aria-label` to the content-derived name, announcing the Sessions
  // lead as "Resize Session column, N pixels wide, use arrow keys Session".
  const leadingRendersNamedControl = Boolean(
    leadingResize || leadingSortKey || leadingSortOptions?.length
  );
  const leadingHeaderName =
    insideAriaTable && leadingRendersNamedControl
      ? resolveColumnControlName(
          leadingLabel,
          leadingSortKey ?? LEADING_COLUMN_DATA_ID
        )
      : undefined;
  return (
    <div
      className={cn(
        "sticky top-0 z-10 grid h-[35px] min-w-fit border-b bg-[var(--grid-table-surface,var(--background))]",
        className
      )}
      aria-rowindex={insideAriaTable ? ariaRowIndex : undefined}
      role={insideAriaTable ? "row" : undefined}
      style={{ gridTemplateColumns }}
      {...(navigation ? buildChromeRowProps(navigation.rowId) : undefined)}
    >
      {hasUtilityCell ? (
        <div
          aria-colindex={
            insideAriaTable ? tracks.leadingUtilityColumnIndex : undefined
          }
          className={cn(
            "flex min-w-0 items-center",
            navigation && NAVIGABLE_CHROME_CELL_CLASS,
            // ISS-9223: the pinned region's left half. Its BODY twin is pinned
            // too, so leaving the header cell out would scroll the utility
            // label away from the control underneath it.
            pinLeadColumn && [
              PINNED_LEAD_UTILITY_CELL_CLASS,
              PINNED_HEADER_STACKING_CLASS,
            ]
          )}
          role={insideAriaTable ? "columnheader" : undefined}
          {...navigation?.getCellProps(UTILITY_CELL_COLUMN_KEY)}
        >
          {leadingUtilityCell}
        </div>
      ) : showRankSlot ? (
        <div />
      ) : null}
      <div
        aria-colindex={insideAriaTable ? tracks.leadColumnIndex : undefined}
        aria-label={leadingHeaderName}
        aria-sort={
          insideAriaTable
            ? getLeadingAriaSort(
                sortBy,
                sortDir,
                leadingSortKey,
                leadingSortOptions
              )
            : undefined
        }
        className={cn(
          "group/header relative flex min-w-0 items-center py-0 pr-2 pl-3 transition-colors",
          navigation && NAVIGABLE_CHROME_CELL_CLASS,
          pinLeadColumn &&
            (hasUtilityCell
              ? PINNED_LEAD_AFTER_UTILITY_CELL_CLASS
              : PINNED_LEAD_CELL_CLASS),
          pinLeadColumn && PINNED_HEADER_STACKING_CLASS,
          pinLeadColumn
            ? [PINNED_LEAD_TINT_CLASS, PINNED_LEAD_HEADER_HOVER_TINT_CLASS]
            : "hover:bg-muted/40"
        )}
        data-column-id={LEADING_COLUMN_DATA_ID}
        role={insideAriaTable ? "columnheader" : undefined}
        // Resolved from the SAME template string `GridTableV2` reads for the
        // body cell, so the label and the values under it park on one anchor
        // whatever width the caller declared for its utility track.
        style={
          pinLeadColumn && hasUtilityCell
            ? { left: resolveLeadingUtilityPinOffset(gridTemplateColumns) }
            : undefined
        }
        {...navigation?.getCellProps(LEAD_CELL_COLUMN_KEY)}
      >
        {leadingResize ? (
          <ColumnResizeHandle
            columnId={LEADING_COLUMN_DATA_ID}
            label={resolveColumnControlName(
              leadingLabel,
              LEADING_COLUMN_DATA_ID
            )}
            resize={{
              columnIds: [LEADING_COLUMN_DATA_ID],
              getColumnWidth: () => leadingResize.width,
              onResize: (_columnId, widthPx) => leadingResize.onResize(widthPx),
            }}
          />
        ) : null}
        {showSelectAll ? (
          // `size-7` is this package's dense control slot (the same one
          // `table-cell-primitives` and the saved-views switcher reserve), and
          // it is what a dense row centres its own checkbox in. Centring the
          // header's in the same slot is what puts the control over the column
          // of checkboxes it governs: with a bare margin the header's 16px box
          // sat hard against the cell padding while every row centred its own,
          // leaving the two 10px apart down the length of the table.
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center",
              // The narrow row's checkbox slot sits one step in from the cell edge.
              isNarrowList && "ml-1"
            )}
          >
            <Checkbox
              aria-label={allSelected ? "Deselect all" : "Select all"}
              checked={getSelectAllState(allSelected, someSelected)}
              className={isNarrowList ? "size-6" : undefined}
              onCheckedChange={(checked) => onSelectAll?.(checked === true)}
            />
          </span>
        ) : null}
        <LeadingHeaderControl
          actions={actions}
          label={leadingLabel}
          onClearSort={onClearSort}
          onSort={onSort}
          sortBy={sortBy}
          sortDir={sortDir}
          sortKey={leadingSortKey}
          sortOptions={leadingSortOptions}
          tooltip={leadingTooltip}
        />
      </div>

      {columns.map((column, index) => (
        <ColumnHeaderCell
          actions={actions}
          colIndex={
            insideAriaTable
              ? tracks.dataColumnIndex(index)
              : undefined
          }
          column={column}
          key={column.id}
          navigationProps={navigation?.getCellProps(column.id)}
          onSort={onSort}
          reorder={reorder}
          resize={resize}
          sortBy={sortBy}
          sortDir={sortDir}
        />
      ))}

      {/* Trailing cell is opt-in via `trailingCell` (e.g. the documents table's
          More-menu header slot). No implicit phantom default: a fixed-height
          one used to wrap onto an implicit grid row and overlap the first data
          row's lead cell when a caller's template had no track for it. */}
      {trailingCell}
    </div>
  );
}

function LeadingHeaderControl({
  label,
  sortKey,
  sortOptions,
  sortBy,
  sortDir,
  onSort,
  onClearSort,
  actions,
  tooltip,
}: {
  label: string;
  sortKey?: string;
  sortOptions?: readonly TableGridHeaderV2SortOption[];
  sortBy: string | null;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
  onClearSort?: () => void;
  actions?: TableGridHeaderV2Actions;
  tooltip?: string;
}) {
  if (sortKey && actions) {
    return (
      <HeaderActionsMenu
        actions={actions}
        columnId={sortKey}
        controlName={resolveColumnControlName(label, sortKey)}
        filterable={false}
        groupable={false}
        label={label}
        onSort={onSort}
        sortBy={sortBy}
        sortDir={sortDir}
        tooltip={tooltip}
      />
    );
  }
  if (sortOptions?.length) {
    const isActive = sortOptions.some((option) => option.key === sortBy);

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-1 hover:text-foreground"
            type="button"
          >
            <span className="min-w-0 truncate font-medium text-muted-foreground text-xs">
              {label}
            </span>
            <SortIndicator
              className="size-3 shrink-0"
              direction={sortDir}
              isActive={isActive}
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {sortOptions.map((option) => (
            <DropdownMenuItem
              key={option.key}
              onClick={() => {
                if (sortBy !== option.key) {
                  onSort(option.key, "asc");
                } else if (sortDir === "asc") {
                  onSort(option.key, "desc");
                } else {
                  onClearSort?.();
                }
              }}
            >
              <span className="flex-1">{option.label}</span>
              {/* `size-3`, not `h-3 w-3`: `DropdownMenuItem` sizes any svg whose
                  class does not match `size-`, and the attribute test does not
                  see the h/w pair — so the item's rule won and this arrow
                  painted at 16px beside a 12px one on the trigger. */}
              <SortIndicator
                className="size-3 shrink-0"
                direction={sortDir}
                isActive={sortBy === option.key}
              />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (sortKey) {
    return (
      <button
        className="flex items-center gap-1 hover:text-foreground"
        onClick={() =>
          onSort(sortKey, getNextSortDirection(sortBy === sortKey, sortDir))
        }
        type="button"
      >
        <span className="font-medium text-muted-foreground text-xs">
          {label}
        </span>
        <SortIndicator
          className="h-3 w-3"
          direction={sortDir}
          isActive={sortBy === sortKey}
        />
      </button>
    );
  }

  return (
    <span className="font-medium text-muted-foreground text-xs">{label}</span>
  );
}

function getSelectAllState(
  allSelected?: boolean,
  someSelected?: boolean
): boolean | "indeterminate" {
  if (allSelected) {
    return true;
  }
  if (someSelected) {
    return "indeterminate";
  }
  return false;
}

/**
 * One data-column header cell (FEA-4021). Renders the sortable-or-static label +
 * optional tooltip, and — when `reorder` is wired — a native drag surface with
 * source/target feedback. Extracted from the header's
 * `columns.map` so each concern (sort, tooltip, reorder) stays a small unit and
 * the header's cognitive complexity stays low.
 */
function ColumnHeaderCell({
  column,
  sortBy,
  sortDir,
  onSort,
  reorder,
  resize,
  actions,
  colIndex,
  navigationProps,
}: {
  column: TableGridHeaderV2Column;
  sortBy: string | null;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
  reorder?: TableGridHeaderV2Reorder;
  resize?: TableGridHeaderV2Resize;
  actions?: TableGridHeaderV2Actions;
  /**
   * 1-based grid-track index of this header (ISS-4672), set only when the
   * header row is inside a `role="grid"`. Defined → the cell becomes a
   * `columnheader` announced with that `aria-colindex`; undefined → no roles, so
   * a header rendered outside a grid never emits an orphan `columnheader`.
   */
  colIndex?: number;
  /** Roving-focus wiring (ISS-8930); absent → the cell is not navigable. */
  navigationProps?: GridChromeCellProps;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  // Only columns the caller lists in `columnOrder` get a drag handle + drop
  // target; a fixed trailing column (e.g. a row-actions column absent from the
  // order) stays pinned and shows no handle.
  // Two different questions. `handleColumnDrop` moves the dragged column to the
  // drop target's INDEX, so a column that refuses `dragover` is a hole in the
  // order: gating both sides on movability leaves the movable column draggable
  // with nowhere to land.
  const isOrderedColumn =
    reorder != null && reorder.columnOrder.includes(column.id);
  const canReorder =
    isOrderedColumn && (reorder.movableColumnIds?.includes(column.id) ?? true);
  // ISS-5333, ported from v1: ONE derived flag feeding the cell, the sort button
  // and the label, so the three can never be aligned differently. Alignment is
  // binary here as it is in v1 — `Center` has no kind default and no caller, so
  // it renders start-aligned rather than growing a third untested geometry.
  const alignEnd = column.align === ColumnAlignment.End;
  // Resize is opt-in per table (FEA-4168) and gated to the caller's declared
  // `columnIds`, mirroring `reorder`. A fixed trailing column (row-actions /
  // non-resizable `extra`) absent from that list shows NO handle, so we never
  // render an operable control whose emitted width `setColumnWidth` discards. A
  // table that never wires `resize` is byte-identical to before.
  const canResize = resize != null && resize.columnIds.includes(column.id);
  // What the column's own CONTROLS call it. A blank-label column still grows a
  // resize handle and an options button, and both name themselves by
  // interpolating this.
  const controlName = resolveColumnControlName(
    column.label,
    column.id,
    column.ariaLabel
  );
  const moveReorderableColumn = (direction: ColumnMovePlacement) => {
    if (!(canReorder && reorder)) {
      return;
    }
    const currentIndex = reorder.columnOrder.indexOf(column.id);
    const targetIndex =
      direction === "start"
        ? 0
        : direction === "end"
          ? reorder.columnOrder.length - 1
          : direction === "left"
            ? currentIndex - 1
            : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= reorder.columnOrder.length) {
      return;
    }
    reorder.onReorder(
      moveColumn(reorder.columnOrder, currentIndex, targetIndex)
    );
  };
  const resolvedActions =
    actions || canReorder
      ? {
          ...actions,
          onMove:
            actions?.onMove ??
            ((_columnId: string, direction: ColumnMovePlacement) =>
              moveReorderableColumn(direction)),
        }
      : undefined;
  // The menu button renders only when at least one item will be INSIDE it.
  // `filterable`/`groupable` are column capabilities, so each is paired with
  // the host callback that makes it operable; otherwise a column declaring only
  // `groupable`, on a table that wired only `onFilter`, opens an empty menu.
  const showsOptionsMenu = Boolean(
    resolvedActions &&
      (column.sortable ||
        (column.filterable &&
          (resolvedActions.getFilterContent || resolvedActions.onFilter)) ||
        (column.groupable && resolvedActions.onGroup) ||
        canReorder)
  );
  // The options menu, the resize handle and the standalone sort button are the
  // cell's named controls; the sort button renders on the same truthy
  // `column.sortable` read below.
  const rendersNamedControl =
    showsOptionsMenu || canResize || Boolean(column.sortable);
  return (
    <div
      aria-colindex={colIndex}
      // Gated on `colIndex` for the same reason v1 gates its own: `aria-label`
      // is prohibited on a role-less element, so it may only be set once this
      // cell is a real `columnheader`.
      //
      // ISS-11837, ISS-11931: with a named control inside, a content-derived
      // name carries that control's `aria-label` in Chromium ("Resize Owner
      // column, 200 pixels wide, use arrow keys Owner"). The header is named by
      // the column's name alone, which for a labelled column is its visible
      // label (WCAG 2.5.3), and each control keeps its own name.
      aria-label={
        colIndex === undefined
          ? undefined
          : rendersNamedControl
            ? controlName
            : resolveColumnHeaderAriaLabel(
                column.label,
                column.id,
                column.ariaLabel
              )
      }
      // Only a sortable header may announce a sort state: `aria-sort="none"` on
      // a static column would advertise a sort control the user cannot operate.
      // That absent-vs-`none` split is the contract ISS-10425 ruled on — see
      // `getAriaSort`.
      aria-sort={
        colIndex !== undefined && column.sortable
          ? getAriaSort(sortBy === column.id, sortDir)
          : undefined
      }
      className={cn(
        "relative flex h-[35px] min-w-0 items-center border-l py-0 pl-3 transition-colors hover:bg-muted/40",
        // `pr-3` on an end-aligned column matches the data cell's `px-3`, so the
        // header word sits on the same x as the digits; `pr-2` elsewhere is
        // untouched.
        alignEnd ? "justify-end pr-3" : "pr-2",
        (canReorder || canResize) && "group/header",
        isDragging && "opacity-[0.45]",
        isDropTarget &&
          "shadow-[inset_2px_0_0_var(--primary)] before:absolute before:top-1 before:bottom-1 before:-left-px before:w-0.5 before:rounded-full before:bg-primary",
        navigationProps && NAVIGABLE_CHROME_CELL_CLASS,
        column.className
      )}
      data-column-id={column.id}
      draggable={canReorder}
      role={colIndex === undefined ? undefined : "columnheader"}
      {...navigationProps}
      onDragEnd={
        canReorder
          ? () => {
              setIsDragging(false);
              setIsDropTarget(false);
            }
          : undefined
      }
      onDragEnter={
        isOrderedColumn
          ? (event) => {
              if (event.dataTransfer.types.includes(COLUMN_DRAG_DATA_TYPE)) {
                setIsDropTarget(true);
              }
            }
          : undefined
      }
      onDragLeave={
        // `isOrderedColumn`, matching enter/over/drop: a fixed-but-ordered
        // column is a valid drop TARGET, so gating only its leave on
        // movability strands `isDropTarget` true after the pointer leaves.
        isOrderedColumn
          ? (event) => {
              if (
                event.relatedTarget instanceof Node &&
                event.currentTarget.contains(event.relatedTarget)
              ) {
                return;
              }
              setIsDropTarget(false);
            }
          : undefined
      }
      onDragOver={
        isOrderedColumn
          ? (event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }
          : undefined
      }
      onDragStart={
        canReorder
          ? (event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("[data-no-column-drag]")
              ) {
                event.preventDefault();
                return;
              }
              event.dataTransfer.setData(COLUMN_DRAG_DATA_TYPE, column.id);
              event.dataTransfer.effectAllowed = "move";
              setIsDragging(true);
            }
          : undefined
      }
      onDrop={
        isOrderedColumn
          ? (event) => {
              setIsDropTarget(false);
              handleColumnDrop(event, reorder, column.id);
            }
          : undefined
      }
    >
      {canResize ? (
        <ColumnResizeHandle
          columnId={column.id}
          label={controlName}
          resize={resize}
        />
      ) : null}
      {showsOptionsMenu && resolvedActions ? (
        <HeaderActionsMenu
          actions={resolvedActions}
          alignEnd={alignEnd}
          columnId={column.id}
          controlName={controlName}
          draggable={canReorder}
          filterable={column.filterable}
          groupable={column.groupable}
          label={column.label}
          movable={canReorder}
          onSort={onSort}
          sortable={column.sortable}
          sortBy={sortBy}
          sortDir={sortDir}
          tooltip={
            column.tooltip ??
            (canReorder ? "Drag to reorder column" : undefined)
          }
        />
      ) : column.sortable ? (
        <button
          // The sort control of a blank-label column has only an icon inside
          // it, so without this it is an operable button with no accessible
          // name at all. A column WITH a visible label gets `undefined` — that
          // text is already the button's name and must not be overridden.
          aria-label={resolveColumnHeaderAriaLabel(
            column.label,
            column.id,
            column.ariaLabel
          )}
          className={cn(
            "flex items-center gap-1 overflow-hidden hover:text-foreground",
            // Sized to its content when end-aligned so the CELL can move it;
            // `flex-1` here is what made v1's `justify-end` inert.
            alignEnd ? "min-w-0" : "flex-1"
          )}
          onClick={() =>
            onSort(
              column.id,
              getNextSortDirection(sortBy === column.id, sortDir)
            )
          }
          type="button"
        >
          {alignEnd ? (
            <SortIndicator
              className="h-3 w-3"
              direction={sortDir}
              isActive={sortBy === column.id}
            />
          ) : null}
          <HeaderLabel
            alignEnd={alignEnd}
            draggable={canReorder}
            label={column.label}
            tooltip={
              column.tooltip ??
              (canReorder ? "Drag to reorder column" : undefined)
            }
          />
          {alignEnd ? null : (
            <SortIndicator
              className="h-3 w-3"
              direction={sortDir}
              isActive={sortBy === column.id}
            />
          )}
        </button>
      ) : (
        <HeaderLabel
          alignEnd={alignEnd}
          draggable={canReorder}
          label={column.label}
          tooltip={
            column.tooltip ??
            (canReorder ? "Drag to reorder column" : undefined)
          }
        />
      )}
    </div>
  );
}

/**
 * `aria-sort` for the leading identity column, which sorts either by a single
 * `leadingSortKey` or by whichever of its `leadingSortOptions` is active.
 * Returns `undefined` when the lead column is not sortable at all, so an
 * unsortable header never announces a sort state.
 */
function getLeadingAriaSort(
  sortBy: string | null,
  sortDir: SortDirection,
  sortKey?: string,
  sortOptions?: readonly TableGridHeaderV2SortOption[]
): AriaSort | undefined {
  if (sortOptions?.length) {
    return getAriaSort(
      sortOptions.some((option) => option.key === sortBy),
      sortDir
    );
  }
  if (sortKey) {
    return getAriaSort(sortBy === sortKey, sortDir);
  }
  return undefined;
}
