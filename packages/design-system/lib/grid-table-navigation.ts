/**
 * Keyboard cell navigation for `GridTable` (GridTable v2).
 *
 * Lifted from the `generic-artifact` prototype's `grid-table.tsx` rather than
 * re-derived, because the exact click→focus handoff is the behavior being
 * reconciled: a pointer user clicks a row and the keyboard user who follows
 * lands on the cell that was clicked, not at the top of the table.
 *
 * Kept OUT of `grid-table.tsx` deliberately: that file is already at the
 * ~500-line "more than one responsibility" smell, and these are pure DOM
 * helpers with no React dependency, so they are unit-testable without
 * rendering a table.
 *
 * ARIA note — why the caller flips `role` too. Arrow-key cell navigation is
 * what separates ARIA `grid` from ARIA `table`: `table` is a static data
 * structure, `grid` is a navigable widget. A table that wires these handlers
 * must therefore render `role="grid"` + `role="gridcell"` (see
 * `GRID_NAV_TABLE_ROLE` / `GRID_NAV_CELL_ROLE`), and one that does not keeps
 * the plain `table`/`cell` roles ISS-4672 shipped.
 */

/** Marks a focusable, arrow-navigable cell. Also the query selector for one. */
export const GRID_CELL_SELECTOR = "[data-grid-cell]";

/**
 * Elements inside a cell that own their own click. A row-level `onClick` must
 * not fire when the user actually pressed one of these — clicking a row's PR
 * link should follow the link, not also select the row.
 */
export const INTERACTIVE_CELL_CONTENT_SELECTOR =
  "button, a, input, textarea, select, [role='button'], [role='checkbox'], [role='menuitem'], [data-no-row-select]";

/**
 * Opt-out marker: an element inside an interactive control that should STILL
 * count as row selection (e.g. a row checkbox whose whole cell is a hit area).
 * Checked before `INTERACTIVE_CELL_CONTENT_SELECTOR` so it wins.
 */
export const ROW_SELECTION_SURFACE_SELECTOR = "[data-row-selection-surface]";

/** ARIA roles a navigable grid uses instead of the static `table`/`cell`. */
export const GRID_NAV_TABLE_ROLE = "grid";
export const GRID_NAV_CELL_ROLE = "gridcell";

const ARROW_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/**
 * True when a row-level click landed on a control that owns its own activation,
 * so the row's `onRowClick` must be skipped. A `data-row-selection-surface`
 * ancestor overrides this — that is how a caller opts a checkbox cell back INTO
 * row selection.
 */
export function isInteractiveRowClickTarget(target: HTMLElement): boolean {
  if (target.closest(ROW_SELECTION_SURFACE_SELECTOR)) {
    return false;
  }
  return target.closest(INTERACTIVE_CELL_CONTENT_SELECTOR) != null;
}

/**
 * The click→keyboard handoff (GridTable v2 interaction criterion 4). Moves DOM
 * focus to the cell the pointer actually landed in, so the very next arrow key
 * continues from there. Returns the focused cell (or `null`) so a caller can
 * sync its roving-tabindex state to the same cell.
 */
export function focusCellFromRowClick(target: HTMLElement): HTMLElement | null {
  const cell = target.closest<HTMLElement>(GRID_CELL_SELECTOR);
  cell?.focus();
  return cell ?? null;
}

/**
 * Resolve the cell an arrow key should move to, or `null` when the move would
 * leave the grid (first column pressing Left, last row pressing Down, …) — in
 * which case the caller leaves the event alone so the key keeps its native
 * meaning instead of being swallowed at the edge.
 *
 * Pure DOM walk, no React, so the whole navigation contract is unit-testable
 * against a synthetic grid.
 */
export function resolveNextGridCell(
  currentCell: HTMLElement,
  key: string
): HTMLElement | null {
  const row = currentCell.closest<HTMLElement>("[data-grid-row]");
  const table = row?.closest<HTMLElement>("[data-grid-body]");
  if (!(row && table)) {
    return null;
  }
  const rowCells = Array.from(
    row.querySelectorAll<HTMLElement>(GRID_CELL_SELECTOR)
  );
  const cellIndex = rowCells.indexOf(currentCell);
  if (cellIndex === -1) {
    return null;
  }
  if (key === "ArrowLeft" || key === "ArrowRight") {
    return rowCells[cellIndex + (key === "ArrowLeft" ? -1 : 1)] ?? null;
  }
  const rows = Array.from(
    table.querySelectorAll<HTMLElement>("[data-grid-row]")
  );
  const rowIndex = rows.indexOf(row);
  const nextRow = rows[rowIndex + (key === "ArrowUp" ? -1 : 1)];
  if (!nextRow) {
    return null;
  }
  return (
    Array.from(nextRow.querySelectorAll<HTMLElement>(GRID_CELL_SELECTOR))[
      cellIndex
    ] ?? null
  );
}

/**
 * True when an arrow key pressed on a cell must be left to the focused control
 * rather than moving the selection: a text input's caret, a textarea, and a
 * native select all use the arrow keys themselves, and a modifier chord
 * (Alt/Ctrl/Meta) belongs to the browser or OS.
 */
export function shouldSkipGridNavigation(
  key: string,
  target: EventTarget | null,
  modifiers: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }
): boolean {
  if (modifiers.altKey || modifiers.ctrlKey || modifiers.metaKey) {
    return true;
  }
  if (!ARROW_KEYS.includes(key)) {
    return true;
  }
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}
