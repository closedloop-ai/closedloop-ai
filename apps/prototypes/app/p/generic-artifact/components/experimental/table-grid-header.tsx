// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: Preserve the reviewed prototype interaction contract in this isolated copy.
// biome-ignore-all lint/a11y/noStaticElementInteractions: Preserve the reviewed prototype interaction contract in this isolated copy.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Preserve the reviewed prototype behavior in this isolated copy.
// biome-ignore-all lint/complexity/useOptionalChain: Preserve exact boolean values in this isolated prototype copy.
// biome-ignore-all lint/style/noNestedTernary: Preserve the reviewed prototype render branches in this isolated copy.
"use client";

// Experimental variant scoped to Generic Artifact pending explicit promotion review.

import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  getNextSortDirection,
  type SortDirection,
  SortIndicator,
} from "@repo/design-system/components/ui/sortable-column-header";
import {
  ColumnResizeDirection,
  clampColumnWidth,
  moveColumn,
  resizeColumnByDirection,
} from "@repo/design-system/lib/column-order";
import { cn } from "@repo/design-system/lib/utils";
import {
  ArrowDownIcon,
  ArrowLeftRightIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  FilterIcon,
  Rows3Icon,
} from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useState,
} from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export type TableGridHeaderColumn = {
  id: string;
  label: string;
  sortable?: boolean;
  filterable?: boolean;
  groupable?: boolean;
  className?: string;
  /** Optional help text shown via an info icon + tooltip after the label. */
  tooltip?: string;
};

/**
 * Column-reorder wiring (FEA-4021). When present, each data-column header is a
 * native drag surface; pointer users drag the label/header onto another header
 * to reorder. The column menu remains the keyboard-accessible move path.
 * `onReorder` receives the full new column-id order the caller persists.
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

export type TableGridHeaderSortOption = {
  key: string;
  label: string;
};

export type TableGridHeaderActions = {
  /**
   * Column-scoped filter controls rendered in a nested Filter submenu. This is
   * intentionally separate from the table-level filter trigger: a header menu
   * must keep the user in the column context instead of opening a second,
   * unrelated surface elsewhere on the page.
   */
  getFilterContent?: (columnId: string) => ReactNode;
  onFilter?: (columnId: string) => void;
  onGroup?: (columnId: string) => void;
  onMove?: (
    columnId: string,
    direction: "start" | "left" | "right" | "end"
  ) => void;
};

type TableGridHeaderProps = {
  gridTemplateColumns: string;
  columns: readonly TableGridHeaderColumn[];
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
  leadingSortOptions?: readonly TableGridHeaderSortOption[];
  onClearSort?: () => void;
  showSelectAll?: boolean;
  allSelected?: boolean;
  someSelected?: boolean;
  onSelectAll?: (checked: boolean) => void;
  showRankSlot?: boolean;
  /** Optional fixed utility cell before the leading identity column. */
  leadingUtilityCell?: ReactNode;
  trailingCell?: ReactNode;
  className?: string;
  /** Column-reorder wiring (FEA-4021); absent → static headers. */
  reorder?: TableGridHeaderReorder;
  /** Column-resize wiring (FEA-4168); absent → no resize handles. */
  resize?: TableGridHeaderResize;
  /** Optional Asana-style column action menus. */
  actions?: TableGridHeaderActions;
};

