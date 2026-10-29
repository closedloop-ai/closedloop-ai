"use client";

import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import {
  ListAddFieldDialog,
  ListCustomFieldCell,
} from "@repo/app/custom-fields/components/list-custom-field-controls";
import type { EntityListCustomFieldsController } from "@repo/app/custom-fields/hooks/use-entity-list-custom-fields-controller";
import {
  buildListCustomFieldColumns,
  isListCustomFieldColumnId,
  type ListCustomFieldColumn,
} from "@repo/app/custom-fields/lib/list-custom-field-columns";
import {
  GRID_TABLE_V2_ADD_FIELD_TRACK,
  type GridTableV2Column,
} from "@repo/design-system/components/ui/grid-table-v2";
import type { TableToggleOption } from "@repo/design-system/components/ui/table-toolbar-model";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import type { BranchRow } from "../lib/branch-row";
import type { BranchColumnLayout } from "./branch-column-layout";

/**
 * ISS-12663 (operator ruling, Marisol Ashgrove, 2026-10-20: add org custom-field
 * columns to the Branches list now, beside PRD-601's built-in columns) — what
 * the Branches surface needs to offer custom-field columns the way the Sessions
 * list does.
 *
 * Visibility of a custom-field column is surface-local, as it is on Sessions
 * (FEA-4222): a column ships VISIBLE, the Columns menu hides it for this mount,
 * and a saved view restores how it looks (its width), never which custom fields
 * show.
 */
export type BranchesCustomFieldColumns = {
  /** The custom-field columns currently shown, in definition order. */
  columns: readonly ListCustomFieldColumn[];
  /** One Columns-menu entry per custom-field column, shown or hidden. */
  toggleOptions: readonly TableToggleOption[];
  /** The host's visible set plus every shown custom-field column. */
  visibleColumnIds: Set<string>;
  /** Hides or shows one custom-field column; ignores any other id. */
  toggleColumn: (columnId: string) => void;
  /** Present only when the controller can create a field. */
  onAddField?: () => void;
  /** A custom-field cell, or `undefined` for any other column id. */
  renderCell: (columnId: string, row: BranchRow) => ReactNode | undefined;
  addFieldDialog: ReactNode;
};

export function useBranchesCustomFieldColumns(
  controller: EntityListCustomFieldsController | undefined,
  hostVisibleColumnIds: ReadonlySet<string>
): BranchesCustomFieldColumns {
  const allColumns = useMemo(
    () => buildListCustomFieldColumns(controller?.fields ?? []),
    [controller?.fields]
  );
  const [hiddenColumnIds, setHiddenColumnIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [addFieldOpen, setAddFieldOpen] = useState(false);
  const columns = useMemo(
    () => allColumns.filter((column) => !hiddenColumnIds.has(column.id)),
    [allColumns, hiddenColumnIds]
  );
  const visibleColumnIds = useMemo(
    () =>
      new Set([...hostVisibleColumnIds, ...columns.map((column) => column.id)]),
    [columns, hostVisibleColumnIds]
  );
  const toggleColumn = useCallback((columnId: string) => {
    if (!isListCustomFieldColumnId(columnId)) {
      return;
    }
    setHiddenColumnIds((current) => {
      const next = new Set(current);
      if (next.has(columnId)) {
        next.delete(columnId);
      } else {
        next.add(columnId);
      }
      return next;
    });
  }, []);
  const columnsById = useMemo(
    () => new Map(allColumns.map((column) => [column.id, column])),
    [allColumns]
  );
  const renderCell = useCallback(
    (columnId: string, row: BranchRow): ReactNode | undefined => {
      const column = isListCustomFieldColumnId(columnId)
        ? columnsById.get(columnId)
        : undefined;
      if (!(column && controller && row.artifactId)) {
        return;
      }
      return (
        <ListCustomFieldCell
          controller={controller}
          entityId={row.artifactId}
          field={column.customField}
          itemLabel={row.branchName}
        />
      );
    },
    [columnsById, controller]
  );
  return {
    addFieldDialog: (
      <ListAddFieldDialog
        controller={controller}
        entityType={CustomFieldEntityType.Branch}
        onOpenChange={setAddFieldOpen}
        open={addFieldOpen}
      />
    ),
    columns,
    onAddField: controller?.onCreateField
      ? () => setAddFieldOpen(true)
      : undefined,
    renderCell,
    toggleColumn,
    toggleOptions: allColumns.map((column) => ({
      key: column.id,
      label: column.label,
    })),
    visibleColumnIds,
  };
}

/**
 * The grid layout with the shown custom-field columns appended after the
 * built-in ones, and the trailing Add field track when the list offers it.
 *
 * Appended AFTER the built-in layout rather than declared into it: the built-in
 * set is PRD-601's closed column registry, and a custom-field column is the
 * org's, sized and ordered by the same rules Sessions applies to its own. A
 * reorder still persists only the built-in order, as Sessions' does.
 */
export function withBranchCustomFieldColumns(
  layout: BranchColumnLayout,
  {
    columns,
    columnWidths,
    showAddField,
  }: {
    columns: readonly ListCustomFieldColumn[];
    columnWidths?: Readonly<Record<string, number>>;
    showAddField: boolean;
  }
): BranchColumnLayout {
  if (columns.length === 0 && !showAddField) {
    return layout;
  }
  const widths = { ...layout.columnWidths };
  for (const column of columns) {
    widths[column.id] = columnWidths?.[column.id] ?? column.minWidthPx;
  }
  return {
    columnOrder: [...layout.columnOrder, ...columns.map((column) => column.id)],
    columns: [
      ...layout.columns,
      ...columns.map(
        (column): GridTableV2Column => ({
          id: column.id,
          label: column.label,
          tooltip: column.tooltip,
        })
      ),
    ],
    columnWidths: widths,
    gridTemplateColumns: [
      layout.gridTemplateColumns,
      ...columns.map((column) => `${widths[column.id]}px`),
      ...(showAddField ? [GRID_TABLE_V2_ADD_FIELD_TRACK] : []),
    ].join(" "),
    toPersistedColumnOrder: (visibleOrder) =>
      layout.toPersistedColumnOrder(
        visibleOrder.filter((id) => !isListCustomFieldColumnId(id))
      ),
  };
}
