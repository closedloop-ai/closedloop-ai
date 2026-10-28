import { MAX_CUSTOM_FIELDS_PER_ORG } from "@repo/api/src/types/custom-field";
import { isUsableColumnWidth } from "./column-width";

/**
 * The half of a stored column arrangement this build has no column for.
 *
 * ISS-9447 D1: an unrecognized column id is PRESERVED — not applied, not
 * erased. It is held here, apart from the applied state, and merged back when
 * the arrangement is written, so a reader who arranged their columns on one
 * build does not lose that arrangement by opening the surface on another.
 *
 * Apart, rather than inline, because the applied hidden set is a
 * `Set<TColumnId>`: widening it to carry these would let an id the table cannot
 * draw reach the render path, which is the one thing filtering got right.
 */
export type PreservedColumnIds = {
  hiddenColumns: readonly string[];
  columnOrder: readonly string[];
  columnWidths: Readonly<Record<string, number>>;
};

/**
 * The "nothing to carry" value, shared so a restore that recognizes every
 * stored id yields a stable identity instead of a fresh object each run.
 */
export const NO_PRESERVED_COLUMN_IDS: PreservedColumnIds = Object.freeze({
  columnOrder: Object.freeze<string[]>([]),
  columnWidths: Object.freeze({}),
  hiddenColumns: Object.freeze<string[]>([]),
});

type StoredColumnArrangement = {
  hiddenColumns?: readonly string[];
  columnOrder?: readonly string[];
  columnWidths?: Readonly<Record<string, number>>;
};

/**
 * Keep only entries whose id is a known column (or a width-only one, ISS-10356)
 * and whose width {@link isUsableColumnWidth} accepts (FEA-4168) — the APPLIED
 * half of a stored `columnWidths`.
 *
 * Its complement is not simply "everything else": {@link
 * partitionPreservedColumnIds} carries an unknown id's width across only when
 * the width itself is well-formed. A malformed width is corrupt data, not
 * version skew, and writing it back would persist a bad value under the
 * pretense of forward compatibility.
 */
export function filterValidColumnWidths(
  widths: Readonly<Record<string, number>> | undefined,
  validColumnIds: ReadonlySet<string>,
  isWidthOnlyColumnId: (id: string) => boolean = noWidthOnlyColumnIds
): Record<string, number> {
  const usable = Object.entries(widths ?? {}).filter(([, width]) =>
    isUsableColumnWidth(width)
  );
  // ISS-10356: a width-only id is open-ended (Sessions' `custom-field:<uuid>`)
  // where `validColumnIds` is closed, so it needs a count cap: a corrupt record
  // could otherwise apply any number of widths. The cap bounds their COUNT, not
  // their bytes: Sessions' predicate bounds an id's length, and past the write
  // ceiling `serializeTableViewWithinCeiling` sheds these widths whatever the
  // predicate (tamsinb, PR #8117). Not the carry's cap, which bounds version
  // skew: this one is every custom field an org may define (AC-017), so a
  // layout of live fields never reaches it (whitlockk, PR #8117). Only widths of
  // deleted fields, which keep the prefix, can push past it, and then the
  // widths resized longest ago go first — the carry's "drop the oldest"
  // (ISS-9449), with age read as resize recency ({@link resizeColumnWidth}).
  // Best-effort: the account copy is Postgres `jsonb`, which does not keep key
  // order.
  const keptWidthOnly = new Set(
    usable
      .filter(([id]) => !validColumnIds.has(id) && isWidthOnlyColumnId(id))
      .slice(-MAX_CUSTOM_FIELDS_PER_ORG)
      .map(([id]) => id)
  );
  return Object.fromEntries(
    usable.filter(([id]) => validColumnIds.has(id) || keptWidthOnly.has(id))
  );
}

/**
 * Keep only the ids of known columns, ONCE each — the APPLIED half of a stored
 * or saved `columnOrder`, and the sibling of {@link filterValidColumnWidths}.
 *
 * The dedupe is what BOUNDS this axis (ISS-9449). Every other axis is bounded
 * by its own shape — hidden ids become a `Set`, declared widths a `Record`,
 * carried ids are capped per axis, width-only widths are shed at the write
 * ceiling — so the applied order was the one axis a corrupt record
 * could make arbitrarily long, and it could do so out of ids this build knows.
 * A record of one known id repeated past the serialized ceiling would then be
 * refused on every write, since shedding the carry cannot shrink an order made
 * of recognized ids: the reader would keep restoring the bad record and no
 * edit of theirs would ever persist. Deduped here, the applied order can never
 * be longer than `validColumnIds`.
 *
 * The FIRST occurrence wins — the first slot the arrangement puts a column in.
 * A well-formed order has no repeats, so this is identity on every record any
 * build writes; only a corrupt one is changed by it.
 */
export function filterValidColumnOrder(
  order: readonly string[] | undefined,
  validColumnIds: ReadonlySet<string>
): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of order ?? []) {
    if (validColumnIds.has(id) && !seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }
  return next;
}

/**
 * Split out the ids of a stored arrangement this build cannot draw, so the
 * write that follows a restore can put them back (ISS-9447 D1).
 *
 * `normalizeStoredTableView` is its only caller, and deliberately so: that is
 * the one function reading storage, for the mount-time restore and for a
 * cross-tab adoption alike (ISS-9568), and storage is the one place an
 * arrangement of unknown provenance enters the hook. An arrangement arriving
 * from inside the app — a named saved view being applied — says nothing about
 * columns its capturing build could not see, so `applyView` in
 * `usePersistedTableViewState` keeps what was already carried instead of
 * re-deriving it from the incoming view.
 */