export function TableGridHeader({
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
  allSelected,
  someSelected,
  onSelectAll,
  showRankSlot = false,
  leadingUtilityCell,
  trailingCell,
  className,
  reorder,
  resize,
  actions,
}: TableGridHeaderProps) {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 grid h-[35px] min-w-fit border-b bg-[var(--grid-table-surface,var(--background))]",
        className
      )}
      style={{ gridTemplateColumns }}
    >
      {leadingUtilityCell ? (
        <div className="flex min-w-0 items-center">{leadingUtilityCell}</div>
      ) : showRankSlot ? (
        <div />
      ) : null}
      <div
        className="group/header relative flex min-w-0 items-center py-0 pr-2 pl-3 transition-colors hover:bg-muted/40"
        data-column-id="__leading__"
      >
        {leadingResize ? (
          <ColumnResizeHandle
            columnId="__leading__"
            label={leadingLabel}
            resize={{
              columnIds: ["__leading__"],
              getColumnWidth: () => leadingResize.width,
              onResize: (_columnId, widthPx) => leadingResize.onResize(widthPx),
            }}
          />
        ) : null}
        {showSelectAll ? (
          <Checkbox
            checked={getSelectAllState(allSelected, someSelected)}
            className="mr-2"
            onCheckedChange={(checked) => onSelectAll?.(checked === true)}
          />
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

      {columns.map((column) => (
        <ColumnHeaderCell
          actions={actions}
          column={column}
          key={column.id}
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
  sortOptions?: readonly TableGridHeaderSortOption[];
  sortBy: string | null;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
  onClearSort?: () => void;
  actions?: TableGridHeaderActions;
  tooltip?: string;
}) {
  if (sortKey && actions) {
    return (
      <HeaderActionsMenu
        actions={actions}
        columnId={sortKey}
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
            <span className="font-medium text-muted-foreground text-xs">
              {label}
            </span>
            <SortIndicator
              className="h-3 w-3"
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
}: {
  column: TableGridHeaderColumn;
  sortBy: string | null;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
  reorder?: TableGridHeaderReorder;
  resize?: TableGridHeaderResize;
  actions?: TableGridHeaderActions;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  // Only columns the caller lists in `columnOrder` get a drag handle + drop
  // target; a fixed trailing column (e.g. a row-actions column absent from the
  // order) stays pinned and shows no handle.
  const canReorder = reorder != null && reorder.columnOrder.includes(column.id);
  // Resize is opt-in per table (FEA-4168) and gated to the caller's declared
  // `columnIds`, mirroring `reorder`. A fixed trailing column (row-actions /
  // non-resizable `extra`) absent from that list shows NO handle, so we never
  // render an operable control whose emitted width `setColumnWidth` discards. A
  // table that never wires `resize` is byte-identical to before.
  const canResize = resize != null && resize.columnIds.includes(column.id);
  const moveReorderableColumn = (
    direction: "start" | "left" | "right" | "end"
  ) => {
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
            ((
              _columnId: string,
              direction: "start" | "left" | "right" | "end"
            ) => moveReorderableColumn(direction)),
        }
      : undefined;
  return (
    <div
      className={cn(
        "relative flex h-[35px] min-w-0 items-center border-l py-0 pr-2 pl-3 transition-colors hover:bg-muted/40",
        (canReorder || canResize) && "group/header",
        isDragging && "opacity-[0.45]",
        isDropTarget &&
          "shadow-[inset_2px_0_0_var(--primary)] before:absolute before:top-1 before:bottom-1 before:-left-px before:w-0.5 before:rounded-full before:bg-primary",
        column.className
      )}
      data-column-id={column.id}
      draggable={canReorder}
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
              if (event.dataTransfer.types.includes(COLUMN_DRAG_DATA_TYPE)) {
                setIsDropTarget(true);
              }
            }
          : undefined
      }
      onDragLeave={
        canReorder
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
        canReorder
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
        canReorder
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
          label={column.label}
          resize={resize}
        />
      ) : null}
      {resolvedActions &&
      (column.sortable ||
        column.filterable ||
        column.groupable ||
        canReorder) ? (
        <HeaderActionsMenu
          actions={resolvedActions}
          columnId={column.id}
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
          className="flex flex-1 items-center gap-1 overflow-hidden hover:text-foreground"
          onClick={() =>
            onSort(
              column.id,
              getNextSortDirection(sortBy === column.id, sortDir)
            )
          }
          type="button"
        >
          <HeaderLabel
            draggable={canReorder}
            label={column.label}
            tooltip={
              column.tooltip ??
              (canReorder ? "Drag to reorder column" : undefined)
            }
          />
          <SortIndicator
            className="h-3 w-3"
            direction={sortDir}
            isActive={sortBy === column.id}
          />
        </button>
      ) : (
        <HeaderLabel
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

function HeaderLabel({
  draggable,
  label,
  tooltip,
}: {
  draggable?: boolean;
  label: string;
  tooltip?: string;
}) {
  const labelNode = (
    <span
      className={cn(
        "line-clamp-2 min-w-0 flex-1 whitespace-normal font-medium text-[11px] text-muted-foreground leading-[1.25]",
        draggable && "cursor-grab active:cursor-grabbing",
        tooltip && "cursor-pointer"
      )}
    >
      {label}
    </span>
  );
  if (!tooltip) {
    return labelNode;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{labelNode}</TooltipTrigger>
      <TooltipContent className="max-w-[232px] text-left" sideOffset={8}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

function HeaderActionsMenu({
  actions,
  columnId,
  draggable,
  filterable = false,
  groupable = false,
  label,
  movable = false,
  onSort,
  sortable = true,
  sortBy,
  sortDir,
  tooltip,
}: {
  actions: TableGridHeaderActions;
  columnId: string;
  draggable?: boolean;
  filterable?: boolean;
  groupable?: boolean;
  label: string;
  movable?: boolean;
  onSort: (column: string, direction: SortDirection) => void;
  sortable?: boolean;
  sortBy: string | null;
  sortDir: SortDirection;
  tooltip?: string;
}) {
  const filterContent = actions.getFilterContent?.(columnId);
  return (
    <div className="group/menu flex min-w-0 flex-1 items-center gap-1">
      <HeaderLabel draggable={draggable} label={label} tooltip={tooltip} />
      {sortBy === columnId ? (
        <SortIndicator
          className="size-3 shrink-0"
          direction={sortDir}
          isActive
        />
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={`${label} column options`}
            className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground opacity-0 transition-[opacity,background,color] duration-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/header:opacity-100 data-[state=open]:bg-muted data-[state=open]:text-foreground data-[state=open]:opacity-100"
            data-no-column-drag
            draggable={false}
            type="button"
          >
            <ChevronDownIcon className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-[245px] rounded-lg shadow-[0_12px_32px_oklch(0.15_0_0/0.10),0_2px_6px_oklch(0.15_0_0/0.04)]"
        >
          {sortable ? (
            <>
              <DropdownMenuItem
                className="rounded-md px-3 py-[7px] text-[13px]"
                onSelect={() => onSort(columnId, "asc")}
              >
                <ArrowUpIcon />
                Sort ascending
              </DropdownMenuItem>
              <DropdownMenuItem
                className="rounded-md px-3 py-[7px] text-[13px]"
                onSelect={() => onSort(columnId, "desc")}
              >
                <ArrowDownIcon />
                Sort descending
              </DropdownMenuItem>
            </>
          ) : null}
          {filterable && filterContent ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="rounded-md px-3 py-[7px] text-[13px]">
                <FilterIcon />
                Filter
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">
                {filterContent}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : filterable && !actions.getFilterContent && actions.onFilter ? (
            <DropdownMenuItem
              className="rounded-md px-3 py-[7px] text-[13px]"
              onSelect={() => actions.onFilter?.(columnId)}
            >
              <FilterIcon />
              Filter
            </DropdownMenuItem>
          ) : null}
          {groupable ? (
            <DropdownMenuItem
              className="rounded-md px-3 py-[7px] text-[13px]"
              onSelect={() => actions.onGroup?.(columnId)}
            >
              <Rows3Icon />
              Group
            </DropdownMenuItem>
          ) : null}
          {movable ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="rounded-md px-3 py-[7px] text-[13px]">
                  <ArrowLeftRightIcon />
                  Move column
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-44">
                  <DropdownMenuItem
                    onSelect={() => actions.onMove?.(columnId, "start")}
                  >
                    Move to start
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => actions.onMove?.(columnId, "left")}
                  >
                    Move left
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => actions.onMove?.(columnId, "right")}
                  >
                    Move right
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => actions.onMove?.(columnId, "end")}
                  >
                    Move to end
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// `dataTransfer` key carrying the dragged column id across the DnD lifecycle.
const COLUMN_DRAG_DATA_TYPE = "text/x-grid-table-column";

// Read the dragged column id and move it before the drop-target column.
function handleColumnDrop(
  event: DragEvent<HTMLDivElement>,
  reorder: TableGridHeaderReorder,
  targetColumnId: string
) {
  event.preventDefault();
  const draggedId = event.dataTransfer.getData(COLUMN_DRAG_DATA_TYPE);
  if (!draggedId || draggedId === targetColumnId) {
    return;
  }
  const fromIndex = reorder.columnOrder.indexOf(draggedId);
  const toIndex = reorder.columnOrder.indexOf(targetColumnId);
  if (fromIndex === -1 || toIndex === -1) {
    return;
  }
  reorder.onReorder(moveColumn(reorder.columnOrder, fromIndex, toIndex));
}

/**
 * Keyboard-and-pointer-accessible resize handle pinned to a column header's
 * right edge (FEA-4168). Pointer: pressing captures the pointer and each move
 * sets the column width to its width-at-press plus the horizontal drag delta,
 * clamped to the shared floor. Keyboard: the handle is a focusable `button`
 * (accessible name via `aria-label`) whose `ArrowLeft`/`ArrowRight` shrink/grow
 * the column one step — the same clamp the drag uses — so a keyboard user
 * reaches every width without a pointer (WCAG 2.1.1 Keyboard). It reports the
 * final width via `resize.onResize`; the caller persists it and feeds the
 * current width back through `resize.getColumnWidth`.
 */
function ColumnResizeHandle({
  columnId,
  label,
  resize,
}: {
  columnId: string;
  label: string;
  resize: TableGridHeaderResize;
}) {
  return (
    <button
      // Operation is in the name so a screen-reader user knows the arrow keys
      // resize (WCAG 2.1.1 / 4.1.2), not just that a "Resize" control exists.
      aria-label={`Resize ${label} column, use arrow keys`}
      // Center a forgiving 12px hit target over the divider while keeping the
      // visual affordance to a single line. This matches the reference: the
      // pointer does not have to land on a one-pixel border, but the resting table
      // still reads as a clean grid.
      className={cn(
        "absolute top-0 -right-1.5 z-20 flex h-full w-3 cursor-col-resize touch-none items-center justify-center outline-none",
        "after:h-full after:w-px after:bg-primary after:opacity-0 after:transition-opacity hover:after:opacity-70 focus-visible:after:opacity-100 active:after:opacity-100"
      )}
      data-no-column-drag
      draggable={false}
      onKeyDown={(event) => handleResizeKeyDown(event, columnId, resize)}
      onPointerDown={(event) =>
        handleResizePointerDown(event, columnId, resize)
      }
      type="button"
    >
      <span className="sr-only">Resize {label} column</span>
    </button>
  );
}

// Pointer-drag resize: capture the pointer so moves keep tracking outside the
// thin handle, then set the width to width-at-press + horizontal delta (clamped).
// Live moves are coalesced to one commit per animation frame so a fast drag does
// not push a `resize.onResize` (and the caller's synchronous persistence) per
// raw pointermove; the final width is committed on pointerup/cancel. The drag is
// scoped to the initiating `pointerId` so a second concurrent touch cannot
// hijack it, and `lostpointercapture` tears the listeners down if capture is
// lost without a pointerup/pointercancel.
function handleResizePointerDown(
  event: PointerEvent<HTMLButtonElement>,
  columnId: string,
  resize: TableGridHeaderResize
) {
  // Left button only; ignore secondary/middle so a context-menu press does not
  // start a phantom resize.
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  const handle = event.currentTarget;
  const activePointerId = event.pointerId;
  const startX = event.clientX;
  const startWidth = resize.getColumnWidth(columnId);
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  handle.setPointerCapture(activePointerId);

  let frame: number | null = null;
  let pendingWidth = startWidth;

  const commit = () => {
    frame = null;
    resize.onResize(columnId, pendingWidth);
  };
  const onMove = (moveEvent: globalThis.PointerEvent) => {
    // Ignore events from any other pointer so a second touch cannot resize the
    // drag started by the first.
    if (moveEvent.pointerId !== activePointerId) {
      return;
    }
    pendingWidth = clampColumnWidth(startWidth + (moveEvent.clientX - startX));
    frame ??= globalThis.requestAnimationFrame(commit);
  };
  const teardown = () => {
    if (frame !== null) {
      globalThis.cancelAnimationFrame(frame);
      frame = null;
    }
    // Persist the final width once, even if the last move was still queued.
    resize.onResize(columnId, pendingWidth);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onEnd);
    handle.removeEventListener("pointercancel", onEnd);
    handle.removeEventListener("lostpointercapture", teardown);
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
  };
  // pointerup / pointercancel carry a pointerId, so only the initiating pointer
  // ends the drag; `lostpointercapture` always pertains to the captured pointer
  // and tears down unconditionally (the safety net if capture is lost without an
  // up/cancel).
  const onEnd = (endEvent: globalThis.PointerEvent) => {
    if (endEvent.pointerId !== activePointerId) {
      return;
    }
    teardown();
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onEnd);
  handle.addEventListener("pointercancel", onEnd);
  handle.addEventListener("lostpointercapture", teardown);
}

// Arrow-key resize for a focused resize handle. `preventDefault` stops the arrow
// key from ALSO horizontally scrolling the table's scroll container.
function handleResizeKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  columnId: string,
  resize: TableGridHeaderResize
) {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    resize.onResize(
      columnId,
      resizeColumnByDirection(
        resize.getColumnWidth(columnId),
        ColumnResizeDirection.Shrink
      )
    );
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    resize.onResize(
      columnId,
      resizeColumnByDirection(
        resize.getColumnWidth(columnId),
        ColumnResizeDirection.Grow
      )
    );
  }
}
