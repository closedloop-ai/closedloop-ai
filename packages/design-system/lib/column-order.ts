/**
 * Generic, domain-agnostic column-order + visibility helpers for the
 * `GridTable` primitive (FEA-4021). Pure functions over string column ids so
 * they can be unit-tested in isolation and shared by any table without pulling
 * a feature slice into the design system.
 *
 * The primitive owns two orthogonal models the caller can persist:
 *  - **order** — a `columnOrder` array of column ids the header renders in.
 *    Callers persist it and pass it back; a column absent from the array falls
 *    back to its natural position, so the model degrades gracefully across
 *    version skew (a newly-added column simply appears at the end).
 *  - **visibility** — a `hiddenColumns` set of ids the table drops entirely
 *    (header track + every cell) in lockstep.
 */

/** Keyboard reorder directions for a focused column drag handle. */
export const ColumnMoveDirection = {
  Left: "left",
  Right: "right",
} as const;
export type ColumnMoveDirection =
  (typeof ColumnMoveDirection)[keyof typeof ColumnMoveDirection];

/**
 * Reorder `columnIds` by moving the column at `fromIndex` to `toIndex`. Both
 * indices are clamped into range, so an out-of-bounds drop (e.g. dragging past
 * the last column) lands at the nearest valid slot instead of dropping the id.
 * Returns a new array; the input is never mutated.
 */
export function moveColumn(
  columnIds: readonly string[],
  fromIndex: number,
  toIndex: number
): string[] {
  const next = [...columnIds];
  const from = clampIndex(fromIndex, next.length);
  const to = clampIndex(toIndex, next.length);
  if (from === to) {
    return next;
  }
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Move the column with id `columnId` one slot in `direction`. A no-op (returns
 * the same order) when the column is already at the corresponding edge or is
 * not present. Powers keyboard reordering: `ArrowLeft`/`ArrowRight` on a
 * focused drag handle.
 */
export function moveColumnByDirection(
  columnIds: readonly string[],
  columnId: string,
  direction: ColumnMoveDirection
): string[] {
  const index = columnIds.indexOf(columnId);
  if (index === -1) {
    return [...columnIds];
  }
  const target =
    direction === ColumnMoveDirection.Left ? index - 1 : index + 1;
  if (target < 0 || target >= columnIds.length) {
    return [...columnIds];
  }
  return moveColumn(columnIds, index, target);
}

/**
 * Order the given columns by a caller-supplied `columnOrder` id list. Columns
 * whose id appears in `columnOrder` are emitted in that order first; any column
 * absent from `columnOrder` (a new column the persisted order predates) keeps
 * its natural position at the end, so an unknown/missing id degrades to a safe
 * default instead of vanishing. When `columnOrder` is omitted the input order
 * is preserved unchanged (byte-identical for callers that never reorder).
 */
export function orderColumns<T extends { id: string }>(
  columns: readonly T[],
  columnOrder?: readonly string[]
): T[] {
  if (!columnOrder || columnOrder.length === 0) {
    return [...columns];
  }
  const byId = new Map(columns.map((column) => [column.id, column]));
  const ordered: T[] = [];
  const seen = new Set<string>();
  for (const id of columnOrder) {
    const column = byId.get(id);
    if (column && !seen.has(id)) {
      ordered.push(column);
      seen.add(id);
    }
  }
  for (const column of columns) {
    if (!seen.has(column.id)) {
      ordered.push(column);
    }
  }
  return ordered;
}

/**
 * Merge a reordered VISIBLE subset back into the complete persisted order.
 *
 * A table that hides or collapses columns hands its header only the currently
 * rendered subset, so the reorder the header emits (`visibleOrder`) omits the
 * hidden ids. Persisting that subset as the whole order would drop the hidden
 * columns' remembered positions — showing one again then appends it at the end.
 *
 * This walks the complete order (`allColumnIds`, every toggleable id in its
 * canonical order) and, at each slot the moved subset occupies, substitutes the
 * next id from `visibleOrder`; hidden ids keep their original slots. Any visible
 * id not already present in `allColumnIds` (a column the persisted order
 * predates) is appended, so the result still covers the full set. Pure; inputs
 * are never mutated.
 */
export function mergeColumnOrder(
  allColumnIds: readonly string[],
  visibleOrder: readonly string[]
): string[] {
  const visibleSet = new Set(visibleOrder);
  const remaining = [...visibleOrder];
  const merged: string[] = [];
  const emitted = new Set<string>();
  for (const id of allColumnIds) {
    // A slot the reordered subset owns takes the next visible id; a hidden
    // (non-visible) slot keeps its own id in place.
    const next = visibleSet.has(id) ? remaining.shift() : id;
    if (next != null && !emitted.has(next)) {
      merged.push(next);
      emitted.add(next);
    }
  }
  // Visible ids the complete order does not yet know about (version skew) land
  // at the end so none are lost.
  for (const id of remaining) {
    if (!emitted.has(id)) {
      merged.push(id);
      emitted.add(id);
    }
  }
  return merged;
}

function clampIndex(index: number, length: number): number {
  if (length === 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, length - 1));
}

