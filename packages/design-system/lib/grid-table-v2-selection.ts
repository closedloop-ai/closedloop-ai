/**
 * The ONE row-selection contract a `GridTableV2` host wires to every input path
 * (ISS-8490).
 *
 * `GridTableV2` reports a row activation four ways — `onRowClick`,
 * `onRowKeyboardNavigate`, `onRowSelectionToggle` and `onSelectAllRows` — and
 * deliberately holds no selection state of its own, so each host decides what a
 * plain activation, a `Ctrl/Cmd` one and a `Shift` one MEAN. Two hosts writing
 * that by hand is how a pointer `Shift`-click and a `Shift+ArrowDown` drift into
 * two different answers on the same grid; the demo surface had the correct copy
 * and the design-system story had a second, subtly different one that resolved
 * ranges against its own fixture array. This module is that decision, once.
 *
 * Pure data: no React, no DOM, so it is unit-testable without rendering a table,
 * and it sits beside `grid-table-v2-rows` for the same reason that module does.
 *
 * RANGES RESOLVE AGAINST `renderedRowIds` — the ids `GridTableV2` hands back as
 * the third callback argument, which is what it actually PAINTED. The host's own
 * item list is not a substitute: sorting and grouping reorder rows and a
 * collapsed group hides them, so slicing the host's list selects rows the user
 * never traversed and, under a collapsed group, cannot see.
 */

import type { GridTableV2SelectionProps } from "@closedloop-ai/design-system/lib/grid-table-v2-types";
import { formatGridCardSelectionLabel } from "@closedloop-ai/design-system/lib/grid-table-aria";

