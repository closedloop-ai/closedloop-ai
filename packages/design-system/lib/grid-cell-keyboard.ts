/**
 * A focused grid cell's whole keyboard contract, WAI-ARIA APG grid pattern
 * (ISS-8038): the cell-entry model, plus the shared keydown handler that pairs
 * it with the navigation keys in the sibling `grid-table-navigation` module.
 *
 * The grids already carried the pattern's FOCUS half: a roving tabindex puts
 * exactly one cell in the tab order and the navigation keys move it. APG pairs
 * that with an entry model for cells whose content is a widget — `Enter` or
 * `F2` moves focus INTO the widget, `Escape` or `F2` returns it to the cell —
 * and without it a control inside a cell has no defined keyboard route at all.
 * `F2` toggles rather than only entering because `Escape` belongs to a text
 * control that is holding an unsaved draft, so it cannot be the only way out.
 *
 * Roving tabindex, NOT `aria-activedescendant`. The two are alternative focus
 * models and mixing them is an ARIA violation, so everything here moves real
 * DOM focus and nothing publishes an active-descendant id.
 *
 * Kept out of the components, and free of React, for the reason the sibling
 * `grid-table-navigation` module is: both `GridTable` and `GridTableV2` wire
 * the same contract, and a shared DOM helper is the only way the two cannot
 * drift apart. It is also why the unmount guard below is a `MutationObserver`
 * rather than an effect — see `enterGridCell`.
 */

import { ENTERABLE_CONTENT_SELECTOR } from "./grid-cell-tab-stops";
import { normalizedEventKey } from "./keyboard-event-key";
import {
  ARIA_COLUMN_INDEX_ATTRIBUTE,
  GRID_BODY_SELECTOR,
  GRID_CELL_SELECTOR,
  GRID_ROW_SELECTOR,
  GridNavigationKey,
  isGridRowJumpKey,
  ownsItsOwnKeys,
  resolveNextGridCell,
  resolveRowWiseDestinationIndex,
  shouldSkipGridNavigation,
} from "./grid-table-navigation";

/**
 * The shape both grids' React keydown events satisfy structurally, so this
 * module stays React-free while still typing what it reads.
 */
type GridCellKeyEvent = {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
  currentTarget: HTMLElement;
  preventDefault: () => void;
};

/** Keys that enter a cell's interactive content, per the APG grid pattern. */
const GridCellEntryKey = {
  Enter: "Enter",
  F2: "F2",
} as const;
/**
 * The key that leaves entered content and returns focus to its cell. Not the
 * only one: `F2` toggles, and is the exit a text control's own Escape would
 * otherwise leave the user without.
 */
const GRID_CELL_EXIT_KEY = "Escape";

/**
 * Opt-in marker naming the control a cell's entry should land on. A cell with
 * several controls (an identity cell with an open button AND a rename button)
 * would otherwise be entered at whichever comes first in the DOM.
 */
export const GRID_CELL_PRIMARY_EDITOR_SELECTOR = "[data-grid-primary-editor]";

const ENTRY_KEYS: ReadonlySet<string> = new Set(Object.values(GridCellEntryKey));

/**
 * The cell whose content currently holds focus, and the observer watching that
 * content for the unmount described in `enterGridCell`. At most one, because at
 * most one element in a document has focus.
 *
 * `gridBody` and `position` are captured on the way IN because the way out may
 * not be able to re-derive them: once the entered control has removed its own
 * row, the cell is detached and its index in the grid is gone with it.
 */
let openEntry: {
  cell: HTMLElement;
  gridBody: HTMLElement | null;
  position: GridCellPosition | null;
  observer: MutationObserver;
  onFocusOut: (event: FocusEvent) => void;
} | null = null;

/** A cell's coordinates in its grid, in visible DOM order. */
type GridCellPosition = { rowIndex: number; columnIndex: number };

/**
 * The control a cell's entry lands on: its declared primary editor, else the
 * first operable thing inside it. `null` when the cell holds no control at all,
 * which is how a caller tells an inert cell apart from an interactive one and
 * leaves the key its native meaning.
 */
function findGridCellEntryTarget(cell: HTMLElement): HTMLElement | null {
  return (
    cell.querySelector<HTMLElement>(GRID_CELL_PRIMARY_EDITOR_SELECTOR) ??
    cell.querySelector<HTMLElement>(ENTERABLE_CONTENT_SELECTOR)
  );
}

