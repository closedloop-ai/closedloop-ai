/**
 * `aria-colindex` arithmetic shared by `GridTable` (which numbers the body
 * rows) and `TableGridHeader` (which numbers the header row) — ISS-4672.
 *
 * A CSS-grid table has no implicit column relationships, so a screen reader
 * pairs a body cell with its column header purely by `aria-colindex`. That
 * pairing only holds while BOTH sides number the grid's tracks identically,
 * which is exactly the kind of invariant that rots when each file derives it
 * for itself: a data row that numbered its cells from a different base than the
 * header would resolve each cell against the header one column to its left —
 * silently, with nothing to fail. The numbering therefore lives here once.
 */

/**
 * 1-based `aria-colindex` of the grid's first track, which is also the leading
 * (wide) cell — the header and body both begin numbering here.
 */
export const FIRST_COLUMN_INDEX = 1;

/** `aria-colindex` of the `dataColumnIndex`-th (0-based) data column. */
export function getDataColumnIndex(
  leadColumnIndex: number,
  dataColumnIndex: number
): number {
  return leadColumnIndex + 1 + dataColumnIndex;
}

/**
 * Total tracks a row occupies — the table's `aria-colcount`, and the
 * `aria-colspan` of a group header row that spans the whole table.
 */
export function getColumnCount(
  leadColumnIndex: number,
  dataColumnCount: number
): number {
  return leadColumnIndex + dataColumnCount;
}

/**
 * The props that declare a CSS-grid table, or nothing at all when the caller has
 * not opted in (ISS-4672 / ISS-4761).
 *
 * These four builders exist so an opting-in caller applies ONE spread per
 * element instead of pairing a `role` with an `aria-colindex` by hand at every
 * site. The pairing is the whole contract — an `aria-colindex` on a role-less
 * element is an unsupported attribute, and a `cell` with no index cannot be
 * resolved against its column header — so keeping them in a single object makes
 * "both or neither" structural rather than a convention two edits could break.
 */
export function ariaTableProps(
  enabled: boolean,
  columnCount: number
): { role?: "table"; "aria-colcount"?: number } {
  return enabled ? { role: "table", "aria-colcount": columnCount } : {};
}

/**
 * The `rowgroup` counterpart of {@link ariaTableProps}, for a contiguous section
 * of rows introduced by its own header row — the shape a native `<tbody>` takes.
 * A `table` may own only rows and rowgroups, so a section that carries a header
 * must be one or that header is an orphan child of the table.
 */
export function ariaRowGroupProps(enabled: boolean): { role?: "rowgroup" } {
  return enabled ? { role: "rowgroup" } : {};
}

/** The `row` counterpart of {@link ariaTableProps}. */
export function ariaRowProps(enabled: boolean): { role?: "row" } {
  return enabled ? { role: "row" } : {};
}

/**
 * The `cell` counterpart of {@link ariaTableProps}, for the given 1-based track.
 * `colSpan` is for a cell that spans the whole row (a group-header row, or a
 * narrow card fallback standing in for one row); omit it for a cell occupying a
 * single track.
 */
export function ariaCellProps(
  enabled: boolean,
  colIndex: number,
  colSpan?: number
): { role?: "cell"; "aria-colindex"?: number; "aria-colspan"?: number } {
  if (!enabled) {
    return {};
  }
  return {
    role: "cell",
    "aria-colindex": colIndex,
    ...(colSpan === undefined ? {} : { "aria-colspan": colSpan }),
  };
}

/**
 * The `columnheader` counterpart of {@link ariaTableProps}, for a header cell a
 * caller renders itself (a `trailingCell`, which `TableGridHeader` cannot infer
 * a role, an index, or a name for). `ariaLabel` names a column whose visible
 * label is intentionally empty — without one, every body cell in that track is
 * announced under a blank header.
 */
export function ariaColumnHeaderProps(
  enabled: boolean,
  colIndex: number,
  ariaLabel?: string
): { role?: "columnheader"; "aria-colindex"?: number; "aria-label"?: string } {
  if (!enabled) {
    return {};
  }
  return {
    role: "columnheader",
    "aria-colindex": colIndex,
    ...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel }),
  };
}

/**
 * Marks a purely structural wrapper that sits between a `table` and its rows
 * (a layout or drag-and-drop container) as presentational, so row ownership is
 * unconditional rather than relying on the accessibility tree traversing a
 * generic element (ISS-4761).
 */
export function ariaPresentationProps(enabled: boolean): {
  role?: "presentation";
} {
  return enabled ? { role: "presentation" } : {};
}
