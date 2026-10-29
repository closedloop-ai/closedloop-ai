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

/** Marks one row of a navigable grid. Also the query selector for one. */
export const GRID_ROW_SELECTOR = "[data-grid-row]";

/**
 * The grid's body: the ancestor every row-wise move is resolved against, which
 * is what lets ArrowUp/Down cross a group boundary instead of stopping at the
 * pressed row's immediate siblings.
 */
export const GRID_BODY_SELECTOR = "[data-grid-body]";

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

/**
 * Every key the WAI-ARIA APG grid pattern gives a navigable grid, as one set.
 *
 * The arrows alone used to BE this set, which is why `Home`, `End`,
 * `Ctrl+Home`, `Ctrl+End`, `PageUp` and `PageDown` did nothing (ISS-8038): the
 * guard below early-returned for every key that was not an arrow, so a keyboard
 * user could only ever walk the grid one cell at a time.
 */
export const GridNavigationKey = {
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
  End: "End",
  Home: "Home",
  PageDown: "PageDown",
  PageUp: "PageUp",
} as const;
export type GridNavigationKey =
  (typeof GridNavigationKey)[keyof typeof GridNavigationKey];

const NAVIGATION_KEYS: ReadonlySet<string> = new Set(
  Object.values(GridNavigationKey)
);

/**
 * The only two keys whose `Ctrl` chord belongs to the GRID rather than to the
 * browser or the OS: APG spells the grid extremes `Ctrl+Home` / `Ctrl+End`.
 * Every other Ctrl chord (`Ctrl+ArrowDown`, …) still goes to its owner.
 */
const CTRL_CHORD_KEYS: ReadonlySet<string> = new Set([
  GridNavigationKey.End,
  GridNavigationKey.Home,
]);

/**
 * Rows a `PageUp` / `PageDown` moves. APG leaves the amount to the author ("an
 * author-determined number of rows"), and a fixed count is picked here rather
 * than measured from the scroll container because the grid renders inside a
 * host-owned scroller whose height it does not know — a measured page would be
 * 0 rows in exactly the case (an unmeasured or virtualized host) where the key
 * matters most. Clamped at both ends, so a page never runs off the grid.
 */
export const GRID_PAGE_ROW_COUNT = 10;

/**
 * True when a row-level click landed on a control that owns its own activation,
 * so the row's `onRowClick` must be skipped. A `data-row-selection-surface`
 * ancestor overrides this — that is how a caller opts a checkbox cell back INTO
 * row selection.
 *
 * `Element`, not `HTMLElement`: an event target inside a row is frequently an
 * inline `<svg>` or one of its `<path>` children, which are `SVGElement` and
 * would fail an `HTMLElement` narrowing at the call site before this predicate
 * ever ran. The answer is unchanged for either — both walks are `closest`,
 * which is `Element`'s.
 */