/**
 * Move focus into a cell's interactive content. Returns whether focus ACTUALLY
 * landed there, not merely whether a target was found: a `data-grid-primary-editor`
 * is an unvalidated public opt-in a caller can put on a disabled button or a
 * plain `<span>`, and `focus()` on one of those is a silent no-op. Reporting
 * success from the lookup would make the caller swallow the key and leave the
 * user with a dead Enter and no native fallback — the same WCAG 2.1.1 dead end
 * this model exists to remove. False leaves the key alone.
 *
 * Arms the unmount guard, and that guard is the whole reason this is imperative
 * DOM rather than component state. Entered content routinely REPLACES ITSELF:
 * an inline editor's trigger unmounts to render a field, the field unmounts
 * again on save or cancel. The browser drops focus on `<body>` when the focused
 * node is removed, which is the keyboard trap this model must not create — the
 * user is left with no cell focused and has to Tab in from the top of the
 * document. No React effect can see it either, because the unmount is driven by
 * the CONTENT's own state, so neither the cell nor the grid re-renders.
 * Observing the entered cell's subtree is the only signal there is.
 */
function enterGridCell(cell: HTMLElement): boolean {
  const target = findGridCellEntryTarget(cell);
  if (!target) {
    return false;
  }
  releaseGridCellEntry();
  target.focus();
  if (cell.ownerDocument.activeElement !== target) {
    return false;
  }
  const gridBody = cell.closest<HTMLElement>(GRID_BODY_SELECTOR);
  const observer = new MutationObserver(() => restoreEnteredCellFocus(cell));
  observer.observe(cell, { childList: true, subtree: true });
  // The grid body as well as the cell, because the two cover different removals
  // and the cell alone misses the worse one. Content swapping INSIDE the cell
  // mutates the cell; a control that deletes its OWN ROW (the row's delete
  // button is itself inside that row) mutates the body, and an observer scoped
  // to the cell never fires for it — focus lands on `<body>` and stays there.
  // Watching an ancestor is redundant for the first case and the only signal for
  // the second; the callback is idempotent, so the overlap costs nothing.
  if (gridBody) {
    observer.observe(gridBody, { childList: true, subtree: true });
  }
  // Removing a focused node fires NO focusout, which is exactly what makes this
  // the right signal for the opposite case: reaching this handler means the user
  // MOVED focus deliberately. A move that lands outside the cell ends the entry,
  // so a later re-render of that cell cannot drag them back into a grid they had
  // already walked away from.
  const onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && cell.contains(next)) {
      return;
    }
    releaseGridCellEntry();
  };
  cell.addEventListener("focusout", onFocusOut);
  openEntry = {
    cell,
    gridBody,
    observer,
    onFocusOut,
    position: locateGridCell(cell, gridBody),
  };
  return true;
}

/**
 * Return focus from a cell's content to the cell itself. Returns false when
 * focus was not inside the cell to begin with, so the caller leaves `Escape` to
 * whatever else claims it.
 */
function exitGridCell(cell: HTMLElement): boolean {
  const active = cell.ownerDocument.activeElement;
  if (active === null || active === cell || !cell.contains(active)) {
    return false;
  }
  cell.focus();
  releaseGridCellEntry();
  return true;
}

/**
 * The cell-entry keyboard contract, shared by both grids. Returns true when the
 * key was consumed, so the caller's navigation path can bail.
 */
export function handleGridCellEntryKeyDown(event: {
  key: string;
  target: EventTarget | null;
  currentTarget: HTMLElement;
  preventDefault: () => void;
}): boolean {
  const cell = event.currentTarget;
  if (event.key === GRID_CELL_EXIT_KEY) {
    if (!canExitOnEscape(event.target) || !exitGridCell(cell)) {
      return false;
    }
    // Called on the event, never as a detached reference: React's synthetic
    // `preventDefault` reads `this`, so passing the function along throws.
    event.preventDefault();
    return true;
  }
  if (!ENTRY_KEYS.has(event.key)) {
    return false;
  }
  if (event.target !== cell) {
    // Inside the cell. The control owns its own `Enter` (a button activates, a
    // field submits) and stealing it would make the entered content unusable,
    // but `F2` toggles: it is the route back OUT, and it has to exist, because
    // `Escape` does NOT always work from in here. A plain `input`, `textarea` or
    // `select` keeps its own Escape (see `canExitOnEscape`), and if that control
    // does not unmount itself in response — an always-mounted filter field, say
    // — nothing else returns focus to the cell. The navigation keys are the
    // field's too, so before this the user's only way back to grid navigation
    // was to Tab out of the grid entirely.
    //
    // `F2` can carry it because no text control claims it natively, so nothing
    // is taken away from the content to pay for it.
    if (event.key === GridCellEntryKey.F2 && exitGridCell(cell)) {
      event.preventDefault();
      return true;
    }
    // Consumed either way, so navigation never runs on a key pressed inside an
    // entered control.
    return true;
  }
  if (!enterGridCell(cell)) {
    return false;
  }
  event.preventDefault();
  return true;
}