export function partitionPreservedColumnIds(
  stored: StoredColumnArrangement,
  validColumnIds: ReadonlySet<string>,
  isWidthOnlyColumnId: (id: string) => boolean = noWidthOnlyColumnIds
): PreservedColumnIds {
  const hiddenColumns = capCarriedIds(
    (stored.hiddenColumns ?? []).filter((id) => !validColumnIds.has(id))
  );
  const columnOrder = capCarriedIds(
    (stored.columnOrder ?? []).filter((id) => !validColumnIds.has(id))
  );
  const carriedWidths: [string, number][] = [];
  for (const [id, width] of Object.entries(stored.columnWidths ?? {})) {
    // A width-only id is one this build DRAWS, so it is applied by
    // `filterValidColumnWidths`, not carried as skew.
    if (
      !(validColumnIds.has(id) || isWidthOnlyColumnId(id)) &&
      isUsableColumnWidth(width)
    ) {
      carriedWidths.push([id, width]);
    }
  }
  const columnWidths = Object.fromEntries(capCarriedWidths(carriedWidths));
  if (
    hiddenColumns.length === 0 &&
    columnOrder.length === 0 &&
    Object.keys(columnWidths).length === 0
  ) {
    return NO_PRESERVED_COLUMN_IDS;
  }
  return { columnOrder, columnWidths, hiddenColumns };
}

/**
 * Fold the carried ids back into the arrangement about to be written, so the
 * stored record round-trips whole.
 *
 * Preserved order ids land AFTER the applied order, the rule `mergeColumnOrder`
 * already states for ids a complete order does not know about: a slot cannot be
 * held open for a column this build never draws, so the end is where they go
 * rather than nowhere. That end-placement is site-specific, not the D1 rule: it
 * follows from THIS hook rebuilding its applied order from canonical ids after
 * partitioning at restore, whereas `useColumnVisibility` seeds its merge base
 * from the stored order and so does hold the slot (ISS-9908). Widths spread
 * preserved-first so an applied width always wins a collision.
 */
export function mergePreservedColumnIds(
  applied: {
    hiddenColumns: Iterable<string>;
    columnOrder: readonly string[];
    columnWidths: Readonly<Record<string, number>>;
  },
  preserved: PreservedColumnIds
): {
  hiddenColumns: string[];
  columnOrder: string[];
  columnWidths: Record<string, number>;
} {
  return {
    columnOrder: [...applied.columnOrder, ...preserved.columnOrder],
    columnWidths: { ...preserved.columnWidths, ...applied.columnWidths },
    hiddenColumns: [...applied.hiddenColumns, ...preserved.hiddenColumns],
  };
}

/**
 * How many unrecognized ids one axis carries before the OLDEST are dropped
 * (ISS-9449).
 *
 * D1 carries every id this build cannot draw, and nothing else bounded the
 * carry: a record could grow by one skewed build after another, or by a
 * corrupt write, with the silent quota swallow in the persist effect as its
 * only stop.
 * Sixty-four is past any real skew — Sessions declares 19 column ids, Branches
 * and Agent Components fewer — so a carry this long is not a newer build's
 * arrangement, it is damage. The cap bounds the COUNT of ids, not their bytes;
 * a single enormous id is stopped by `MAX_SERIALIZED_TABLE_VIEW_LENGTH` at the
 * write, so the two limits are not redundant.
 *
 * The brief that fixed the cap also fixed WHICH ids go — the oldest carried,
 * never a recognized one — and the applied half is partitioned off before the
 * cap runs, so what a recognized id restores to is untouched.
 */
export const MAX_PRESERVED_COLUMN_IDS_PER_AXIS = 64;

/**
 * Keep the FIRST entries of a carried array. `mergePreservedColumnIds` writes
 * `[...applied, ...preserved]`, so across successive skewed builds the carried
 * tail reads newest-unknown-build first and oldest last: the tail is the oldest.
 */
function capCarriedIds(carried: readonly string[]): string[] {
  return carried.slice(0, MAX_PRESERVED_COLUMN_IDS_PER_AXIS);
}

/**
 * Keep the LAST entries of the carried widths. `mergePreservedColumnIds` writes
 * `{ ...preserved, ...applied }`, so insertion order reads oldest first: the
 * front is the oldest. Best-effort only, because this reads UNTRUSTED storage
 * and JS hoists an integer-like key ahead of insertion order — a hand-edited
 * record with numeric-string ids can drop a newer width instead of an older one.
 */
function capCarriedWidths(
  carried: readonly [string, number][]
): readonly [string, number][] {
  return carried.slice(-MAX_PRESERVED_COLUMN_IDS_PER_AXIS);
}

/** No width-only ids: every id outside `validColumnIds` is version skew. */
function noWidthOnlyColumnIds(): boolean {
  return false;
}

/**
 * A live resize, through {@link filterValidColumnWidths} so live state keeps
 * exactly what a reload of the written record would. `id` is re-inserted LAST,
 * so key order is resize recency — the order the width-only cap drops from.
 */
export function resizeColumnWidth(
  widths: Readonly<Record<string, number>>,
  resized: { id: string; widthPx: number },
  validColumnIds: ReadonlySet<string>,
  isWidthOnlyColumnId?: (id: string) => boolean
): Record<string, number> {
  const { [resized.id]: _replaced, ...rest } = widths;
  return filterValidColumnWidths(
    { ...rest, [resized.id]: resized.widthPx },
    validColumnIds,
    isWidthOnlyColumnId
  );
}