/**
 * Keyboard resize directions for a focused column resize handle (FEA-4168).
 * `Shrink` narrows the column, `Grow` widens it; the caller applies a fixed
 * step per keypress.
 */
export const ColumnResizeDirection = {
  Shrink: "shrink",
  Grow: "grow",
} as const;
export type ColumnResizeDirection =
  (typeof ColumnResizeDirection)[keyof typeof ColumnResizeDirection];

/**
 * The floor a resized column width clamps to (px). A drag or keyboard resize
 * can never take a column below this, so a header label + its resize handle
 * always stay grabbable and legible. Shared by the pointer and keyboard paths
 * (and re-exported to callers persisting widths) so both agree on the floor.
 */
export const MIN_COLUMN_WIDTH_PX = 60;

/** Per-keypress width step for keyboard resize (px), a coarse but predictable nudge. */
export const COLUMN_RESIZE_KEYBOARD_STEP_PX = 16;

/**
 * The `md` breakpoint (768px): below this measured container width `GridTable`
 * renders its responsive card list instead of the grid.
 *
 * This is a card-fallback threshold and nothing else. For a table that supplies
 * `cardRender` it happens to also be the narrowest container the grid itself
 * ever renders at, which makes it a useful basis for a column-placement budget —
 * but that is a SEPARATE question with a separate answer, so it gets a separate
 * constant at the caller rather than a second meaning here (ISS-4788; see
 * `SESSIONS_LEGIBLE_COLUMN_BUDGET_PX` in the Sessions table, the one such
 * derivation today). A `GridTable` caller without `cardRender`, or one mounted
 * `mode="expanded"`, renders the grid at any width, so the primitive enforces no
 * floor for it and this constant guarantees it nothing.
 *
 * Kept in sync with the Tailwind `md` breakpoint, and lives here — a
 * dependency-free module — so a test or caller can read it without importing
 * the component tree.
 */
export const CARD_FALLBACK_BREAKPOINT = 768;

/**
 * Clamp a proposed column width (px) to the shared floor. A width below
 * {@link MIN_COLUMN_WIDTH_PX} (from a fast drag past the label, or repeated
 * keyboard shrink) lands at the floor instead of collapsing the column; a
 * non-finite value (NaN from a bad pointer delta) also degrades to the floor.
 * Pure; returns a whole-pixel integer so the persisted value is stable.
 */
export function clampColumnWidth(widthPx: number): number {
  if (!Number.isFinite(widthPx)) {
    return MIN_COLUMN_WIDTH_PX;
  }
  return Math.max(MIN_COLUMN_WIDTH_PX, Math.round(widthPx));
}

/**
 * Apply a keyboard resize step to `currentWidthPx` in `direction`, clamped to
 * the shared floor (FEA-4168). `Shrink` subtracts, `Grow` adds
 * {@link COLUMN_RESIZE_KEYBOARD_STEP_PX}. Powers `ArrowLeft`/`ArrowRight` on a
 * focused resize handle. Pure.
 */