/**
 * Forget the open entry without moving focus. Call when focus leaves the cell
 * by some route this module did not drive.
 */
function releaseGridCellEntry(): void {
  if (!openEntry) {
    return;
  }
  openEntry.observer.disconnect();
  openEntry.cell.removeEventListener("focusout", openEntry.onFocusOut);
  openEntry = null;
}

/**
 * A text field owns its own Escape: it reverts the draft, and its owner usually
 * closes the editor on the same key. Pulling focus out here would blur the field
 * mid-revert, and a blur-commits-the-draft editor would then save the very edit
 * the user just discarded. The unmount guard armed on entry is what returns
 * focus once that editor actually closes.
 *
 * "Usually" is why `F2` also exits: a field that stays mounted through Escape
 * never trips that guard, and this branch would otherwise be the user's only
 * offered way out and a dead key.
 */
function canExitOnEscape(target: EventTarget | null): boolean {
  return !ownsItsOwnKeys(target);
}

function restoreEnteredCellFocus(cell: HTMLElement): void {
  const entry = openEntry;
  if (entry?.cell !== cell) {
    return;
  }
  const active = cell.ownerDocument.activeElement;
  if (active !== null && active !== cell.ownerDocument.body) {
    // Focus is somewhere real: the content merely swapped one control for
    // another. A move OUT of the cell has already closed the entry through the
    // focusout listener, so nothing to do here either way.
    return;
  }
  if (cell.isConnected) {
    // Focus fell to `<body>`: the entered content was removed out from under it.
    // Restore, and stay ARMED — an inline editor unmounts twice (trigger swaps
    // to field, field swaps back), so disarming after the first would leave the
    // second unmount unguarded and strand focus exactly as before.
    cell.focus();
    return;
  }
  // The CELL is gone too, so the entered control removed its own row. `focus()`
  // on a detached node is a silent no-op, so restoring to the cell here would
  // leave focus on `<body>` — the same dead end, reached by a different route.
  // Hand it to whatever row took this one's place instead, and disarm: unlike
  // the swap above, this cell is never coming back.
  const survivor = findSurvivingGridCell(entry);
  releaseGridCellEntry();
  survivor?.focus();
}

/**
 * `GridTableV2`'s per-cell keydown: the entry keys above, then the navigation
 * keys, then the prototype's "selection follows focus" fallback.
 *
 * `windowedRows` is the row population behind a body that paints only a window
 * of it (ISS-12288), and it owns EVERY row-wise move there — not only the ones
 * the DOM walk visibly gets wrong (whitlockk review). A windowed body's painted
 * rows are neither the whole population nor, once a row outside the window is
 * retained for the roving tab stop, in population order, so the DOM walk is not
 * a model of the rows at all: it answers `Ctrl+End` with the last painted row
 * and `ArrowDown` off a retained row with whichever row the slice happens to
 * start at. Absent, the walk is the whole model, unchanged.
 *
 * `GridTable` composes the same two halves itself rather than calling this,
 * because it deliberately does NOT carry that fallback — the shared pieces are
 * the entry model and `resolveNextGridCell`, and those are what keep the two
 * grids answering a key the same way. Resolving rows against the
 * `[data-grid-body]` ancestor in visible DOM order is also what makes
 * ArrowUp/Down cross a group boundary, where the prototype's copy scoped its
 * query to the pressed row's `parentElement` and could only see that group's
 * immediate siblings.
 *
 * `homeEndByRow` is the treegrid opt-in for unmodified Home and End. It keeps
 * flat-grid row traversal unchanged while moving a treegrid to the first cell
 * of its first or last visible row.
 */
