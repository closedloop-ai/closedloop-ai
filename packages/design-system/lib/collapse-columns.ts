/**
 * Generic constant/empty column collapse (FEA-3968).
 *
 * Generalizes the rule FEA-3945/3946 established for the My Issues table
 * (`packages/app/documents/components/table/column-collapse.ts`) into a
 * domain-agnostic helper that any table can reuse: given the visible columns,
 * the visible rows, and a per-cell value extractor, drop the columns whose
 * value conveys no information across the whole page.
 *
 * A column is dropped when, across every visible row, its value is either:
 *  - **empty** on every row (nothing to show), or
 *  - **constant** on every row (the same value repeated down the column —
 *    "Manual" on every Loop, "Open" on every Branch, "Tool" on every Agent).
 *
 * Both rules read the value through the caller's extractor, so the helper never
 * knows about the domain — it only compares stable string keys (or the empty
 * sentinel). A column with no extractor entry reads as the empty sentinel on
 * every row: under the constant-only mode every real caller here uses
 * (`collapseEmptyColumns: false`) that keeps it, so a new or unknown column
 * never silently disappears. It is dropped ONLY under the empty rule (the
 * `collapseEmptyColumns: true` default), so a caller that opts into the empty
 * rule must give every column an extractor entry.
 *
 * This is deliberately a pure function over generic columns and rows so it can
 * be shared by the `DataTable` (Loops) and `GridTable` (Branches, Agents)
 * primitives without pulling any feature slice into the design system.
 */

/**
 * Sentinel for "no value in this cell" — distinct from any real string key so
 * an all-empty column is detected as empty rather than as a constant
 * empty-string value.
 */
export const COLLAPSE_EMPTY = Symbol("collapse-empty");

/** Stable per-cell identity: a string key, or the empty sentinel. */
export type CollapseCellKey = string | typeof COLLAPSE_EMPTY;

/**
 * Per-cell value extractor. Returns `COLLAPSE_EMPTY` when the column renders
 * nothing for this row, or a stable string key identifying the rendered value
 * so two rows with the same value collapse together. Returning `null`/
 * `undefined` is treated as `COLLAPSE_EMPTY` for caller convenience.
 */
export type CollapseKeyExtractor<Item> = (
  columnId: string,
  item: Item
) => CollapseCellKey | null | undefined;

/**
 * Minimum number of rows for the *constant* rule. A single row is trivially
 * "constant", so collapsing a one-row page would hide a column that is only
 * incidentally uniform. Empty columns still collapse at any row count.
 */
const CONSTANT_RULE_MIN_ROWS = 2;

function normalizeKey(
  key: CollapseCellKey | null | undefined
): CollapseCellKey {
  return key == null ? COLLAPSE_EMPTY : key;
}

function isEmptyForAllRows<Item>(
  columnId: string,
  items: readonly Item[],
  getKey: CollapseKeyExtractor<Item>
): boolean {
  return items.every(
    (item) => normalizeKey(getKey(columnId, item)) === COLLAPSE_EMPTY
  );
}

function isConstantAcrossRows<Item>(
  columnId: string,
  items: readonly Item[],
  getKey: CollapseKeyExtractor<Item>
): boolean {
  const first = normalizeKey(getKey(columnId, items[0]));
  // An all-empty column is NOT "constant" here — that is the empty rule's job
  // (gated by `collapseEmptyColumns`). Treating it as constant would collapse a
  // column with no extractor entry (which returns the empty sentinel for every
  // row) even when the caller disabled the empty rule.
  if (first === COLLAPSE_EMPTY) {
    return false;
  }
  return items.every((item) => normalizeKey(getKey(columnId, item)) === first);
}

/**
 * Options shared by {@link shouldCollapseColumn} and
 * {@link collapseConstantColumns}.
 */
export type CollapseColumnsOptions = {
  /**
   * Also collapse a column that is *empty* on every visible row, at any row
   * count (default `true` — matches the My-Issues optional-column behavior).
   * Set `false` to collapse ONLY when a column is *constant* across two or more
   * rows, so a single filtered row never drops a column that merely lacks a
   * value on that one row (the Loops/Branches/Agents data tables use this).
   */
  collapseEmptyColumns?: boolean;
};

/**
 * Whether a single column should be dropped for the given visible rows. The
 * constant rule (identical value on every row) needs at least two rows — a
 * single row is trivially constant. The empty rule (nothing on every row) fires
 * at any row count unless `collapseEmptyColumns` is `false`.
 */
export function shouldCollapseColumn<Item>(
  columnId: string,
  items: readonly Item[],
  getKey: CollapseKeyExtractor<Item>,
  options?: CollapseColumnsOptions
): boolean {
  if (items.length === 0) {
    return false;
  }
  const collapseEmpty = options?.collapseEmptyColumns ?? true;
  if (collapseEmpty && isEmptyForAllRows(columnId, items, getKey)) {
    return true;
  }
  return (
    items.length >= CONSTANT_RULE_MIN_ROWS &&
    isConstantAcrossRows(columnId, items, getKey)
  );
}

/**
 * Drop the columns whose value is constant or empty across every visible row.
 * `getKey` is the per-cell extractor; a column whose extractor returns the same
 * key (or the empty sentinel) for every row is dropped. Columns keep their
 * original order. With no rows nothing is collapsed (there is nothing to read).
 *
 * Works on any `{ id }` column descriptor. `GridTable` callers pass their
 * `{ id, width }` column specs so the column AND its grid track drop in lockstep
 * (the header, rows, and CSS grid template stay aligned); `DataTable` callers
 * pass their `Column[]` directly. `keepColumnIds` protects columns that must
 * never collapse regardless of value (e.g. an always-shown "Autonomy" column,
 * the "actions" column, or the active sort column so the header that reverses
 * the sort can never vanish); `options.collapseEmptyColumns` toggles the empty
 * rule. Under the constant-only mode (`collapseEmptyColumns: false`) a column
 * with no extractor entry is always kept; under the empty-rule default an
 * unmapped column collapses (see the module header).
 */
export function collapseConstantColumns<Column extends { id: string }, Item>(
  columns: readonly Column[],
  items: readonly Item[],
  getKey: CollapseKeyExtractor<Item>,
  keepColumnIds?: ReadonlySet<string>,
  options?: CollapseColumnsOptions
): Column[] {
  if (items.length === 0) {
    return [...columns];
  }
  return columns.filter(
    (column) =>
      keepColumnIds?.has(column.id) ||
      !shouldCollapseColumn(column.id, items, getKey, options)
  );
}