/** The chord carried by the pointer or keyboard event that activated a row. */
export type GridSelectionModifiers = {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

/**
 * Selected row ids plus the anchor a `Shift` range extends FROM. The anchor is
 * part of the state rather than derived: after a `Space` toggle or a `Ctrl`
 * click, "extend from where I just was" cannot be read back out of the set.
 */
export type GridRowSelection = {
  readonly anchorId: string | null;
  readonly selectedIds: ReadonlySet<string>;
};

export const EMPTY_GRID_ROW_SELECTION: GridRowSelection = {
  anchorId: null,
  selectedIds: new Set<string>(),
};

/**
 * A row activated by pointer click or by keyboard navigation onto it. Both paths
 * call THIS, which is what makes `Shift+ArrowDown` and `Shift`-click the same
 * operation rather than two implementations that happen to agree today.
 */
export function resolveGridRowSelection(
  current: GridRowSelection,
  rowId: string,
  modifiers: GridSelectionModifiers,
  renderedRowIds: readonly string[]
): GridRowSelection {
  const range = resolveRange(current.anchorId, rowId, modifiers, renderedRowIds);
  if (range) {
    // The anchor deliberately survives, so dragging a range back and forth keeps
    // extending from its origin instead of collapsing onto the last row touched.
    return { anchorId: current.anchorId, selectedIds: new Set(range) };
  }
  if (modifiers.ctrlKey || modifiers.metaKey) {
    return toggleGridRowSelection(current, rowId);
  }
  return { anchorId: rowId, selectedIds: new Set([rowId]) };
}

/**
 * Flip one row, leaving the rest of the selection alone — the `Ctrl/Cmd` branch
 * above and a bare `Space` on the focused row are the SAME operation. Re-anchors
 * so a `Shift+Arrow` straight afterwards extends from the row just toggled.
 */
export function toggleGridRowSelection(
  current: GridRowSelection,
  rowId: string
): GridRowSelection {
  const selectedIds = new Set(current.selectedIds);
  if (selectedIds.has(rowId)) {
    selectedIds.delete(rowId);
  } else {
    selectedIds.add(rowId);
  }
  return { anchorId: rowId, selectedIds };
}

/**
 * `Ctrl/Cmd+A`. Takes the RENDERED ids, so "all" never reaches a row hidden by a
 * filter or a collapsed group. Anchoring on the first keeps a following
 * `Shift+Arrow` meaningful instead of extending from a stale anchor.
 */
export function selectAllGridRows(
  renderedRowIds: readonly string[]
): GridRowSelection {
  return {
    anchorId: renderedRowIds.at(0) ?? null,
    selectedIds: new Set(renderedRowIds),
  };
}

/**
 * The `Shift` range, or `null` when this activation is not one — either no
 * `Shift`, or an anchor/target that the current render does not paint (a filter
 * dropped the anchor row, say), in which case the caller falls through to the
 * unmodified meaning rather than silently selecting an arbitrary span.
 */
function resolveRange(
  anchorId: string | null,
  rowId: string,
  modifiers: GridSelectionModifiers,
  renderedRowIds: readonly string[]
): string[] | null {
  if (!modifiers.shiftKey) {
    return null;
  }
  const anchorIndex = renderedRowIds.indexOf(anchorId ?? "");
  const targetIndex = renderedRowIds.indexOf(rowId);
  if (anchorId === null || anchorIndex < 0 || targetIndex < 0) {
    return null;
  }
  return renderedRowIds.slice(
    Math.min(anchorIndex, targetIndex),
    Math.max(anchorIndex, targetIndex) + 1
  );
}

/**
 * Drop from a selection every row the current visible set no longer contains,
 * and the anchor with them (ISS-9574).
 *
 * `rowIds` is the current visible row set after filtering, paging, live-row
 * changes, group-band collapse and parent-row collapse. The host owns the first
 * three; `GridTableV2` owns the painted order and reports its post-collapse
 * items through `onRenderedItemsChange`. Both feed this same rule, so a hidden
 * row and its anchor are removed no matter which visibility axis hid them.
 *
 * The anchor goes with the rows for the same reason it is state rather than
 * derived: a `Shift` extending from a row that no longer exists would select a
 * span the reader could not have drawn by hand.
 *
 * Returns `current` unchanged — by identity, not merely by value — when every
 * selected id and the anchor survive, so a host can call this from an effect
 * without writing state on every render.
 */
export function reconcileGridRowSelection(
  current: GridRowSelection,
  rowIds: readonly string[]
): GridRowSelection {
  const present = new Set(rowIds);
  const anchorId =
    current.anchorId !== null && present.has(current.anchorId)
      ? current.anchorId
      : null;
  const kept = new Set<string>();
  for (const id of current.selectedIds) {
    if (present.has(id)) {
      kept.add(id);
    }
  }
  // The INCOMING set when nothing was dropped, even where the anchor did
  // change. Each axis keeps its own identity, so a host that writes only the ids
  // back — the shape an effect naturally takes — sees `===` and stops, instead of
  // re-rendering on a fresh set forever because a stale anchor made this object
  // new on every pass.
  const selectedIds =
    kept.size === current.selectedIds.size ? current.selectedIds : kept;
  if (anchorId === current.anchorId && selectedIds === current.selectedIds) {
    return current;
  }
  return { anchorId, selectedIds };
}

/**
 * Maps one selection model onto every `GridTableV2` selection prop, so a click,
 * a keyboard move and a range drag all reach the same handler and a
 * host cannot wire one path and forget another.
 */
export function gridTableV2SelectionProps<T>({
  getCardLabel,
  isRowSelected,
  onRowSelection,
  onRowSelectionToggle,
  onRenderedItemsChange,
  onSelectAllRows,
}: {
  getCardLabel?: (item: T) => string;
  isRowSelected: (item: T) => boolean;
  onRowSelection: (
    item: T,
    modifiers: GridSelectionModifiers,
    renderedItems?: readonly T[]
  ) => void;
  onRowSelectionToggle?: (item: T) => void;
  onRenderedItemsChange?: (items: readonly T[]) => void;
  onSelectAllRows?: (items: readonly T[]) => void;
}): GridTableV2SelectionProps<T> {
  return {
    enableRowRangeDrag: true,
    getCardSelectionLabel: getCardLabel
      ? (item, selected) => formatGridCardSelectionLabel(getCardLabel(item), selected)
      : undefined,
    isRowSelected,
    onRowClick: onRowSelection,
    onRowKeyboardNavigate: onRowSelection,
    onRowRangeDrag: onRowSelection,
    onRowSelectionToggle,
    onRenderedItemsChange,
    onSelectAllRows,
  };
}