export function handleGridCellKeyDown<E extends GridCellKeyEvent>(
  event: E,
  onKeyboardNavigate?: (rowId: string, event: E) => void,
  selection?: GridSelectionHandlers,
  expansion?: GridRowExpansionHandlers,
  windowedRows?: GridWindowedRowNavigation<E>,
  homeEndByRow = false
) {
  if (handleGridCellEntryKeyDown(event)) {
    return;
  }
  if (selection && handleGridSelectionKeyDown(event, selection)) {
    return;
  }
  // Before the navigation guard, because the two keys this can claim ARE
  // navigation keys — and after it there is nothing left to claim.
  if (expansion && handleGridRowExpansionKeyDown(event, expansion)) {
    return;
  }
  if (
    shouldSkipGridNavigation(event.key, event.target, {
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    })
  ) {
    return;
  }
  // Every row-wise move, resolved by INDEX against the population, before the
  // DOM walk gets to answer it from the painted rows. A `false` here is "this
  // key moves no row" (a within-row move, or a real population edge), which is
  // exactly what the walk below handles.
  if (windowedRows && moveToWindowedRow(event, windowedRows)) {
    return;
  }
  const nextCell = resolveNextGridCell(event.currentTarget, event.key, {
    ctrlKey: event.ctrlKey,
    homeEndByRow,
  });
  if (!nextCell) {
    // At an edge: leave the key alone so it keeps its native meaning (e.g.
    // scrolling the container) rather than being silently swallowed.
    return;
  }
  // Claimed even when it resolves to the cell already focused (Home on a row's
  // first cell), or the host would scroll away from the grid being navigated.
  event.preventDefault();
  if (nextCell === event.currentTarget) {
    return;
  }
  nextCell.focus();
  const nextRowId =
    nextCell.closest<HTMLElement>(GRID_ROW_SELECTOR)?.dataset.gridRowId;
  if (nextRowId && onKeyboardNavigate) {
    onKeyboardNavigate(nextRowId, event);
  } else {
    // No navigation callback wired: the prototype's "selection follows focus"
    // fallback, which reaches the row's own `onClick`. Preserved so a caller
    // that wires only `onRowClick` keeps the behavior it has today.
    nextCell.click();
  }
}

/**
 * Row-selection keys (ISS-8067). `Shift+Arrow` needs nothing here — it is an
 * ordinary navigation move whose event already carries `shiftKey` through to
 * the host's `onRowKeyboardNavigate`, which is where the range is resolved.
 * These are the two keys that move NO focus and so had no route at all.
 *
 * `Space` is the multi-select convention APG spells for a list of selectable
 * items ("changes the selection state of the focused option"); `Ctrl/Cmd+A` is
 * the grid pattern's own select-all. Both are row-scoped rather than cell-
 * scoped because this grid selects rows, not cells.
 */
const GridSelectionKey = {
  SelectAll: "a",
  ToggleRow: " ",
} as const;

export type GridSelectionHandlers = {
  /**
   * Select every row the grid currently LISTS — which on a windowed body is
   * more than it has painted (ISS-12288).
   */
  onSelectAllRows?: () => void;
  /** Flip the focused row's selection, leaving the rest of the selection alone. */
  onToggleRowSelection?: (rowId: string) => void;
};

/**
 * Returns whether the key was consumed, so the caller's navigation path bails.
 *
 * THE COLLISION BOUNDARY IS ONE TEST: a selection key belongs to the grid only
 * while the CELL ITSELF holds focus. `keydown` targets the focused element, so
 * `target !== cell` means the user has entered the cell's content (the model in
 * `enterGridCell` above), and there `Space` must type a space in a field or
 * press the button it is on, and `Ctrl+A` must select that field's text. Making
 * that the first check — before the key is even looked at — is what keeps the
 * two models from ever both claiming a keypress.
 */
