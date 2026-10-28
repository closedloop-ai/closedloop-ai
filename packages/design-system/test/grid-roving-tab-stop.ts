import { GRID_CELL_SELECTOR } from "../lib/grid-table-navigation";

/**
 * Test-support for `GridTableV2`'s roving tab stop: the ONE cell a keyboard user
 * can reach the grid through, and the row it belongs to.
 *
 * Shared rather than re-declared per suite because both halves encode the same
 * DOM contract — the cell marker, the `tabindex="0"` that makes it the tab stop,
 * and the row's `data-grid-row-id`. Two copies of that can be updated apart, and
 * the stale one keeps passing against a grid that has moved (ISS-9555 review).
 * Imported by this package's own suites and by `@repo/app`'s Sessions suites,
 * which assert against the same grid.
 *
 * Under `test/`, not `__tests__/`, so `no-bare-browser-globals` still applies
 * here: that gate exempts the `/__tests__/` segment and the `.test.*` suffix,
 * and this module has neither. Hence the `globalThis.document` read below
 * rather than a bare `document` (`pnpm check:source-gates`).
 */
const ROVING_TAB_STOP_SELECTOR = `${GRID_CELL_SELECTOR}[tabindex="0"]`;
const ROW_ID_SELECTOR = "[data-grid-row-id]";

/** The single cell in the tab order, whichever one the grid resolved. */
export function rovingTabStop(): HTMLElement {
  const cell = globalThis.document.querySelector<HTMLElement>(
    ROVING_TAB_STOP_SELECTOR
  );
  if (!cell) {
    throw new Error("the grid left no cell in the tab order");
  }
  return cell;
}

/** The grid cell a control sits in; throws when it is not inside one. */
export function gridCellOf(element: HTMLElement): HTMLElement {
  const cell = element.closest<HTMLElement>(GRID_CELL_SELECTOR);
  if (!cell) {
    throw new Error("element is not inside a grid cell");
  }
  return cell;
}

/** The id of the row holding the tab stop, or `undefined` for a chrome row. */
export function rowIdOfTabStop(): string | undefined {
  return rovingTabStop().closest<HTMLElement>(ROW_ID_SELECTOR)?.dataset
    .gridRowId;
}
