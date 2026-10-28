import {
  filterValidColumnOrder,
  filterValidColumnWidths,
  mergePreservedColumnIds,
  NO_PRESERVED_COLUMN_IDS,
  type PreservedColumnIds,
  partitionPreservedColumnIds,
} from "../lib/preserved-column-ids";
import type { RestoredTableView } from "./use-persisted-table-view-state";

/**
 * A stored view after normalization: the exact values the state slices of
 * `usePersistedTableViewState` hold, so the same object can be applied AND
 * serialized (ISS-9568). Pure companions to that hook, split out so the hook
 * file carries the effects and this file the codec.
 */
export type StoredViewSnapshot<
  TSort,
  TSortDir,
  TColumnId extends string,
  TExtra,
> = {
  sortKey: TSort;
  sortDir: TSortDir;
  extras: TExtra;
  hiddenColumns: Set<TColumnId>;
  columnOrder: string[];
  columnWidths: Record<string, number>;
  /**
   * The ids this build has no column for, split out by the same read that
   * produced the applied halves above (ISS-9447 D1) and folded back by
   * {@link serializeTableView}. Carrying them ON the snapshot is what keeps a
   * cross-tab adoption from erasing a sibling tab's newer columns: the adopting
   * tab holds them without drawing them, and puts them back on its next write.
   */
  preservedColumnIds: PreservedColumnIds;
  pageSize: number;
};

/**
 * Coerce a stored view to what this table can actually hold. One function for
 * the mount-time restore AND a cross-tab adoption, so the two cannot drift on
 * which ids survive, which ids are carried, or what an absent page size means.
 */
export function normalizeStoredTableView<
  TSort,
  TSortDir,
  TColumnId extends string,
  TExtra,
>(
  saved: RestoredTableView<TSort, TSortDir, TExtra>,
  validColumnIds: ReadonlySet<string>,
  defaultPageSize: number,
  isWidthOnlyColumnId?: (id: string) => boolean
): StoredViewSnapshot<TSort, TSortDir, TColumnId, TExtra> {
  return {
    sortKey: saved.sortKey,
    sortDir: saved.sortDir,
    extras: saved.extras,
    hiddenColumns: new Set<TColumnId>(
      saved.hiddenColumns.filter((id): id is TColumnId =>
        validColumnIds.has(id)
      )
    ),
    columnOrder: filterValidColumnOrder(saved.columnOrder, validColumnIds),
    columnWidths: filterValidColumnWidths(
      saved.columnWidths,
      validColumnIds,
      isWidthOnlyColumnId
    ),
    preservedColumnIds: partitionPreservedColumnIds(
      saved,
      validColumnIds,
      isWidthOnlyColumnId
    ),
    // ISS-9692: a view written before this field existed carries no page size,
    // which is not "the user chose the default" — it is "nothing was stored",
    // so the feature's default stands.
    pageSize: saved.pageSize ?? defaultPageSize,
  };
}

/**
 * The one serialization of a table view, used by the persist effect and by the
 * cross-tab adoption that records what it adopted. Spread the feature `extras`
 * FIRST, then the reserved canonical keys, so an `extras` blob that happens to
 * carry a `sortKey`/`sortDir`/`hiddenColumns`/`columnOrder`/`columnWidths`/
 * `pageSize` key can never clobber the real view state on serialization
 * (reserved keys always win). The carried ids are folded back HERE, so the
 * bytes an adoption records are the bytes the persist effect would compute from
 * the state that adoption just applied. `pageSize` is the value to WRITE,
 * already resolved by the caller against the ISS-9692 gate — this module reads
 * no flag.
 *
 * ISS-9449: `null` when the record would exceed
 * {@link MAX_SERIALIZED_TABLE_VIEW_LENGTH}. This answers for the exact view it
 * was given; callers that can shed something go through
 * {@link serializeTableViewWithinCeiling}.
 */
export function serializeTableView<
  TSort,
  TSortDir,
  TExtra extends Record<string, unknown>,
>(view: SerializableTableView<TSort, TSortDir, TExtra>): string | null {
  const stored = mergePreservedColumnIds(
    {
      columnOrder: view.columnOrder,
      columnWidths: view.columnWidths,
      hiddenColumns: view.hiddenColumns,
    },
    view.preservedColumnIds
  );
  // Typed against the key tuple so a new reserved axis cannot be added here
  // without `opaqueStoredViewFields` learning to subtract it — which would
  // otherwise carry the new axis as residue AND write it, on every record.
  // Written in the order the bytes have always had, which the cross-tab suite
  // pins: reordering it would rewrite every stored record for no gain.
  const reserved: Record<ReservedStoredViewKey, unknown> = {
    sortKey: view.sortKey,
    sortDir: view.sortDir,
    hiddenColumns: stored.hiddenColumns,
    columnOrder: stored.columnOrder,
    columnWidths: stored.columnWidths,
    pageSize: view.pageSize,
  };
  // The opaque residue goes FIRST, under both the feature `extras` and the
  // reserved keys: it is a record of what this build could not name, so it may
  // never win against an axis this build actually holds.
  const serialized = JSON.stringify({
    ...view.opaqueFields,
    ...view.extras,
    ...reserved,
  });
  if (serialized.length > MAX_SERIALIZED_TABLE_VIEW_LENGTH) {
    return null;
  }
  return serialized;
}

