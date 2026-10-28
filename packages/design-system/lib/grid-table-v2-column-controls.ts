import type {
  TableGridHeaderV2Reorder,
  TableGridHeaderV2Resize,
} from "@closedloop-ai/design-system/components/ui/table-grid-header-v2";
import {
  MIN_COLUMN_WIDTH_PX,
  orderColumns,
} from "@closedloop-ai/design-system/lib/column-order";
import type { GridTableV2Column } from "@closedloop-ai/design-system/lib/grid-table-v2-types";

type ColumnControlsInput = {
  columnOrder?: readonly string[];
  columnWidths?: Readonly<Record<string, number>>;
  columns: readonly GridTableV2Column[];
  movableColumnIds?: readonly string[];
  onColumnOrderChange?: (columnOrder: string[]) => void;
  onColumnWidthChange?: (columnId: string, width: number) => void;
  resizableColumnIds?: readonly string[];
};

type ColumnControls = {
  orderedColumns: readonly GridTableV2Column[];
  reorder?: TableGridHeaderV2Reorder;
  resize?: TableGridHeaderV2Resize;
};

/** Resolve rendered columns and their optional reorder and resize controls. */
export function resolveGridTableV2ColumnControls({
  columnOrder,
  columnWidths,
  columns,
  movableColumnIds,
  onColumnOrderChange,
  onColumnWidthChange,
  resizableColumnIds,
}: ColumnControlsInput): ColumnControls {
  const orderedColumns = orderColumns(columns, columnOrder);
  const reorder = onColumnOrderChange
    ? {
        columnOrder:
          columnOrder && columnOrder.length > 0
            ? columnOrder
            : orderedColumns.map((column) => column.id),
        movableColumnIds,
        onReorder: onColumnOrderChange,
      }
    : undefined;

  const resize = onColumnWidthChange
    ? {
        columnIds:
          resizableColumnIds === undefined
            ? Object.keys(columnWidths ?? {})
            : resizableColumnIds.filter((id) => columnWidths?.[id] != null),
        getColumnWidth: (columnId: string) =>
          columnWidths?.[columnId] ?? MIN_COLUMN_WIDTH_PX,
        onResize: onColumnWidthChange,
      }
    : undefined;
  return { orderedColumns, reorder, resize };
}
