"use client";

/**
 * The row-wise keyboard model a `GridTableV2` body uses once it paints only a
 * WINDOW of its rows (ISS-12288).
 *
 * Lifted out of `grid-table-v2.tsx` (marisolashgrove review) because it is one
 * concern — "move focus to a row index, painting it first if the window had
 * not" — and because that file sits over the 1,000-line ceiling, where
 * everything it keeps is debt the next change inherits.
 *
 * The population it publishes is the grid's WHOLE row sequence, chrome rows
 * included (whitlockk review). The DOM walk it replaces resolves a move against
 * every `[data-grid-row]` inside the body in document order, which is the
 * column-header row, then the data rows, then the trailing after-row slot — so
 * a model holding the data rows alone answers `Ctrl+Home` with row 0 where the
 * unwindowed grid answers with the header, and answers `Ctrl+End` with the last
 * data row where the unwindowed grid reaches the create row (ISS-8219). One
 * sequence here is what keeps the windowed and unwindowed grids answering a key
 * the same way, at both ends, rather than two edge fixes that can drift.
 */

import {
  ARIA_COLUMN_INDEX_ATTRIBUTE,
  GRID_CELL_SELECTOR,
  GRID_ROW_SELECTOR,
} from "@closedloop-ai/design-system/lib/grid-table-navigation";
import type {
  GridWindowedRowDestination,
  GridWindowedRowNavigation,
} from "@closedloop-ai/design-system/lib/grid-cell-keyboard";
import type { GridRowWindow } from "@closedloop-ai/design-system/lib/grid-row-window";
import type { GridRenderRow } from "@closedloop-ai/design-system/lib/grid-table-v2-tree";
import { type KeyboardEvent, useCallback, useEffect, useRef } from "react";

/** A row-wise keyboard move awaiting the commit that paints its destination. */
type PendingGridRowFocus = Pick<
  GridWindowedRowDestination,
  "columnIndex" | "rowEdge"
> & {
  rowId: string;
  /**
   * Whether landing here may stand in for a click. Only a DATA row's does: the
   * "selection follows focus" fallback reaches the row's own `onClick`, and a
   * chrome row's cell is a sort control or a create affordance, not a selection.
   */
  selectsOnLanding: boolean;
};

export function useGridWindowedRowNavigation<T>({
  attachRowsAnchor,
  enabled,
  leadingChromeRowIds,
  onRowKeyboardNavigate,
  renderedItems,
  rows,
  rowWindow,
  scrollRowIntoView,
  trailingChromeRowIds,
}: {
  attachRowsAnchor: (node: HTMLElement | null) => void;
  enabled: boolean;
  /** Chrome rows painted BEFORE the data rows — the column header. */
  leadingChromeRowIds: readonly string[];
  onRowKeyboardNavigate?: (
    item: T,
    event: KeyboardEvent<HTMLDivElement>,
    renderedItems: readonly T[]
  ) => void;
  renderedItems: readonly T[];
  /** The data rows, painted or not. */
  rows: readonly GridRenderRow<T>[];
  rowWindow: GridRowWindow;
  scrollRowIntoView: (index: number) => void;
  /** Chrome rows painted AFTER the data rows — the `renderAfterRows` slot. */
  trailingChromeRowIds: readonly string[];
}): {
  attachRowsSpacer: (node: HTMLDivElement | null) => void;
  windowedRows:
    | GridWindowedRowNavigation<KeyboardEvent<HTMLDivElement>>
    | undefined;
} {
  const pendingRowFocus = useRef<PendingGridRowFocus | null>(null);
  const rowsParent = useRef<HTMLElement | null>(null);
  // STABLE, and that is load-bearing rather than tidy: React detaches and
  // reattaches an inline ref callback on every render, so an inline one here
  // reported the anchor as replaced each time and drove the measurement effect
  // into a render loop.
  const attachRowsSpacer = useCallback(
    (node: HTMLDivElement | null) => {
      rowsParent.current = node?.parentElement ?? null;
      attachRowsAnchor(node);
    },
    [attachRowsAnchor]
  );
  const focusPendingRow = () => {
    const pending = pendingRowFocus.current;
    // Whatever holds the anchor holds every row of the body: they are siblings.
    const body = rowsParent.current;
    if (!(pending && body)) {
      return;
    }
    const row = Array.from(
      body.querySelectorAll<HTMLElement>(GRID_ROW_SELECTOR)
    ).find((candidate) => candidate.dataset.gridRowId === pending.rowId);
    if (!row) {
      return;
    }
    pendingRowFocus.current = null;
    const cell = resolveRowLandingCell(row, pending);
    cell?.focus();
    if (cell && pending.selectsOnLanding && onRowKeyboardNavigate === undefined) {
      // The prototype's "selection follows focus" fallback, preserved for a
      // caller that wires only `onRowClick`.
      cell.click();
    }
  };
  // A window change is the commit that can first paint a row the keyboard asked
  // for. One commit to land it, then the request is stale: a pending focus kept
  // past that would steal focus on the reader's next unrelated scroll.
  useEffect(() => {
    focusPendingRow();
    pendingRowFocus.current = null;
  }, [rowWindow]);
  if (!enabled) {
    return { attachRowsSpacer, windowedRows: undefined };
  }
  const leadCount = leadingChromeRowIds.length;
  const focusRow = (
    destination: GridWindowedRowDestination,
    event: KeyboardEvent<HTMLDivElement>
  ) => {
    const dataIndex = destination.index - leadCount;
    const row = rows[dataIndex];
    const rowId = row
      ? row.rowId
      : resolveChromeRowId(
          destination.index,
          leadingChromeRowIds,
          trailingChromeRowIds,
          rows.length
        );
    if (rowId === undefined) {
      return;
    }
    pendingRowFocus.current = {
      columnIndex: destination.columnIndex,
      rowEdge: destination.rowEdge,
      rowId,
      selectsOnLanding: row !== undefined,
    };
    if (row) {
      scrollRowIntoView(dataIndex);
    }
    // The destination is often already painted — a step off the VISIBLE edge
    // lands in the overscan band, and a chrome row is always painted — and then
    // no window change follows for the effect above to run on.
    focusPendingRow();
    if (row) {
      onRowKeyboardNavigate?.(row.item, event, renderedItems);
    }
  };
  return {
    attachRowsSpacer,
    windowedRows: {
      focusRow,
      indexOfRow: (rowId: string) =>
        resolveRowIndex(
          rowId,
          leadingChromeRowIds,
          rows,
          trailingChromeRowIds
        ),
      rowCount: leadCount + rows.length + trailingChromeRowIds.length,
    },
  };
}