export function isInteractiveRowClickTarget(target: Element): boolean {
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
 *
 * `Element`, not `HTMLElement`, for the same reason
 * {@link isInteractiveRowClickTarget} takes one: a press inside a row frequently
 * lands on an inline `<svg>` or one of its `<path>` children, which are
 * `SVGElement`. The walk below is `closest`, which is `Element`'s, and the
 * returned cell is still an `HTMLElement`.
 */
export function focusCellFromRowClick(target: Element): HTMLElement | null {
  const cell = target.closest<HTMLElement>(GRID_CELL_SELECTOR);
  if (cell) {
    cell.focus();
    return cell;
  }
  // A press on the row's trailing filler (an aria-hidden gridcell that is not a
  // navigable cell) lands in no navigable cell. The row is still selected by
  // that click, so focus the row's last navigable cell: otherwise focus stays
  // on the body and Ctrl/Cmd+A and Escape never reach the grid (ISS-13007). A
  // press on the row container itself, outside any gridcell, keeps leaving
  // focus alone.
  if (!target.closest('[role="gridcell"]')) {
    return null;
  }
  const row = target.closest<HTMLElement>("[data-grid-row]");
  const cells = row?.querySelectorAll<HTMLElement>(GRID_CELL_SELECTOR);
  const fallback = cells?.item(cells.length - 1) ?? null;
  fallback?.focus({ preventScroll: true });
  return fallback;
}

/**
 * Resolve the cell a navigation key should move to, or `null` when the move
 * would leave the ROWS THIS BODY PAINTED (first column pressing Left, last
 * painted row pressing Down, …). A body that paints all of its rows is at a
 * real edge there, and its caller leaves the event alone so the key keeps its
 * native meaning instead of being swallowed; a windowed body resolves the same
 * move against the population instead (see {@link
 * resolveRowWiseDestinationIndex}).
 *
 * `modifiers.ctrlKey` is what separates `Home` (start of THIS row) from
 * `Ctrl+Home` (first cell of the grid), so a caller that forgets to forward it
 * silently ships only half the APG pattern.
 *
 * Home/End/PageUp/PageDown are grid-scoped rather than edge-stopping: pressing
 * `Home` on a row's first cell resolves to that same cell, which the caller
 * still claims (the key must not fall through and scroll the host away from the
 * grid the user is navigating).
 *
 * A treegrid opts `homeEndByRow` into the tree pattern instead: unmodified Home
 * and End move to the first cell of the first or last visible row. Flat grids
 * retain their row-scoped Home/End behavior.
 *
 * Pure DOM walk, no React, so the whole navigation contract is unit-testable
 * against a synthetic grid.
 */
export function resolveNextGridCell(
  currentCell: HTMLElement,
  key: string,
  modifiers: { ctrlKey?: boolean; homeEndByRow?: boolean } = {}
): HTMLElement | null {
  const row = currentCell.closest<HTMLElement>(GRID_ROW_SELECTOR);
  const table = row?.closest<HTMLElement>(GRID_BODY_SELECTOR);
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
  const withinRow = resolveWithinRow(rowCells, cellIndex, key, modifiers);
  if (withinRow !== undefined) {
    return withinRow;
  }
  const rows = Array.from(
    table.querySelectorAll<HTMLElement>(GRID_ROW_SELECTOR)
  );
  const targetRow = resolveTargetRow(rows, rows.indexOf(row), key, modifiers);
  if (!targetRow) {
    return null;
  }
  const targetCells = Array.from(
    targetRow.querySelectorAll<HTMLElement>(GRID_CELL_SELECTOR)
  );
  if (
    modifiers.homeEndByRow === true &&
    modifiers.ctrlKey !== true &&
    (key === GridNavigationKey.Home || key === GridNavigationKey.End)
  ) {
    return targetCells.at(0) ?? null;
  }
  // A grid extreme lands on the grid's first/last CELL, not on whichever column
  // the cursor happened to be in — that is what makes it an extreme rather than
  // a column-preserving jump. Every row-wise move keeps the column.
  if (modifiers.ctrlKey === true && CTRL_CHORD_KEYS.has(key)) {
    const extreme =
      key === GridNavigationKey.Home ? targetCells.at(0) : targetCells.at(-1);
    return extreme ?? null;
  }
  // A destination row may paint FEWER cells than the one the move started in:
  // an after-row slot's row carries only its affordance, not one cell per
  // column (ISS-8219). Resolve the landing by the LOGICAL column both rows
  // declare, because a short row's cell sits at a DOM index that means a
  // different column: the create row's only cell is DOM index 0 but
  // `aria-colindex` 2, so an index-wise ArrowUp out of it lands one track to the
  // LEFT of where the user was — on the favorite/utility cell, not the identity
  // cell under the affordance. Falling back to the DOM index and then to the
  // last cell keeps a move whose column has no counterpart INSIDE the grid;
  // returning null instead would read as a grid EDGE and drop the key.
  // Inert for every uniform-row grid, which is every other row in the repo.
  return (
    findCellInSameColumn(targetCells, currentCell) ??
    targetCells[cellIndex] ??
    targetCells.at(-1) ??
    null
  );
}

/**
 * True when a navigation key pressed on a cell must be left to the focused
 * control rather than moving the selection: a text input's caret, a textarea,
 * and a native select all use these keys themselves, and a modifier chord
 * belongs to the browser or OS — with the single exception the APG grid pattern
 * carves out, `Ctrl+Home` / `Ctrl+End` for the grid extremes.
 */
export function shouldSkipGridNavigation(
  key: string,
  target: EventTarget | null,
  modifiers: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }
): boolean {
  if (modifiers.altKey || modifiers.metaKey) {
    return true;
  }
  if (!NAVIGATION_KEYS.has(key)) {
    return true;
  }
  if (modifiers.ctrlKey && !CTRL_CHORD_KEYS.has(key)) {
    return true;
  }
  return ownsItsOwnKeys(target);
}

/**
 * True for a control that consumes the grid's keys itself — a text field's
 * caret, a textarea, a native select. Shared by the navigation guard and the
 * cell-entry model so the two cannot disagree about who owns a keypress.
 */
