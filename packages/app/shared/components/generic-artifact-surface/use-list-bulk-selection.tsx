"use client";

import { TableSelectionAnnouncer } from "@repo/design-system/components/ui/table-bulk-action-bar";
import type { TableBulkActionDescriptor } from "@repo/design-system/components/ui/table-bulk-actions";
import {
  type GridRowSelectionController,
  useGridRowSelection,
} from "@repo/design-system/hooks/use-grid-row-selection";
import type { CountNoun } from "@repo/design-system/lib/count-noun";
import { formatGridCardSelectionLabel } from "@repo/design-system/lib/grid-table-aria";
import { gridTableV2SelectionProps } from "@repo/design-system/lib/grid-table-v2-selection";
import { type ReactNode, useMemo, useState } from "react";
import type { ProductGridTableV2SelectionProps } from "../product-grid-table-v2";
import { ArtifactBulkActionBar } from "./bulk-action-bar";

/**
 * The one selection owner every bulk-acting list composes (ISS-12305). A list
 * hands over its page rows, its noun and its actions, and gets back the grid's
 * selection props plus the band `GridTableListSurface` renders in its
 * `bulkActions` slot: the selected-count announcer and the rail. Selection
 * state, the two-row rail threshold and the announcer's placement live here
 * once, so a second list cannot wire them differently.
 *
 * `enabled` is the HOST's capability to act on a selection. It must never be
 * derived from the rows a page happens to hold, or the selection model appears
 * and disappears as the reader pages.
 */
export function useListBulkSelection<Row extends { id: string }>({
  actions,
  controller,
  enabled,
  getRowLabel,
  noun,
  reconcileVisibleRows = true,
  rows,
}: {
  /** The rail's operations, or a builder for actions that read the selected rows. */
  actions:
    | readonly TableBulkActionDescriptor[]
    | ((selectedRows: readonly Row[]) => readonly TableBulkActionDescriptor[]);
  /** A host-owned selection; absent, the list owns it for the mount. */
  controller?: GridRowSelectionController;
  enabled: boolean;
  /** Accessible row name retained for the default-off card compatibility path. */
  getRowLabel: (row: Row) => string;
  noun: CountNoun;
  /** True only while no mounted grid can report its post-collapse row set. */
  reconcileVisibleRows?: boolean;
  /** The page's rows in the host's order, rows hidden by group collapse included. */
  rows: readonly Row[];
}): ListBulkSelection<Row> {
  const visibleRowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const selection = useGridRowSelection<Row>({
    controller,
    reconcileVisibleRows,
    visibleRowIds,
  });
  const [renderedRowIds, setRenderedRowIds] = useState<{
    pageIds: readonly string[];
    ids: readonly string[];
  } | null>(null);
  const currentRenderedIds =
    renderedRowIds && sameRowIds(renderedRowIds.pageIds, visibleRowIds)
      ? renderedRowIds.ids
      : visibleRowIds;
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const renderedRows = currentRenderedIds
    .map((id) => rowsById.get(id))
    .filter((row): row is Row => row !== undefined);
  if (!enabled) {
    return { gridSelection: undefined, selectionBand: null, selectedRows: [] };
  }
  const { selectedIds } = selection;
  const selectedRows = renderedRows.filter((row) => selectedIds.has(row.id));
  const resolvedActions =
    typeof actions === "function" ? actions(selectedRows) : actions;
  return {
    gridSelection: {
      ...gridTableV2SelectionProps<Row>({
        isRowSelected: (row) => selectedIds.has(row.id),
        onRowSelection: selection.onRowSelection,
        onRowSelectionToggle: selection.toggleRowSelection,
        onRenderedItemsChange: (renderedItems) => {
          selection.reconcileSelection(renderedItems);
          const ids = renderedItems.map((row) => row.id);
          setRenderedRowIds((current) =>
            current &&
            sameRowIds(current.pageIds, visibleRowIds) &&
            sameRowIds(current.ids, ids)
              ? current
              : { pageIds: visibleRowIds, ids }
          );
        },
        onSelectAllRows: selection.selectAllRows,
      }),
      getCompatibilityCardSelectionLabel: (row, selected) =>
        formatGridCardSelectionLabel(getRowLabel(row), selected),
      // ISS-13007: header select-all is intentionally absent; Cmd/Ctrl+A is
      // `onSelectAllRows` above.
    },
    // The announcer counts `selectedRows`, the same rows the rail paints, not
    // `selectedIds`, which can hold ids this page no longer renders for the
    // frame before reconciliation drops them (ISS-9574).
    selectionBand: (
      <>
        <TableSelectionAnnouncer count={selectedRows.length} noun={noun} />
        <ArtifactBulkActionBar
          actions={resolvedActions}
          getSelectionGeneration={selection.getSelectionGeneration}
          minimumSelectedRows={LIST_BULK_RAIL_MINIMUM_ROWS}
          noun={noun}
          onClear={selection.clearSelection}
          onRetainSelection={selection.retainSelection}
          rowIds={selectedRows.map((row) => row.id)}
        />
      </>
    ),
    selectedRows,
  };
}

export type ListBulkSelection<Row> = {
  /** Spread into the list's grid; absent when the host cannot act on a selection. */
  gridSelection: ProductGridTableV2SelectionProps<Row> | undefined;
  /** For `GridTableListSurface`'s `bulkActions` slot. */
  selectionBand: ReactNode;
  selectedRows: readonly Row[];
};

/** The list rails have always appeared at two selected rows. */
const LIST_BULK_RAIL_MINIMUM_ROWS = 2;

function sameRowIds(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}