/**
 * A row id's index in the grid's whole row sequence, or `-1` for a row the
 * sequence does not hold.
 *
 * The three segments are searched in the order they paint, so the index this
 * returns and the index {@link useGridWindowedRowNavigation}'s `focusRow`
 * resolves back to a row are the same arithmetic read in both directions.
 */
function resolveRowIndex<T>(
  rowId: string,
  leadingChromeRowIds: readonly string[],
  rows: readonly GridRenderRow<T>[],
  trailingChromeRowIds: readonly string[]
): number {
  const leading = leadingChromeRowIds.indexOf(rowId);
  if (leading !== -1) {
    return leading;
  }
  const dataIndex = rows.findIndex((row) => row.rowId === rowId);
  if (dataIndex !== -1) {
    return leadingChromeRowIds.length + dataIndex;
  }
  const trailing = trailingChromeRowIds.indexOf(rowId);
  return trailing === -1
    ? -1
    : leadingChromeRowIds.length + rows.length + trailing;
}

/** The chrome row at a sequence index, for an index no data row answers to. */
function resolveChromeRowId(
  index: number,
  leadingChromeRowIds: readonly string[],
  trailingChromeRowIds: readonly string[],
  rowCount: number
): string | undefined {
  if (index < leadingChromeRowIds.length) {
    return leadingChromeRowIds[index];
  }
  return trailingChromeRowIds[index - leadingChromeRowIds.length - rowCount];
}

/**
 * The cell a row-wise move lands on inside its destination row, by the same two
 * rules `resolveNextGridCell` applies: a grid extreme lands on the row's first
 * or last cell, every other move keeps the LOGICAL column it started in.
 *
 * Falling back to the first cell rather than to `null` keeps the move inside the
 * grid: a destination row that paints no counterpart for the column — an
 * after-row carrying only its affordance — would otherwise strand focus.
 */
function resolveRowLandingCell(
  row: HTMLElement,
  pending: PendingGridRowFocus
): HTMLElement | null {
  const cells = Array.from(
    row.querySelectorAll<HTMLElement>(GRID_CELL_SELECTOR)
  );
  if (pending.rowEdge !== null) {
    return (pending.rowEdge === "start" ? cells.at(0) : cells.at(-1)) ?? null;
  }
  const sameColumn =
    pending.columnIndex === null
      ? undefined
      : cells.find(
          (cell) =>
            cell.getAttribute(ARIA_COLUMN_INDEX_ATTRIBUTE) ===
            pending.columnIndex
        );
  return sameColumn ?? cells.at(0) ?? null;
}