/**
 * The bytes the persist effect writes: the view as it stands, or — when that
 * would exceed the ceiling — the view with its carried ids dropped, then with
 * its width-only widths dropped too, or `null` when even that does not fit
 * (ISS-9449).
 *
 * The carried ids go first. The brief that set the carry cap named them the
 * droppable half of a stored arrangement ("drop the oldest-carried ids past
 * the cap, never a recognized id"): they name columns no current build draws.
 * With the per-axis cap in force a carry reaches the ceiling only through
 * pathologically LONG ids, never through their count — which is exactly the
 * record this rung exists for.
 *
 * The width-only widths go next (tamsinb, PR #8117). Their cap bounds how
 * MANY apply, not how long their ids are, so without this rung a feature whose
 * `isWidthOnlyColumnId` admits long ids could refuse every write. Shed from
 * the bytes only: the widths on screen stay. A declared column's width and an
 * `extras` value are never shed.
 *
 * A `null` from here means `extras` or the opaque residue alone are past the
 * ceiling — every other axis is bounded before it reaches this point: hidden
 * ids and declared widths by `declaredColumnIds`, the applied order by
 * {@link filterValidColumnOrder}'s dedupe, the carry by the per-axis cap and
 * the width-only widths by the rungs above, so none of them can be made long
 * enough to reach the ceiling. Nothing in this module can shrink `extras`
 * without discarding what the reader chose, and the residue is a newer build's
 * axis this one has no standing to trim at all, so the caller refuses the
 * write and leaves disk as it was: a corruption backstop, reachable by no
 * build's own output.
 */
export function serializeTableViewWithinCeiling<
  TSort,
  TSortDir,
  TExtra extends Record<string, unknown>,
>(
  view: SerializableTableView<TSort, TSortDir, TExtra>,
  declaredColumnIds: ReadonlySet<string>
): string | null {
  const withoutCarry = { ...view, preservedColumnIds: NO_PRESERVED_COLUMN_IDS };
  return (
    serializeTableView(view) ??
    serializeTableView(withoutCarry) ??
    serializeTableView({
      ...withoutCarry,
      columnWidths: filterValidColumnWidths(
        view.columnWidths,
        declaredColumnIds
      ),
    })
  );
}

/**
 * The most UTF-16 code units one stored table view may occupy (ISS-9449).
 *
 * A view carries three axes of at most 64 carried ids (the per-axis cap in
 * `preserved-column-ids.ts`) beside its own arrangement and the feature
 * `extras`, all of which fit in a few kilobytes — except Sessions' custom-field
 * widths, which at the 500-field limit stay under 40,000 units (ISS-10356) —
 * while the browser's per-origin quota is measured in megabytes. Anything near this ceiling is a runaway
 * record, and the persist effect refuses to write it rather than letting it
 * grow until the quota swallow hides the failure.
 */
export const MAX_SERIALIZED_TABLE_VIEW_LENGTH = 64 * 1024;

type SerializableTableView<
  TSort,
  TSortDir,
  TExtra extends Record<string, unknown>,
> = {
  extras: TExtra;
  sortKey: TSort;
  sortDir: TSortDir;
  hiddenColumns: Iterable<string>;
  columnOrder: readonly string[];
  columnWidths: Record<string, number>;
  preservedColumnIds: PreservedColumnIds;
  pageSize: number;
  /**
   * ISS-9450: the top-level fields of the record this view was restored from
   * that this build does not write — see {@link opaqueStoredViewFields}.
   * Required, not optional, so every serialization site has to answer for the
   * carry rather than silently drop it.
   */
  opaqueFields: Record<string, unknown>;
};

/**
 * The top-level keys {@link serializeTableView} always writes. Stated once so
 * the serializer and {@link opaqueStoredViewFields} cannot disagree about what
 * counts as a field this build owns.
 */
const RESERVED_STORED_VIEW_KEYS = [
  "columnOrder",
  "columnWidths",
  "hiddenColumns",
  "pageSize",
  "sortDir",
  "sortKey",
] as const;

type ReservedStoredViewKey = (typeof RESERVED_STORED_VIEW_KEYS)[number];

const RESERVED_STORED_VIEW_KEY_SET: ReadonlySet<string> = new Set(
  RESERVED_STORED_VIEW_KEYS
);

/** A view restored from nothing carries no residue. */
export const NO_OPAQUE_STORED_VIEW_FIELDS: Record<string, unknown> =
  Object.freeze(Object.create(null));

/**
 * The top-level fields of a stored record that this build would NOT write back:
 * neither a reserved view axis nor a key the feature's parser lifted into
 * `extras`. A whole axis added by a newer build lands here.
 *
 * Carried unread and folded back by {@link serializeTableView} — the same
 * contract `preservedColumnIds` already holds one level down, for column ids
 * this build has no column for. Without it, a feature parser's `z.object`
 * strips the unknown field on restore and the persist effect writes the
 * stripped record straight back, so merely OPENING a page on an older build
 * destroys the axis (ISS-9447 M2 says exactly this about `columnWidths`, and
 * worked around it by declaring the field). ISS-9450 makes that fatal rather
 * than local: the same stripped record is now published to the ACCOUNT copy, so
 * one older client deletes the axis for every device.
 *
 * Accumulated with a null prototype: these keys come from `localStorage` and
 * from a server row, and `JSON.parse` makes `__proto__` an own property.
 */
export function opaqueStoredViewFields(
  raw: unknown,
  extras: Record<string, unknown>
): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return NO_OPAQUE_STORED_VIEW_FIELDS;
  }
  const carried: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    if (
      !(RESERVED_STORED_VIEW_KEY_SET.has(key) || Object.hasOwn(extras, key))
    ) {
      carried[key] = value;
    }
  }
  return carried;
}
