/**
 * The pointer half of `GridTableV2`'s row range selection (ISS-8747).
 *
 * `Shift`+`Up`/`Down` already selected a range; pressing on a row and dragging
 * did nothing, so the interaction every other range surface offers both ways —
 * Finder, a spreadsheet, a file list — was keyboard-only here and read as a
 * broken affordance rather than a deliberate one.
 *
 * THIS MODULE OWNS NO RANGE. `resolveGridRowSelection` in
 * `grid-table-v2-selection` stays the single answer to what a range MEANS, and
 * a drag reaches it through the host exactly as `Shift`-click does — as a row
 * activation carrying `shiftKey`. That is what keeps the pointer and keyboard
 * paths from drifting: there is nothing here to drift, only which row the
 * pointer is over. The anchor's deliberate survival across a range resolve is
 * what makes dragging back and forth re-resolve from the press row rather than
 * collapsing onto the last row touched.
 *
 * Pure DOM, no React, so the row-under-the-pointer walk is unit-testable
 * against a synthetic grid — the reason its `grid-table-navigation` sibling is
 * shaped the same way.
 */

import { isGridChromeRowId } from "./grid-table-v2-chrome-rows";
import type { GridSelectionModifiers } from "./grid-table-v2-selection";

/**
 * Marks a row a range drag may select. NOT `[data-grid-row]`: since ISS-8930
 * the header and group-section headers are rows of the same navigation model,
 * and an after-row slot always was, so the row walk now contains rows that are
 * not the caller's items. Dragging must resolve against the selectable ones or
 * a drag over a group header would select whatever chrome row it landed on.
 */
export const GRID_SELECTABLE_ROW_SELECTOR = "[data-grid-selectable-row]";

/**
 * The grid's DATA rows under `root`, chrome excluded.
 *
 * Hoisted here because the same three lines — the `[data-grid-row]
 * [data-grid-row-id]` query, then the `isGridChromeRowId` filter over
 * `dataset.gridRowId` — had been written out at six sites across the Sessions
 * suites and stories (tamsinb review). A row walk that each caller re-derives
 * is one that drifts: since ISS-8930 the header and group-section headers carry
 * `data-grid-row-id` too, so a caller that forgets the filter counts chrome as
 * data and its "the grid rendered N rows" anti-vacuity guard silently stops
 * meaning that.
 *
 * Lives beside {@link GRID_SELECTABLE_ROW_SELECTOR} rather than in
 * `grid-table-v2-chrome-rows`, whose docblock states it carries no DOM — this
 * module already queries one in `resolveDragRowIdAtPoint`.
 */
export function queryGridDataRows(root: ParentNode): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-grid-row][data-grid-row-id]")
  ).filter((row) => !isGridChromeRowId(row.dataset.gridRowId ?? ""));
}

/** The rows a range drag may select under `root`. */
export function queryGridSelectableRows(root: ParentNode): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(GRID_SELECTABLE_ROW_SELECTOR)
  );
}

/**
 * The activation a drag's first move reports for the PRESS row: an unmodified
 * one, which is what makes that row the anchor every later move extends from.
 */
export const ROW_DRAG_ANCHOR_MODIFIERS: GridSelectionModifiers = {
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

/**
 * The activation every later move reports. `shiftKey` is the whole message —
 * it is what routes the row through `resolveGridRowSelection`'s range arm
 * instead of its replace arm, so a drag and a `Shift`-click are the same
 * operation rather than two that happen to agree.
 */
export const ROW_DRAG_EXTEND_MODIFIERS: GridSelectionModifiers = {
  ctrlKey: false,
  metaKey: false,
  shiftKey: true,
};

/**
 * The id of the selectable row under `clientY`, CLAMPED to the rendered
 * boundary — the first row when the pointer is above the body, the last when it
 * is below.
 *
 * Clamping rather than returning null past the edge is the deliberate answer to
 * "what happens when the drag leaves the grid" (ISS-8747 criterion 5): a range
 * that silently stops wherever the last pointer sample happened to land is the
 * failure mode, because a fast drag out of the viewport samples nowhere near
 * the boundary. The range therefore extends to the last painted row and stays
 * there; it does NOT auto-scroll to reveal more, so what the drag selects is
 * always what the reader could see.
 *
 * Resolved by vertical position alone. Rows are full-width bands, so horizontal
 * drift — off the side of the grid, over a scrollbar — must not interrupt the
 * range.
 */
export function resolveDragRowIdAtPoint(
  gridBody: HTMLElement,
  clientY: number
): string | null {
  const rows = Array.from(
    gridBody.querySelectorAll<HTMLElement>(GRID_SELECTABLE_ROW_SELECTOR)
  );
  let previous: HTMLElement | null = null;
  for (const row of rows) {
    const bounds = row.getBoundingClientRect();
    if (clientY < bounds.top) {
      // In the gap above this row: the row before it is the nearest painted
      // one, and above the FIRST row there is none, so the first row itself is
      // the boundary the range clamps to.
      return rowIdOf(previous ?? row);
    }
    if (clientY <= bounds.bottom) {
      return rowIdOf(row);
    }
    previous = row;
  }
  return previous === null ? null : rowIdOf(previous);
}

function rowIdOf(row: HTMLElement): string | null {
  return row.dataset.gridRowId ?? null;
}