function handleGridSelectionKeyDown<E extends GridCellKeyEvent>(
  event: E,
  handlers: GridSelectionHandlers
): boolean {
  const cell = event.currentTarget;
  if (event.target !== cell || event.altKey) {
    return false;
  }
  if (event.key === GridSelectionKey.ToggleRow) {
    // Bare `Space` only. A modified one belongs to the browser or the OS —
    // `Cmd+Space` is Spotlight, and neither chord has a grid meaning here.
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      return false;
    }
    const rowId = cell.closest<HTMLElement>("[data-grid-row]")?.dataset
      .gridRowId;
    if (!(rowId && handlers.onToggleRowSelection)) {
      return false;
    }
    // Claimed before the host runs, so the page never scrolls out from under a
    // grid the user is selecting in.
    event.preventDefault();
    handlers.onToggleRowSelection(rowId);
    return true;
  }
  const isSelectAllChord =
    // ISS-7493: what a keydown actually carries on `key` is not constrained by
    // the DOM type — see `normalizedEventKey`. No usable key, no select-all.
    normalizedEventKey(event) === GridSelectionKey.SelectAll &&
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey;
  if (!(isSelectAllChord && handlers.onSelectAllRows)) {
    return false;
  }
  // Otherwise the browser's own select-all runs too and leaves the whole
  // document text-selected behind the grid's row selection.
  event.preventDefault();
  handlers.onSelectAllRows();
  return true;
}

/** Where a cell sits in its grid, or `null` when it is not in one. */
function locateGridCell(
  cell: HTMLElement,
  gridBody: HTMLElement | null
): GridCellPosition | null {
  const row = cell.closest<HTMLElement>(GRID_ROW_SELECTOR);
  if (!(row && gridBody)) {
    return null;
  }
  const rowIndex = Array.from(
    gridBody.querySelectorAll<HTMLElement>(GRID_ROW_SELECTOR)
  ).indexOf(row);
  const columnIndex = Array.from(
    row.querySelectorAll<HTMLElement>(GRID_CELL_SELECTOR)
  ).indexOf(cell);
  if (rowIndex === -1 || columnIndex === -1) {
    return null;
  }
  return { rowIndex, columnIndex };
}

/**
 * The cell to hand focus to after the entered cell's own row was removed: the
 * same column of whichever row now occupies that index, clamped to the rows and
 * columns that are actually left. Deleting the last row therefore lands on the
 * new last row rather than falling off the end, and deleting the only row
 * returns `null` so the caller leaves focus alone rather than inventing a
 * destination in an empty grid.
 */
function findSurvivingGridCell(entry: {
  gridBody: HTMLElement | null;
  position: GridCellPosition | null;
}): HTMLElement | null {
  const { gridBody, position } = entry;
  if (!gridBody?.isConnected) {
    return null;
  }
  const rows = Array.from(
    gridBody.querySelectorAll<HTMLElement>(GRID_ROW_SELECTOR)
  );
  const row = rows[clampIndex(position?.rowIndex ?? 0, rows.length)];
  if (!row) {
    return null;
  }
  const cells = Array.from(
    row.querySelectorAll<HTMLElement>(GRID_CELL_SELECTOR)
  );
  return cells[clampIndex(position?.columnIndex ?? 0, cells.length)] ?? null;
}

/** An index held inside `[0, length - 1]`, or `-1` when there is nothing left. */
function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length - 1);
}

/**
 * Expand/collapse for a grid whose rows own child rows (ISS-8921). Undefined for
 * every grid that does not, which leaves `ArrowRight`/`ArrowLeft` their column
 * meaning untouched — the same "not my key" convention {@link
 * GridSelectionHandlers} uses.
 */
export type GridRowExpansionHandlers = {
  /** Whether the row owns children at all. A leaf never claims either key. */
  canExpandRow: (rowId: string) => boolean;
  isRowExpanded: (rowId: string) => boolean;
  setRowExpanded: (rowId: string, expanded: boolean) => void;
};

/**
 * The WAI-ARIA APG `treegrid` pattern's `ArrowRight` / `ArrowLeft`, adapted to
 * this grid's cell-focus model.
 *
 * APG spells the keys against a focused ROW ("Right Arrow: if focus is on a
 * collapsed row, expands the row; if focus is on an expanded row … moves focus
 * one cell to the right"). This grid has no row focus — a roving tabindex moves
 * between CELLS — so ONE cell per row stands in for the row, and every other
 * cell keeps the plain grid meaning. Which cell that is belongs to the caller,
 * not to this module: `GridTableV2` wires these handlers onto the identity cell
 * alone, because that is the cell whose disclosure control the user can see, and
 * binding the keys to a cell with no visible affordance would make the row
 * expand from somewhere the reader has no reason to expect.
 *
 * The key is claimed only when it CHANGES something: `ArrowRight` on an already
 * expanded row, and `ArrowLeft` on an already collapsed one, fall through to
 * navigation exactly as APG requires, so a user can still walk out of the
 * identity column in both directions.
 */
