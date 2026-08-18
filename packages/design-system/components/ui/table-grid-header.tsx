"use client";

import {
  FIRST_COLUMN_INDEX,
  getDataColumnIndex,
} from "@closedloop-ai/design-system/lib/grid-table-aria";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { InfoIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Checkbox } from "./checkbox";
import {
  ColumnOptionsMenu,
  hasColumnMenuItems,
  type TableGridHeaderActions,
} from "./table-grid-column-menu";
import {
  ColumnDragHandle,
  ColumnResizeHandle,
  handleColumnDrop,
  isColumnDragEvent,
  startColumnDrag,
} from "./table-grid-header-handles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import {
  type AriaSort,
  getAriaSort,
  getNextSortDirection,
  SortIndicator,
  type SortDirection,
} from "./sortable-column-header";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * Which end of its header cell a column's label sits at (ISS-5333). Const object
 * + type alias, not a bare string union, so callers reference a shared member
 * instead of repeating the literal (AGENTS.md → Code Style).
 */
export const TableGridHeaderAlign = {
  Start: "start",
  End: "end",
} as const;
export type TableGridHeaderAlign =
  (typeof TableGridHeaderAlign)[keyof typeof TableGridHeaderAlign];

export type TableGridHeaderColumn = {
  id: string;
  label: string;
  sortable?: boolean;
  /**
   * Extra classes for this header cell.
   *
   * ISS-5333 (review): NOT the place for alignment. A `justify-*` here lands on
   * the cell and is silently inert on a SORTABLE column (the label is wrapped in
   * a button that consumes the cell) while appearing to work on a non-sortable
   * one — the exact split this ticket fixes. Use {@link
   * TableGridHeaderColumn.headerAlign}, which applies to both. Documented rather
   * than warned at runtime: this is a `"use client"` module, and
   * `scripts/lint/rules/no-client-debug-logging.ts` allows `console.*` in
   * browser-bundled code only at an error-boundary site.
   */
  className?: string;
  /**
   * ISS-5333: which end of its cell this header's LABEL sits at. Opt-in — absent
   * keeps the existing hard-left label on every column that never asked for it.
   *
   * This exists because a `justify-end` passed through `className` is inert on a
   * SORTABLE column: the cell is a flex row, but a sortable header wraps its
   * label in a `flex-1` button that consumes the whole cell, leaving the cell's
   * `justify-*` nothing to distribute. (`Versions` — not sortable, a bare span —
   * was the only count column whose header actually moved.) `headerAlign` is
   * applied to the cell AND that button together, so the label lands at the same
   * edge whether or not the column sorts.
   *
   * `End` also LEADS the label with the sort caret and the help icon instead of
   * trailing them. Trailing right-aligns the caret and the icon and leaves the
   * label inset from the rail by their width — different widths per column, so
   * adjacent right-aligned headers do not line up with each other or with their
   * own digits. Leading them puts the label last, on the values' x.
   */
  headerAlign?: TableGridHeaderAlign;
  /** Optional help text shown via an info icon + tooltip after the label. */
  tooltip?: string;
  /**
   * Accessible name for a column whose visible `label` is intentionally empty
   * (a row-actions or other chrome column). Applied as `aria-label` on the
   * `columnheader` when `insideAriaTable` is on, so the column is announced by
   * name instead of as a blank header. Ignored when `label` has text — an
   * `aria-label` would silently override the visible label.
   */
  ariaLabel?: string;
  /**
   * GridTable v2 per-column menu opt-ins. Each only produces a menu item when
   * the table ALSO wires the matching `actions` callback, so a column cannot
   * advertise an action the table cannot perform. All absent (the default) →
   * no menu button renders at all.
   */
  filterable?: boolean;
  groupable?: boolean;
  movable?: boolean;
};

/**
 * Column-reorder wiring (FEA-4021). When present, each data-column header
 * grows a drag handle: pointer users drag a header onto another to reorder;
 * keyboard users focus the handle and press `ArrowLeft`/`ArrowRight` to move
 * the column one slot. `onReorder` receives the full new column-id order the
 * caller persists. Absent → headers are static (byte-identical to before).
 */
