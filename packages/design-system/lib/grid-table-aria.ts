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

/**
 * The accessible name a data-column header cell carries, for the v1 and v2
 * headers alike (ISS-9446 follow-up).
 *
 * A column that renders no visible label — the row-actions / chrome column every
 * dense table ends with — would otherwise become a nameless `columnheader` that
 * each body cell in its track is announced against, so its declared `ariaLabel`
 * names it. A column WITH a visible label returns `undefined`: its text is
 * already the accessible name, and an `aria-label` there would silently override
 * what the user can see (WCAG 2.5.3).
 *
 * Blankness is decided by `trim()`, matching how the column registry's
 * `MissingAccessibleName` rule decides which columns OWE an `ariaLabel` — a
 * whitespace-only label renders nothing, so the two halves of that rule have to
 * agree about it or the validator demands a name the header then discards.
 *
 * A blank-label column falls back to its id through
 * {@link resolveColumnControlName}, so the cell and the controls inside it
 * cannot end up called different things. The registry refuses a blank label
 * with no `ariaLabel`, but `GridTableV2` is a public component a host may call
 * without one, and a nameless `columnheader` is what every body cell in that
 * track is then announced against — an ugly unique name beats no name.
 */
export function resolveColumnHeaderAriaLabel(
  label: string,
  columnId: string,
  ariaLabel?: string
): string | undefined {
  if (label.trim() !== "") {
    return undefined;
  }
  return resolveColumnControlName(label, columnId, ariaLabel);
}

/**
 * What a per-column CONTROL calls its column — the column-options button, the
 * resize handle — as opposed to what the header cell announces.
 *
 * These names are built by interpolation ("<name> column options"), so a blank
 * label yields a control named " column options": present, operable, and
 * unattributable to any column when several are on screen. The declared
 * `ariaLabel` is the intended name; the column id is the last resort, ugly but
 * unique, and better than a name that identifies nothing.
 *
 * Distinct from {@link resolveColumnHeaderAriaLabel}, which returns `undefined`
 * for a labelled column BECAUSE the visible text is already that element's name.
 * A control has no such text to inherit, so this one always resolves to a
 * string.
 */
export function resolveColumnControlName(
  label: string,
  columnId: string,
  ariaLabel?: string
): string {
  if (label.trim() !== "") {
    return label;
  }
  return ariaLabel?.trim() ? ariaLabel : columnId;
}

/**
 * Every per-track fact a grid's header, body and pin read, answered from ONE
 * description of its leading tracks.
 *
 * Each layer used to answer "is there a utility track" for itself, off
 * whichever prop it held — the body off `renderLeadingUtility`, the header off
 * the utility cell NODE. Those are different props, so a caller supplying one
 * without the other made the two runs number the same grid from different
 * bases, pairing every body cell with the header one track to its left.
 */
type GridColumnTracksBase = {
  readonly leadColumnIndex: number;
  /** The table's `aria-colcount`, and a full-width cell's `aria-colspan`. */
  readonly columnCount: number;
  /** `aria-colindex` of the `index`-th data column, for `0 <= index < count`. */
  readonly dataColumnIndex: (index: number) => number;
  /**
   * `aria-colindex` of the caller-owned trailing track, or `undefined` when
   * there is none. Carried here rather than reached by calling
   * {@link GridColumnTracksBase.dataColumnIndex} past its last data column,
   * which would ask that function a question outside its own domain.
   */
  readonly trailingColumnIndex: number | undefined;
};

/**
 * A union rather than a `boolean` beside an optional index, so the two cannot
 * contradict each other: `hasLeadingUtility: true` with no utility index would
 * put `role="columnheader"` on a header cell carrying no `aria-colindex`, which
 * is the unresolvable pairing this module exists to prevent. Narrowing on
 * `hasLeadingUtility` also hands a consumer a plain `number`.
 */
export type GridColumnTracks =
  | (GridColumnTracksBase & {
      readonly hasLeadingUtility: true;
      readonly leadingUtilityColumnIndex: number;
    })
  | (GridColumnTracksBase & {
      readonly hasLeadingUtility: false;
      readonly leadingUtilityColumnIndex: undefined;
    });

/**
 * Resolve a grid's track numbering once, for every layer to read. A compositor
 * owning both the header and the body resolves `hasLeadingUtility` from both
 * halves and hands the result down, so the two cannot disagree about which
 * track the identity column occupies.
 *
 * `hasTrailingTrack` covers a caller-owned track after the data columns (an
 * add-field slot): it carries no index here but occupies a real track, so
 * omitting it publishes an `aria-colcount` a trailing cell's own index exceeds.
 */
export function resolveGridColumnTracks({
  hasLeadingUtility,
  dataColumnCount,
  hasTrailingTrack = false,
}: {
  hasLeadingUtility: boolean;
  dataColumnCount: number;
  hasTrailingTrack?: boolean;
}): GridColumnTracks {
  const leadColumnIndex = hasLeadingUtility
    ? FIRST_COLUMN_INDEX + 1
    : FIRST_COLUMN_INDEX;
  const dataColumnIndex = (index: number) =>
    getDataColumnIndex(leadColumnIndex, index);
  const base: GridColumnTracksBase = {
    leadColumnIndex,
    columnCount: getColumnCount(
      leadColumnIndex,
      dataColumnCount + (hasTrailingTrack ? 1 : 0)
    ),
    dataColumnIndex,
    trailingColumnIndex:
      hasTrailingTrack ? dataColumnIndex(dataColumnCount) : undefined,
  };
  return hasLeadingUtility
    ? {
        ...base,
        hasLeadingUtility: true,
        leadingUtilityColumnIndex: FIRST_COLUMN_INDEX,
      }
    : { ...base, hasLeadingUtility: false, leadingUtilityColumnIndex: undefined };
}

/** The selected-state suffix is shared; each domain still supplies the row name. */
export function formatGridCardSelectionLabel(
  label: string,
  selected: boolean
): string {
  return `${label}${selected ? ", selected" : ""}`;
}
