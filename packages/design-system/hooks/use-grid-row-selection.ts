"use client";

import {
  reconcileGridRowSelection,
  resolveGridRowSelection,
  selectAllGridRows,
  toggleGridRowSelection,
} from "@closedloop-ai/design-system/lib/grid-table-v2-selection";
import { useIsomorphicLayoutEffect } from "@closedloop-ai/design-system/hooks/use-isomorphic-layout-effect";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useRef,
  useState,
} from "react";

/** An optional host-owned selection; otherwise the list owns it for the mount. */
export type GridRowSelectionController = {
  selectedIds: ReadonlySet<string>;
  onChange: (selectedIds: ReadonlySet<string>) => void;
};

/** Pointer, keyboard and synthetic range gestures share these modifiers. */
export type GridRowSelectionEvent = Pick<
  MouseEvent | KeyboardEvent,
  "ctrlKey" | "metaKey" | "shiftKey"
>;

/** Reconciles against the filtered page; gesture order comes from renderedRows. */
export function useGridRowSelection<Row extends { id: string }>({
  controller,
  reconcileVisibleRows = true,
  visibleRowIds,
}: {
  controller?: GridRowSelectionController;
  /** Reconcile the host row set while no mounted grid can report its own set. */
  reconcileVisibleRows?: boolean;
  /** The filtered page in host order, including rows inside an open group band. */
  visibleRowIds: readonly string[];
}) {
  const [uncontrolledIds, setUncontrolledIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const anchorId = useRef<string | null>(null);
  const selectedIds = controller?.selectedIds ?? uncontrolledIds;
  const currentSelection = useRef(selectedIds);
  currentSelection.current = selectedIds;
  const writtenSelection = useRef(selectedIds);
  const selectionGeneration = useRef(0);
  const latestReconciliationRowIds = useRef(visibleRowIds);
  const previousVisibleRowIds = useRef(visibleRowIds);
  if (!sameRowIds(previousVisibleRowIds.current, visibleRowIds)) {
    previousVisibleRowIds.current = visibleRowIds;
    latestReconciliationRowIds.current = visibleRowIds;
  }

  useIsomorphicLayoutEffect(() => {
    if (!sameSelectedIds(writtenSelection.current, selectedIds)) {
      selectionGeneration.current += 1;
      writtenSelection.current = selectedIds;
    }
  }, [selectedIds]);

  const getSelectionGeneration = useCallback(
    () => selectionGeneration.current,
    []
  );

  const writeSelection = useCallback(
    (next: ReadonlySet<string>, isCompletion = false) => {
      if (sameSelectedIds(currentSelection.current, next)) {
        return;
      }
      if (!isCompletion) {
        selectionGeneration.current += 1;
      }
      currentSelection.current = next;
      writtenSelection.current = next;
      if (controller) {
        controller.onChange(next);
      } else {
        setUncontrolledIds(next);
      }
    },
    [controller]
  );

  const reconcileSelection = useCallback(
    (rows: readonly Row[]) => {
      const rowIds = rows.map((row) => row.id);
      latestReconciliationRowIds.current = rowIds;
      const current = currentSelection.current;
      const reconciled = reconcileGridRowSelection(
        { anchorId: anchorId.current, selectedIds: current },
        rowIds
      );
      anchorId.current = reconciled.anchorId;
      if (reconciled.selectedIds !== current) {
        writeSelection(reconciled.selectedIds);
      }
    },
    [writeSelection]
  );

  useIsomorphicLayoutEffect(() => {
    if (!reconcileVisibleRows) {
      return;
    }
    const reconciled = reconcileGridRowSelection(
      { anchorId: anchorId.current, selectedIds },
      visibleRowIds
    );
    latestReconciliationRowIds.current = visibleRowIds;
    anchorId.current = reconciled.anchorId;
    if (reconciled.selectedIds !== selectedIds) {
      writeSelection(reconciled.selectedIds);
    }
  }, [reconcileVisibleRows, selectedIds, visibleRowIds, writeSelection]);

  const onRowSelection = useCallback(
    (
      row: Row,
      event: GridRowSelectionEvent,
      renderedRows?: readonly Row[]
    ) => {
      const currentAnchorId = anchorId.current;
      const rowIds = renderedRows
        ? renderedRows.map((rendered) => rendered.id)
        : visibleRowIds;
      const next = resolveGridRowSelection(
        { anchorId: currentAnchorId, selectedIds: currentSelection.current },
        row.id,
        event,
        rowIds
      );
      writeSelection(next.selectedIds);
      if (
        !event.shiftKey ||
        currentAnchorId === null ||
        !rowIds.includes(currentAnchorId)
      ) {
        anchorId.current = row.id;
      }
    },
    [visibleRowIds, writeSelection]
  );

  const clearSelection = useCallback(() => {
    anchorId.current = null;
    selectionGeneration.current += 1;
    writeSelection(new Set());
  }, [writeSelection]);

  const toggleRowSelection = useCallback(
    (row: Row) => {
      const next = toggleGridRowSelection(
        {
          anchorId: anchorId.current,
          selectedIds: currentSelection.current,
        },
        row.id
      );
      anchorId.current = next.anchorId;
      writeSelection(next.selectedIds);
    },
    [writeSelection]
  );

  const selectAllRows = useCallback(
    (renderedRows: readonly Row[]) => {
      const next = selectAllGridRows(renderedRows.map((row) => row.id));
      anchorId.current = next.anchorId;
      writeSelection(next.selectedIds);
    },
    [writeSelection]
  );

  const retainSelection = useCallback(
    (rowIds: readonly string[]) => {
      const reconciled = reconcileGridRowSelection(
        { anchorId: anchorId.current, selectedIds: new Set(rowIds) },
        latestReconciliationRowIds.current
      );
      anchorId.current = reconciled.anchorId;
      writeSelection(reconciled.selectedIds, true);
    },
    [writeSelection]
  );

  return {
    clearSelection,
    getSelectionGeneration,
    onRowSelection,
    reconcileSelection,
    retainSelection,
    selectedIds,
    selectAllRows,
    toggleRowSelection,
  } as const;
}

function sameSelectedIds(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function sameRowIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((id, index) => id === right[index])
  );
}