export type TableGridHeaderReorder = {
  /** Current column-id order (the order the columns are rendered in). */
  columnOrder: readonly string[];
  onReorder: (nextOrder: string[]) => void;
};

/**
 * Column-resize wiring (FEA-4168). When present, each data-column header grows a
 * resize handle on its right edge: pointer users drag it to set the column's
 * width; keyboard users focus the handle and press `ArrowLeft`/`ArrowRight` to
 * shrink/grow it one step. `onResize` receives the resized column id and its new
 * pixel width (already clamped to the shared floor); the caller persists the map
 * and feeds current widths back via `getColumnWidth`. Absent → no resize handle.
 */
export type TableGridHeaderResize = {
  /**
   * The data-column ids that may be resized — a fixed trailing column (e.g. a
   * row-actions or non-resizable `extra` column absent from this list) shows no
   * handle. Mirrors `reorder.columnOrder`'s gating so a column that cannot be
   * resized never renders an operable handle whose width change is discarded.
   */
  columnIds: readonly string[];
  /** Current rendered width (px) of `columnId`, used as the drag/keyboard base. */
  getColumnWidth: (columnId: string) => number;
  onResize: (columnId: string, widthPx: number) => void;
};

// Info icon + tooltip beside a column header's label when `tooltip` is set.
// ISS-5333: `alignEnd` moves it to the label's LEFT (and swaps the margin side)
// on a right-aligned column, so the LABEL is what lands on the column's right
// rail with the values, instead of being pushed inboard by its own help icon.
function HeaderTooltip({
  label,
  text,
  alignEnd,
}: {
  label: string;
  text: string;
  alignEnd?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={`${label} help`}
          className={cn(
            // ISS-5333 (review): the full muted token, not `/60`. Composited on
            // the header surface `/60` measures 2.72:1 light (rgb(154,154,154)
            // on rgb(251,251,251)) and 3.67:1 dark — under WCAG 1.4.11's 3:1
            // floor in light for a glyph that carries meaning. At the full token
            // it is 6.66:1 light / 7.69:1 dark, clearing 1.4.3's 4.5:1 in both.
            //
            // `size-6` is the same explicit tokenized 24px hit box the column
            // menu in this header row already uses, so the header's pointer
            // controls agree instead of this one being a bare 14px target
            // (WCAG 2.5.8 Target Size (Minimum)). The reorder grip is NOT among
            // them since ISS-5812 — it takes no pointer events at all.
            "flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground",
            alignEnd ? "mr-1" : "ml-1"
          )}
          type="button"
        >
          <InfoIcon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-56">{text}</TooltipContent>
    </Tooltip>
  );
}

export type TableGridHeaderSortOption = {
  key: string;
  label: string;
};