export function ownsItsOwnKeys(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/**
 * The within-row half of a move, or `undefined` when the key needs a different
 * ROW resolved instead. `null` is a real answer here (a Left off the first
 * column), so the "not my key" signal has to be a third value.
 */
function resolveWithinRow(
  rowCells: readonly HTMLElement[],
  cellIndex: number,
  key: string,
  modifiers: { ctrlKey?: boolean; homeEndByRow?: boolean }
): HTMLElement | null | undefined {
  if (key === GridNavigationKey.ArrowLeft) {
    return rowCells[cellIndex - 1] ?? null;
  }
  if (key === GridNavigationKey.ArrowRight) {
    return rowCells[cellIndex + 1] ?? null;
  }
  if (modifiers.ctrlKey === true || modifiers.homeEndByRow === true) {
    return undefined;
  }
  if (key === GridNavigationKey.Home) {
    return rowCells.at(0) ?? null;
  }
  if (key === GridNavigationKey.End) {
    return rowCells.at(-1) ?? null;
  }
  return undefined;
}

/**
 * True for a key whose row destination is defined by the WHOLE population
 * rather than by the pressed row's neighbour: the grid extremes, and a page
 * jump's ten rows.
 *
 * It matters only to a body that paints a WINDOW of its rows (ISS-12288), where
 * the two answers diverge — `Ctrl+End` resolved against the painted rows lands
 * on the last PAINTED row, which is not the last row, and a page jump clamps to
 * a window edge the reader cannot see. A step's destination is its neighbour
 * either way, so only these keys have to be resolved by index.
 */
export function isGridRowJumpKey(
  key: string,
  modifiers: { ctrlKey?: boolean }
): boolean {
  if (modifiers.ctrlKey === true) {
    return CTRL_CHORD_KEYS.has(key);
  }
  return (
    key === GridNavigationKey.PageUp || key === GridNavigationKey.PageDown
  );
}

/**
 * The INDEX a row-wise move lands on, or `null` when the move would leave the
 * population (first row pressing Up, last row pressing Down) or the key moves no
 * row at all.
 *
 * Shared by the DOM walk below and by a windowed body's own navigation, so the
 * two cannot answer `PageDown` differently depending on how many rows happen to
 * be painted.
 */
export function resolveRowWiseDestinationIndex({
  key,
  modifiers,
  rowCount,
  rowIndex,
}: {
  key: string;
  modifiers: { ctrlKey?: boolean };
  rowCount: number;
  rowIndex: number;
}): number | null {
  if (rowIndex === -1 || rowCount <= 0) {
    return null;
  }
  if (modifiers.ctrlKey === true && CTRL_CHORD_KEYS.has(key)) {
    return key === GridNavigationKey.Home ? 0 : rowCount - 1;
  }
  const destination =
    steppedRowIndex(rowIndex, key) ?? pageRowIndex(rowCount, rowIndex, key);
  if (destination === null) {
    return null;
  }
  return destination >= 0 && destination < rowCount ? destination : null;
}

/** The row a row-wise move lands on, clamped inside the grid for a page jump. */
function resolveTargetRow(
  rows: readonly HTMLElement[],
  rowIndex: number,
  key: string,
  modifiers: { ctrlKey?: boolean; homeEndByRow?: boolean }
): HTMLElement | null {
  if (
    modifiers.homeEndByRow === true &&
    modifiers.ctrlKey !== true &&
    (key === GridNavigationKey.Home || key === GridNavigationKey.End)
  ) {
    return key === GridNavigationKey.Home
      ? (rows.at(0) ?? null)
      : (rows.at(-1) ?? null);
  }
  const destination = resolveRowWiseDestinationIndex({
    key,
    modifiers,
    rowCount: rows.length,
    rowIndex,
  });
  return destination === null ? null : rows[destination] ?? null;
}

/** The neighbour an arrow steps to, or `null` for every other key. */
function steppedRowIndex(rowIndex: number, key: string): number | null {
  if (key === GridNavigationKey.ArrowUp) {
    return rowIndex - 1;
  }
  if (key === GridNavigationKey.ArrowDown) {
    return rowIndex + 1;
  }
  return null;
}

/** Clamped destination index for a page jump, or `null` for any other key. */
function pageRowIndex(
  rowCount: number,
  rowIndex: number,
  key: string
): number | null {
  if (key === GridNavigationKey.PageUp) {
    return Math.max(0, rowIndex - GRID_PAGE_ROW_COUNT);
  }
  if (key === GridNavigationKey.PageDown) {
    return Math.min(rowCount - 1, rowIndex + GRID_PAGE_ROW_COUNT);
  }
  return null;
}

/** Attribute naming the 1-based grid track a cell occupies. */
export const ARIA_COLUMN_INDEX_ATTRIBUTE = "aria-colindex";

/**
 * The destination cell declaring the SAME `aria-colindex` as the cell a row-wise
 * move started in, or `null` when either side declares none.
 *
 * `aria-colindex` is the only thing that says which COLUMN a cell is in — DOM
 * order says which cell it is, and the two agree only while every row paints the
 * same cells. Matching on the logical column is what makes a row-wise move
 * symmetric across a short row: the same column is left and re-entered rather
 * than the move drifting a track each time it crosses one.
 */
function findCellInSameColumn(
  targetCells: readonly HTMLElement[],
  currentCell: HTMLElement
): HTMLElement | null {
  const columnIndex = currentCell.getAttribute(ARIA_COLUMN_INDEX_ATTRIBUTE);
  if (columnIndex === null) {
    return null;
  }
  return (
    targetCells.find(
      (cell) => cell.getAttribute(ARIA_COLUMN_INDEX_ATTRIBUTE) === columnIndex
    ) ?? null
  );
}

/**
 * The role a navigable grid takes once its rows own CHILD ROWS (ISS-8921).
 *
 * `treegrid` is not a rename of `grid`: it is the role that says the rows form a
 * hierarchy, and it is what makes `aria-level` / `aria-posinset` /
 * `aria-setsize` / `aria-expanded` on a `row` meaningful rather than
 * unsupported. A grid whose caller supplied no child accessor keeps
 * {@link GRID_NAV_TABLE_ROLE} — the two are alternatives for the same element,
 * which is why this sits beside it rather than in the tree module.
 */
export const GRID_TREE_NAV_TABLE_ROLE = "treegrid";