function handleGridRowExpansionKeyDown<E extends GridCellKeyEvent>(
  event: E,
  handlers: GridRowExpansionHandlers
): boolean {
  const cell = event.currentTarget;
  // Same collision boundary as the selection keys: inside an entered cell these
  // belong to the control (a text field's caret moves by character).
  if (event.target !== cell || hasAnyModifier(event)) {
    return false;
  }
  const expand = event.key === GridNavigationKey.ArrowRight;
  if (!(expand || event.key === GridNavigationKey.ArrowLeft)) {
    return false;
  }
  const rowId = cell.closest<HTMLElement>(GRID_ROW_SELECTOR)?.dataset.gridRowId;
  if (
    rowId === undefined ||
    !handlers.canExpandRow(rowId) ||
    handlers.isRowExpanded(rowId) === expand
  ) {
    return false;
  }
  event.preventDefault();
  handlers.setRowExpanded(rowId, expand);
  return true;
}

function hasAnyModifier(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

/**
 * A body that paints only a WINDOW of its rows (ISS-12288), for the row-wise
 * moves the DOM walk cannot answer from the painted rows alone.
 *
 * Absent — every grid that paints all of its rows — nothing here runs and the
 * DOM walk is the whole navigation model, exactly as before.
 */
export type GridWindowedRowNavigation<E> = {
  /** Rows in the body, painted or not. */
  rowCount: number;
  /** A row id's index in that population, or `-1` for a row it does not hold. */
  indexOfRow: (rowId: string) => number;
  /**
   * Paint {@link GridWindowedRowDestination.index}, move focus onto it, and
   * report the move the way the DOM-walk path does.
   *
   * The event travels with it because the move is a SELECTION on hosts where
   * selection follows focus, and the modifiers that decide whether it extends a
   * range live on the keypress — a destination resolved now and reported after
   * the row paints would report a chord the user is no longer holding.
   */
  focusRow: (destination: GridWindowedRowDestination, event: E) => void;
};

/** Where a row-wise move through a windowed body lands. */
export type GridWindowedRowDestination = {
  /** Index in the full population. */
  index: number;
  /**
   * `aria-colindex` of the cell to land on — the column the move started in, so
   * a row-wise move keeps its column. `null` when {@link rowEdge} names the
   * landing instead.
   */
  columnIndex: string | null;
  /**
   * Which end of the destination row a grid extreme lands on. `Ctrl+Home` /
   * `Ctrl+End` land on the grid's first/last CELL rather than on whichever
   * column the cursor was in — the same split {@link resolveNextGridCell}
   * makes, stated once so the windowed path cannot drift from it. `null` for
   * every column-preserving move.
   */
  rowEdge: "start" | "end" | null;
};

/**
 * Resolve a row-wise move against the whole population and hand it to the grid,
 * or report that there was no move to make so the caller leaves the key alone.
 */
function moveToWindowedRow<E extends GridCellKeyEvent>(
  event: E,
  windowedRows: GridWindowedRowNavigation<E>
): boolean {
  const cell = event.currentTarget;
  const rowId = cell.closest<HTMLElement>(GRID_ROW_SELECTOR)?.dataset.gridRowId;
  if (rowId === undefined) {
    return false;
  }
  const index = resolveRowWiseDestinationIndex({
    key: event.key,
    modifiers: { ctrlKey: event.ctrlKey },
    rowCount: windowedRows.rowCount,
    rowIndex: windowedRows.indexOfRow(rowId),
  });
  if (index === null) {
    return false;
  }
  const isExtreme =
    event.ctrlKey && isGridRowJumpKey(event.key, { ctrlKey: true });
  event.preventDefault();
  windowedRows.focusRow(
    {
      columnIndex: isExtreme
        ? null
        : cell.getAttribute(ARIA_COLUMN_INDEX_ATTRIBUTE),
      index,
      rowEdge: isExtreme ? resolveExtremeRowEdge(event.key) : null,
    },
    event
  );
  return true;
}

/** Which end of a row `Ctrl+Home` / `Ctrl+End` lands on. */
function resolveExtremeRowEdge(key: string): "start" | "end" {
  return key === GridNavigationKey.Home ? "start" : "end";
}