type TableGridHeaderProps = {
  gridTemplateColumns: string;
  columns: readonly TableGridHeaderColumn[];
  sortBy: string | null;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
  leadingLabel?: string;
  leadingSortKey?: string;
  leadingSortOptions?: readonly TableGridHeaderSortOption[];
  onClearSort?: () => void;
  /**
   * Legacy select-all: drops a `Checkbox` INSIDE the lead identity cell, paired
   * with a caller whose body rows put their row checkbox in the same cell (the
   * Documents tree — `@repo/app/documents/components/table/document-row.tsx`).
   *
   * GridTable v2 adopters do NOT use this: `GridTable` never forwards it, so a
   * v2 table's only select-all is `leadingUtilityHeader` + `renderLeadingUtility`
   * (its own centered track). The two are mutually exclusive — supplying
   * `leadingUtilityHeader` suppresses this checkbox, so a header can never grow
   * two select-all controls in two different tracks.
   */
  showSelectAll?: boolean;
  allSelected?: boolean;
  someSelected?: boolean;
  onSelectAll?: (checked: boolean) => void;
  trailingCell?: ReactNode;
  className?: string;
  /** Column-reorder wiring (FEA-4021); absent → static headers. */
  reorder?: TableGridHeaderReorder;
  /** Column-resize wiring (FEA-4168); absent → no resize handles. */
  resize?: TableGridHeaderResize;
  /**
   * ARIA table semantics (ISS-4672). Set this ONLY when the header is rendered
   * inside an element carrying `role="table"` — as `GridTable` renders it. The
   * header then becomes `role="row"` and each header cell a
   * `role="columnheader"` carrying the `aria-colindex` of its grid track (plus
   * `aria-sort` when the column is sortable), which is what lets a screen reader
   * announce a body cell as "Status, Active" instead of a loose "Active".
   *
   * It is opt-in rather than always-on because a `row`/`columnheader` with no
   * `table` ancestor is itself an ARIA violation (`aria-required-parent`): a
   * caller that renders this header standalone must put `role="table"` on its
   * own wrapper — and give its body rows matching `row`/`cell` roles and
   * `aria-colindex` values — before opting in. `trailingCell` is caller-owned
   * markup, so an opting-in caller that passes one must give it
   * `role="columnheader"` and the next `aria-colindex` itself.
   *
   * ISS-4761 opted in the last production caller that was not: the Documents
   * tree (`@repo/app/documents/components/table/table-header.tsx`), which pairs
   * this header with its own row renderer (`document-row.tsx`). Every dense
   * table now declares the same semantics.
   */
  insideAriaTable?: boolean;
  /**
   * GridTable v2 — per-column menu actions. Absent → no column menu button
   * renders anywhere, byte-identical to before.
   */
  actions?: TableGridHeaderActions;
  /**
   * GridTable v2 — header content for a caller's leading UTILITY track (the
   * checkbox/grip column rendered BEFORE the identity column). Present → this
   * header claims the first grid track and the identity header moves to the
   * second, mirroring how `GridTable` numbers its body cells.
   */
  leadingUtilityHeader?: ReactNode;
  /**
   * GridTable v2 header PRESENTATION (ISS-4779 closed-by-default). Absent or
   * `false` → this header renders exactly as it did before v2: the sort caret is
   * always visible, the resize handle keeps its pre-v2 reveal and visible bar,
   * and a column drag shows no fade or insertion rule.
   *
   * It is an opt-in prop rather than something the header derives, because the
   * `grid-table-v2` flag lives at the consuming surface and this component is
   * rendered by Sessions, Branches, Agents, Routines, Packs, Documents and
   * Compliance on both web and desktop. Without the gate, one flagged surface
   * would restyle every other table's header the moment it merged.
   */
  enhancedHeaderInteractions?: boolean;
};