export function resizeColumnByDirection(
  currentWidthPx: number,
  direction: ColumnResizeDirection
): number {
  const delta =
    direction === ColumnResizeDirection.Shrink
      ? -COLUMN_RESIZE_KEYBOARD_STEP_PX
      : COLUMN_RESIZE_KEYBOARD_STEP_PX;
  return clampColumnWidth(currentWidthPx + delta);
}

/**
 * Merge a caller's persisted per-column widths (px, keyed by column id) over a
 * base map of natural widths (FEA-4168). Only entries whose id is a known
 * column survive, so a stale/unknown id from an older saved view cannot inject a
 * phantom track; a known id with a bad (non-finite/too-small) width is clamped
 * to the floor. Returns a new record; inputs are never mutated. A caller with no
 * persisted widths passes `undefined` and gets the base map back unchanged.
 */
export function applyColumnWidths(
  naturalWidths: Readonly<Record<string, number>>,
  persistedWidths?: Readonly<Record<string, number>>
): Record<string, number> {
  const merged: Record<string, number> = { ...naturalWidths };
  if (!persistedWidths) {
    return merged;
  }
  for (const [id, width] of Object.entries(persistedWidths)) {
    if (id in merged) {
      merged[id] = clampColumnWidth(width);
    }
  }
  return merged;
}

/**
 * Splice every canonical column id MISSING from a persisted order back in at its
 * canonical neighbourhood, leaving the ids the user did arrange in exactly the
 * relative order they arranged them.
 *
 * {@link orderColumns} emits the persisted ids first and appends anything the
 * persisted order predates at the END. That is the safe degradation for an id
 * nobody has an opinion about, but it is the wrong one for a NEW column shipping
 * into an existing product: a saved `columnOrder` written before the column
 * existed lists every OTHER id, so the new column lands last for every user who
 * has ever dragged a header — precisely the users most likely to notice it is in
 * the wrong place, and the ones least likely to be looking at the far right of a
 * table that already overflows.
 *
 * Placement is RELATIVE, not by index: each missing id lands immediately after
 * the last of its canonical predecessors that actually survives in the user's
 * order, so a user who moved the neighbouring columns still gets the new one next
 * to the columns it belongs with rather than at an index computed against an
 * arrangement they do not have. When none of its predecessors survive it goes to
 * the FRONT — every remaining id is one the canonical order ranks after it, so
 * leading is the only placement consistent with what is actually there. Missing
 * ids are resolved in canonical order, so two columns arriving together keep
 * their canonical order relative to each other.
 *
 * Opt-in, and deliberately not folded into `orderColumns`: a table that WANTS a
 * new column at the end (an append-only audit column, say) keeps that behavior by
 * not calling this. An empty `columnOrder` — the "no persisted order, use the
 * natural one" convention — is returned untouched, since the natural order
 * already has every column in its canonical slot.
 *
 * Pure; inputs are never mutated.
 */
export function withMissingColumnsAtCanonicalSlots(
  canonicalOrder: readonly string[],
  columnOrder: readonly string[]
): string[] {
  const next = [...columnOrder];
  if (next.length === 0) {
    return next;
  }
  const persisted = new Set(columnOrder);
  for (const [canonicalIndex, id] of canonicalOrder.entries()) {
    if (persisted.has(id)) {
      continue;
    }
    const predecessors = new Set(canonicalOrder.slice(0, canonicalIndex));
    next.splice(lastIndexOfAny(next, predecessors) + 1, 0, id);
    persisted.add(id);
  }
  return next;
}

/** Index of the LAST entry of `ids` present in `candidates`, or -1 when none is. */
function lastIndexOfAny(
  ids: readonly string[],
  candidates: ReadonlySet<string>
): number {
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    if (candidates.has(ids[index])) {
      return index;
    }
  }
  return -1;
}
