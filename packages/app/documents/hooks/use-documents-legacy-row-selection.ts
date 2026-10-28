"use client";

import { useGridRowSelection } from "@repo/design-system/hooks/use-grid-row-selection";
import type { GridSelectionModifiers } from "@repo/design-system/lib/grid-table-v2-selection";
import { useCallback, useMemo } from "react";

/**
 * Row selection for the DocumentsView table path that does not render
 * `GridTableV2` (ungrouped, wide, legacy hierarchy). It routes every checkbox
 * activation through the shared `useGridRowSelection` (PRD-718 AC4), so a
 * Shift range and a Cmd/Ctrl toggle mean what they mean on every other grid.
 * Pruning stays with the view, which already reconciles this path.
 */
export function useDocumentsLegacyRowSelection({
  paintedRowIds,
  replaceSelection,
  selectedIds,
}: {
  /** Selectable rows in painted order; a Shift range spans this order. */
  paintedRowIds: readonly string[];
  replaceSelection: (ids: Set<string>) => void;
  selectedIds: ReadonlySet<string>;
}) {
  const controller = useMemo(
    () => ({
      onChange: (next: ReadonlySet<string>) => replaceSelection(new Set(next)),
      selectedIds,
    }),
    [replaceSelection, selectedIds]
  );
  const selection = useGridRowSelection({
    controller,
    reconcileVisibleRows: false,
    visibleRowIds: paintedRowIds,
  });
  const { onRowSelection, toggleRowSelection } = selection;

  return useCallback<DocumentRowSelectionChange>(
    (id, checked, modifiers) =>
      routeRowSelectionChange({
        checked,
        isSelected: selectedIds.has(id),
        modifiers,
        onRowSelection,
        row: { id },
        toggleRowSelection,
      }),
    [onRowSelection, selectedIds, toggleRowSelection]
  );
}

/** A row checkbox activation, carrying the click's modifier chord when known. */
export type DocumentRowSelectionChange = (
  id: string,
  checked: boolean,
  modifiers?: GridSelectionModifiers
) => void;

/**
 * One checkbox activation through the shared selection model: a Shift or
 * Cmd/Ctrl chord resolves like a row click, a bare activation toggles like
 * Space. `renderedRows`, when given, is the painted order a range spans.
 */
export function routeRowSelectionChange<Row extends { id: string }>({
  checked,
  isSelected,
  modifiers,
  onRowSelection,
  renderedRows,
  row,
  toggleRowSelection,
}: {
  checked: boolean;
  isSelected: boolean;
  modifiers: GridSelectionModifiers | undefined;
  onRowSelection: (
    row: Row,
    modifiers: GridSelectionModifiers,
    renderedRows?: readonly Row[]
  ) => void;
  renderedRows?: readonly Row[];
  row: Row;
  toggleRowSelection: (row: Row) => void;
}): void {
  if (modifiers?.shiftKey || modifiers?.ctrlKey || modifiers?.metaKey) {
    onRowSelection(row, modifiers, renderedRows);
    return;
  }
  if (checked !== isSelected) {
    toggleRowSelection(row);
  }
}