export function TableGridHeader({
  gridTemplateColumns,
  columns,
  sortBy,
  sortDir,
  onSort,
  leadingLabel = "Name",
  leadingSortKey,
  leadingSortOptions,
  onClearSort,
  showSelectAll,
  allSelected,
  someSelected,
  onSelectAll,
  trailingCell,
  className,
  reorder,
  resize,
  insideAriaTable = false,
  actions,
  leadingUtilityHeader,
  enhancedHeaderInteractions = false,
}: TableGridHeaderProps) {
  // ISS-4672: the header's `aria-colindex` values start from the same shared
  // base the body rows use, so the header/body pairing can never number the
  // grid's tracks from different starts. A leading utility track shifts BOTH
  // sides by one — `GridTable` derives its body indexes the same way.
  const leadColumnIndex =
    leadingUtilityHeader == null ? FIRST_COLUMN_INDEX : FIRST_COLUMN_INDEX + 1;
  return (
    <div
      className={cn(
        "sticky top-0 z-10 grid h-10 min-w-fit border-b bg-[var(--grid-table-surface,var(--background))]",
        className
      )}
      role={insideAriaTable ? "row" : undefined}
      style={{ gridTemplateColumns }}
    >
      {leadingUtilityHeader == null ? null : (
        <div
          aria-colindex={insideAriaTable ? FIRST_COLUMN_INDEX : undefined}
          className="flex min-w-0 items-center justify-center py-2"
          role={insideAriaTable ? "columnheader" : undefined}
        >
          {leadingUtilityHeader}
        </div>
      )}
      <div
        aria-colindex={insideAriaTable ? leadColumnIndex : undefined}
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
          "flex min-w-0 items-center py-2 pr-3 pl-4",
          // The lead column's caret follows the SAME reveal rule as the data
          // columns under v2, so reading across the row cannot suggest that only
          // the first column sorts. That needs the hover scope here too.
          enhancedHeaderInteractions && "group/header"
        )}
        role={insideAriaTable ? "columnheader" : undefined}
      >
        {showSelectAll && leadingUtilityHeader == null ? (
          <Checkbox
            checked={getSelectAllState(allSelected, someSelected)}
            className="mr-2"
            onCheckedChange={(checked) => onSelectAll?.(checked === true)}
          />
        ) : null}
        <LeadingHeaderControl
          enhancedHeaderInteractions={enhancedHeaderInteractions}
          label={leadingLabel}
          onClearSort={onClearSort}
          onSort={onSort}
          sortBy={sortBy}
          sortDir={sortDir}
          sortKey={leadingSortKey}
          sortOptions={leadingSortOptions}
        />
      </div>

      {columns.map((column, index) => (
        <ColumnHeaderCell
          actions={actions}
          colIndex={
            insideAriaTable
              ? getDataColumnIndex(leadColumnIndex, index)
              : undefined
          }
          column={column}
          key={column.id}
          enhancedHeaderInteractions={enhancedHeaderInteractions}
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
  enhancedHeaderInteractions = false,
}: {
  label: string;
  sortKey?: string;
  sortOptions?: readonly TableGridHeaderSortOption[];
  sortBy: string | null;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
  onClearSort?: () => void;
  /** See `TableGridHeaderProps.enhancedHeaderInteractions`. */
  enhancedHeaderInteractions?: boolean;
}) {
  if (sortOptions?.length) {
    const isActive = sortOptions.some((option) => option.key === sortBy);

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="group/sortbtn flex items-center gap-1 hover:text-foreground"
            type="button"
          >
            <span className="font-medium text-muted-foreground text-xs">
              {label}
            </span>
            <SortIndicator
              className={buildSortIndicatorClass(
                enhancedHeaderInteractions,
                isActive
              )}
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
              <span className="flex-1 text-sm">{option.label}</span>
              <SortIndicator
                className="h-3 w-3"
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
        className="group/sortbtn flex items-center gap-1 hover:text-foreground"
        onClick={() => onSort(sortKey, getNextSortDirection(sortBy === sortKey, sortDir))}
        type="button"
      >
        <span className="font-medium text-muted-foreground text-xs">
          {label}
        </span>
        <SortIndicator
          className={buildSortIndicatorClass(
            enhancedHeaderInteractions,
            sortBy === sortKey
          )}
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
 * optional tooltip, and — when `reorder` is wired — a drag handle that supports
 * both pointer drag-and-drop and keyboard reorder. Extracted from the header's
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
  colIndex,
  actions,
  enhancedHeaderInteractions = false,
}: {
  column: TableGridHeaderColumn;
  sortBy: string | null;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
  reorder?: TableGridHeaderReorder;
  resize?: TableGridHeaderResize;
  /**
   * 1-based grid-track index of this header (ISS-4672), set only when the
   * header row is inside a `role="table"`. Defined → the cell becomes a
   * `columnheader` announced with that `aria-colindex`; undefined → no roles, so
   * a header rendered outside a table never emits an orphan `columnheader`.
   */
  colIndex?: number;
  actions?: TableGridHeaderActions;
  /** See `TableGridHeaderProps.enhancedHeaderInteractions`. */
  enhancedHeaderInteractions?: boolean;
}) {
  // GridTable v2 drag feedback (interaction criterion 6): the dragged header
  // fades and the header it is over shows an insertion rule, so a pointer drag
  // reads as "this column, going here" instead of an unchanged header row.
  const [isDragging, setIsDragging] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const label = (
    <span className="truncate font-medium text-muted-foreground text-xs">
      {column.label}
    </span>
  );
  // Only columns the caller lists in `columnOrder` get a drag handle + drop
  // target; a fixed trailing column (e.g. a row-actions column absent from the
  // order) stays pinned and shows no handle.
  const canReorder =
    reorder != null && reorder.columnOrder.includes(column.id);
  // Resize is opt-in per table (FEA-4168) and gated to the caller's declared
  // `columnIds`, mirroring `reorder`. A fixed trailing column (row-actions /
  // non-resizable `extra`) absent from that list shows NO handle, so we never
  // render an operable control whose emitted width `setColumnWidth` discards. A
  // table that never wires `resize` is byte-identical to before.
  const canResize = resize != null && resize.columnIds.includes(column.id);
  // A menu button only renders when the table wired `actions` AND this column
  // opted into at least one of them — never an affordance that opens empty.
  const hasMenu = hasColumnMenuItems({
    actions,
    filterable: column.filterable,
    groupable: column.groupable,
    movable: column.movable,
  });
  // ISS-5333: ONE derived flag feeding the cell and the sort button, so the two
  // can never be aligned differently — which is exactly the bug this replaces,
  // where `justify-end` reached the cell and the `flex-1` button swallowed it.
  const alignHeaderEnd = column.headerAlign === TableGridHeaderAlign.End;
  // ISS-5333: on a right-aligned column the caret and the help icon LEAD the
  // label instead of trailing it. Trailing them right-aligns the CARET and the
  // ICON while leaving the label itself inset from the column's right rail —
  // measured at 16px on a sortable count column and 34px on Metric, so four
  // adjacent right-aligned columns showed three different label insets. Leading
  // them puts the LABEL on the same x as the digits underneath, which is the
  // whole point, and DOM order still matches visual order for focus (WCAG 2.4.3).
  const sortIndicator = (
    <SortIndicator
      className={buildSortIndicatorClass(
        enhancedHeaderInteractions,
        sortBy === column.id
      )}
      direction={sortDir}
      isActive={sortBy === column.id}
    />
  );
  const headerTooltip = column.tooltip ? (
    <HeaderTooltip
      alignEnd={alignHeaderEnd}
      label={column.label}
      text={column.tooltip}
    />
  ) : null;
  return (
    <div
      aria-colindex={colIndex}
      // Gated on `colIndex` because `aria-label` is prohibited on a role-less
      // element: it may only be set once this cell is a real `columnheader`.
      aria-label={colIndex == null ? undefined : getHeaderAriaLabel(column)}
      // Only a sortable header may announce a sort state: `aria-sort="none"` on
      // a static column would advertise a sort control the user cannot operate.
      aria-sort={
        colIndex != null && column.sortable
          ? getAriaSort(sortBy === column.id, sortDir)
          : undefined
      }
      className={cn(
        // `group/header` scopes the grip's hover-reveal to THIS cell. `relative`
        // anchors the absolutely-positioned grip and the right-edge resize
        // handle.
        //
        // ISS-5812: EVERY cell keeps the same `pl-3`, reorderable or not. A
        // reorderable column reserves no lane, because the pointer target for
        // reorder is this cell (`draggable` below), not a 24px box that needed
        // somewhere to live. ISS-5356 bought that box a 36px `pl-9` lane here
        // AND on every data cell of the column, which — since a product reorders
        // essentially all its columns — indented every cell of every grid by
        // 24px for a control only the header row has. See `ColumnDragHandle`.
        "relative flex h-10 min-w-0 items-center border-l py-2 pr-3 pl-3",
        // The header is draggable across its whole area, but this cursor is
        // only SEEN on the parts of it no child control covers — the left pad
        // and whatever the sort button and menu chevron do not span, since
        // `globals.css` gives every enabled button `cursor-pointer`. So this is
        // an honest hint on the cell's own surface, not a claim that the entire
        // header advertises itself as grabbable. Press-and-move anywhere in the
        // header still starts the drag; press-and-release still sorts, because
        // a click only fires when no drag began.
        canReorder && "cursor-grab active:cursor-grabbing",
        // ISS-5333: the non-sortable arm of the alignment. A bare-span label has
        // nothing between it and the cell, so the cell's own `justify-end` is
        // what moves it; the sortable arm is on the button below.
        alignHeaderEnd && "justify-end",
        // GridTable v2: `group/header` also scopes the column-menu trigger's and
        // the sort caret's hover reveal, so it is needed whenever a menu can
        // render OR the caret is hover-revealed — not only for the reorder/resize
        // grips. Without the sortable arm, a table with four sortable columns and
        // no reorder/resize/menu (Packs admin) would render carets that are
        // `opacity-0` with nothing on the page able to reveal them.
        // `transition-colors duration-100` is what makes the header's hover
        // settle instead of snap; it is part of the v2 presentation, so it is
        // gated with the rest of it.
        enhancedHeaderInteractions && "transition-colors duration-100",
        (canReorder ||
          canResize ||
          hasMenu ||
          (enhancedHeaderInteractions && column.sortable === true)) &&
          "group/header",
        hasMenu && "hover:bg-muted/40",
        // Criterion 6: the column being dragged fades rather than disappearing,
        // so its origin stays legible while it moves.
        isDragging && enhancedHeaderInteractions && "opacity-45",
        // The insertion rule on the header the drag is currently over.
        isDropTarget &&
          enhancedHeaderInteractions &&
          "before:absolute before:top-1 before:bottom-1 before:-left-px before:w-0.5 before:rounded-full before:bg-primary",
        column.className
      )}
      data-column-id={column.id}
      onDragEnd={
        canReorder
          ? () => {
              setIsDragging(false);
              setIsDropTarget(false);
            }
          : undefined
      }
      onDragEnter={
        canReorder
          ? (event) => {
              // Never advertise a drop on the column being dragged: the browser
              // fires `dragenter` on the source right after `dragstart`, so
              // without this the dragged header paints its own insertion rule
              // for a drop `handleColumnDrop` then correctly no-ops. ISS-5812
              // made this the normal case rather than an edge case, because the
              // whole cell — not a 24px grip — is now the drag source.
              if (!isDragging && isColumnDragEvent(event)) {
                setIsDropTarget(true);
              }
            }
          : undefined
      }
      onDragLeave={
        canReorder
          ? (event) => {
              // Ignore the leave events fired as the pointer crosses this
              // cell's own children, or the rule flickers on every child edge.
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
      // ISS-5812: the header cell IS the reorder drag target. Its hit area is
      // the whole column header, which is strictly larger than the 24px box
      // ISS-5356 reserved a lane to hold — the hit-target fix is kept, the lane
      // it was paid for is not. Grabbing the resize strip still resizes rather
      // than starting a column drag, because `handleResizePointerDown` calls
      // `preventDefault()` on pointerdown; the strip's `draggable={false}` does
      // NOT do that on its own (the drag model walks up to this cell).
      draggable={canReorder}
      onDragOver={canReorder ? (event) => event.preventDefault() : undefined}
      onDragStart={
        canReorder
          ? (event) => {
              // Only enter the dragging state when a payload was actually
              // written; a dragstart with no `dataTransfer` would otherwise
              // leave the header faded for a drag that can never drop.
              if (startColumnDrag(event, column.id)) {
                setIsDragging(true);
              }
            }
          : undefined
      }
      onDrop={
        canReorder
          ? (event) => {
              setIsDropTarget(false);
              handleColumnDrop(event, reorder, column.id);
            }
          : undefined
      }
      role={colIndex == null ? undefined : "columnheader"}
    >
      {canReorder ? (
        <ColumnDragHandle
          columnId={column.id}
          label={column.label}
          reorder={reorder}
        />
      ) : null}
      {canResize ? (
        <ColumnResizeHandle
          columnId={column.id}
          enhancedHeaderInteractions={enhancedHeaderInteractions}
          label={column.label}
          resize={resize}
        />
      ) : null}
      {alignHeaderEnd ? headerTooltip : null}
      {column.sortable ? (
        <button
          className={cn(
            "group/sortbtn flex min-w-0 items-center gap-1 overflow-hidden hover:text-foreground",
            // ISS-5333, the sortable arm. A left-aligned header keeps `flex-1`:
            // the button is the full-cell click target, and with nothing to its
            // right that costs nothing.
            //
            // A right-aligned one must NOT grow. `flex-1` is precisely what made
            // the cell's `justify-end` inert (the bug), and re-aligning inside a
            // still-growing button only moves the problem: the button's content
            // goes right while the help icon — a nested button cannot live inside
            // this one, so it is a sibling — stays pinned at the cell's left edge,
            // orphaned from the label by the button's whole width. Sized to its
            // content instead, the cell's own `justify-end` packs icon, caret and
            // label together against the right rail, which is also exactly how
            // the non-sortable arm (a bare span) already behaves.
            alignHeaderEnd ? "shrink" : "flex-1"
          )}
          onClick={() =>
            onSort(column.id, getNextSortDirection(sortBy === column.id, sortDir))
          }
          type="button"
        >
          {alignHeaderEnd ? sortIndicator : null}
          {label}
          {alignHeaderEnd ? null : sortIndicator}
        </button>
      ) : (
        label
      )}
      {alignHeaderEnd ? null : headerTooltip}
      {hasMenu && actions ? (
        <ColumnOptionsMenu
          actions={actions}
          columnId={column.id}
          filterable={column.filterable}
          groupable={column.groupable}
          label={column.label || (column.ariaLabel ?? column.id)}
          movable={column.movable}
          onSort={onSort}
          sortable={column.sortable}
          sortDir={sortDir}
        />
      ) : null}
    </div>
  );
}

/**
 * `aria-sort` for the leading header cell (ISS-4672). The lead column sorts one
 * of two ways — a single `sortKey`, or whichever of `sortOptions` the dropdown
 * variant has active — and both must resolve to the same announced state, so
 * `LeadingHeaderControl`'s two branches cannot drift from what the header cell
 * reports. Returns `undefined` when the lead column is not sortable at all: a
 * plain label must not advertise a sort control that does not exist.
 */
/**
 * Accessible name for a data-column header (ISS-4672). A column that renders no
 * visible label — the row-actions / chrome column every dense table ends with —
 * would otherwise become a nameless `columnheader` that each body cell in its
 * track is announced against, so `ariaLabel` names it. A column WITH a visible
 * label returns `undefined`: its text is already the accessible name, and an
 * `aria-label` there would silently override what the user can see.
 */
function getHeaderAriaLabel(column: TableGridHeaderColumn): string | undefined {
  if (column.label) {
    return undefined;
  }
  return column.ariaLabel;
}

function getLeadingAriaSort(
  sortBy: string | null,
  sortDir: SortDirection,
  sortKey?: string,
  sortOptions?: readonly TableGridHeaderSortOption[]
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

/**
 * The sort caret's class list, shared by the lead column and the data columns so
 * one header row cannot show two different rules (which read as "only the first
 * column sorts").
 *
 * Pre-v2 (`enhanced === false`) the caret is always visible — byte-identical to
 * what every table renders today.
 *
 * Under v2 (FEA-4216) the caret on a column that is NOT the active sort is
 * hover/focus-revealed, so the resting header reads as labels rather than a row
 * of carets; the ACTIVE sort's caret stays visible unconditionally, because it is
 * state, not an affordance. The reveal has a KEYBOARD twin scoped to the sort
 * button (`group-focus-visible/sortbtn`) so the caret is not mouse-only
 * (WCAG 2.4.7 Focus Visible).
 */
function buildSortIndicatorClass(enhanced: boolean, isActive: boolean): string {
  return cn(
    "size-3 shrink-0",
    enhanced &&
      !isActive &&
      "opacity-0 transition-opacity duration-100 group-hover/header:opacity-60 group-focus-visible/sortbtn:opacity-60"
  );
}
