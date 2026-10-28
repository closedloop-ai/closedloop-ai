"use client";

import {
  type GridSelectionHandlers,
  type GridWindowedRowNavigation,
  handleGridCellKeyDown,
} from "@closedloop-ai/design-system/lib/grid-cell-keyboard";
import {
  GRID_NAV_CELL_ROLE,
  GRID_NAV_TABLE_ROLE,
} from "@closedloop-ai/design-system/lib/grid-table-navigation";
import { TableCellAlignEndProvider } from "@closedloop-ai/design-system/lib/table-cell-alignment";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ComponentProps, KeyboardEvent, ReactNode } from "react";

export type TableGridHeaderV2Resize = {
  columnIds: readonly string[];
  getColumnWidth: (columnId: string) => number;
  onResize: (columnId: string, widthPx: number) => void;
};

export function GridTableV2Cell({
  cellAlignEnd = null,
  cellRole,
  children,
  className,
  colIndex,
  columnId,
  homeEndByRow = false,
  onKeyboardNavigate,
  selectionKeys,
  staticTableSemantics = false,
  windowedRows,
  ...props
}: {
  /**
   * The alignment this cell's COLUMN asked for, published to the value
   * primitive inside (ISS-9821). `null` — the default, and every cell whose
   * column declares no alignment — leaves each primitive on its own.
   */
  cellAlignEnd?: boolean | null;
  cellRole?: "cell" | "gridcell";
  children?: ReactNode;
  className?: string;
  colIndex?: number;
  columnId?: string;
  /** Makes unmodified Home/End traverse visible treegrid rows. */
  homeEndByRow?: boolean;
  onKeyboardNavigate?: (
    rowId: string,
    event: KeyboardEvent<HTMLDivElement>
  ) => void;
  /**
   * Row-selection keys for this cell, supplied by `GridTableV2` (ISS-8067).
   * Undefined for a caller rendering this outside a selectable grid, which
   * leaves `Space` and `Ctrl/Cmd+A` their native meaning rather than silently
   * swallowing them.
   */
  selectionKeys?: GridSelectionHandlers;
  /** An opt-in static table cell has no grid roving-key handler. */
  staticTableSemantics?: boolean;
  /**
   * The row population behind a body that paints only a window of it
   * (ISS-12288). Undefined for every grid that paints all of its rows, which
   * leaves the navigation keys the DOM walk alone.
   */
  windowedRows?: GridWindowedRowNavigation<KeyboardEvent<HTMLDivElement>>;
} & ComponentProps<"div">) {
  return (
    <div
      aria-colindex={colIndex}
      className={cn(
        "group/cell @container/cell flex h-full min-w-0 items-center gap-2 overflow-hidden border-l px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&>*]:min-w-0",
        className
      )}
      data-column-id={columnId}
      onKeyDown={
        staticTableSemantics
          ? undefined
          : (event) =>
              handleGridCellKeyDown(
                event,
                onKeyboardNavigate,
                selectionKeys,
                undefined,
                windowedRows,
                homeEndByRow
              )
      }
      role={cellRole}
      {...props}
    >
      <TableCellAlignEndProvider value={cellAlignEnd}>
        {children}
      </TableCellAlignEndProvider>
    </div>
  );
}

export { GRID_NAV_CELL_ROLE, GRID_NAV_TABLE_ROLE };
