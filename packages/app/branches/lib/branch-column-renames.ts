/**
 * Persisted Branches column ids this build has RENAMED, mapped old → new.
 *
 * EMPTY today, and deliberately so: no Branches column id has ever been
 * renamed, and ISS-9447 M5 declines to fabricate an entry to make the wiring
 * look exercised. What M5 adds is the MECHANISM, because the cost of not having
 * it is paid on the read that discovers it is missing — both Branches stores
 * validate the stored sort key against a CLOSED enum, so one renamed sortable
 * column would fail the whole object parse and cost the reader their columns,
 * window and grouping along with their sort. Sessions found that out on its own
 * surface (`sessions-table-columns.ts`, ISS-9447 M3); Branches gets the seam
 * before the rename rather than after it.
 *
 * A rename is a spelling, not a judgement, so this is an idempotent read-time
 * alias rather than a versioned one-time migration: there is no user choice to
 * respect and the mapping is correct on every read, forever. That is also why
 * adding one is a single row here — no migration module, no version stamp, no
 * per-axis wiring, because both Branches stores already route all four id-keyed
 * axes (hidden columns, column order, column widths, sort key) through this
 * module.
 */
const BRANCH_RENAMED_COLUMN_IDS: Readonly<Record<string, string>> = {};

/**
 * One persisted column id, resolved to the id this build renders.
 *
 * Unknown ids pass through unchanged: a persisted view can legitimately carry a
 * column another build knows about, and dropping it here would discard a slot
 * the reader arranged (ISS-9447 D1 carries those instead). The only job here is
 * the rename. `Object.hasOwn` rather than a bare lookup because the key comes
 * from `localStorage`: `__proto__` on a plain object literal resolves to
 * `Object.prototype`, which is truthy and is not a column id.
 */
export function normalizeBranchColumnId(columnId: string): string {
  return Object.hasOwn(BRANCH_RENAMED_COLUMN_IDS, columnId)
    ? BRANCH_RENAMED_COLUMN_IDS[columnId]
    : columnId;
}

/**
 * Every persisted column id in a stored list, resolved.
 *
 * One helper rather than a `.map` at each call site so the hidden-column and
 * column-order axes cannot end up on different sides of a rename.
 */
export function normalizeBranchColumnIds(
  columnIds: readonly string[]
): string[] {
  return columnIds.map(normalizeBranchColumnId);
}

/**
 * The same alias as a Zod preprocess, for a stored SORT key.
 *
 * In FRONT of the closed sort enum rather than behind its `.catch`, so a
 * renamed sortable column resolves to the column the reader actually chose
 * instead of degrading to the default sort. A non-string is handed through
 * untouched for the enum to reject.
 */
export function normalizeStoredBranchSortKey(value: unknown): unknown {
  return typeof value === "string" ? normalizeBranchColumnId(value) : value;
}

/**
 * Every persisted column WIDTH, re-keyed to the id this build renders.
 *
 * Widths are the FOURTH axis keyed by a column id, and they have to resolve on
 * the same read boundary as the other three or a rename half-applies: the sort,
 * the hidden set and the order would move to the new id while the width stayed
 * keyed by the old one, was filtered out as a column this build cannot draw, and
 * left that column silently back at its natural size.
 *
 * An entry already stored under the NEW id wins a collision whichever order the
 * two appear in — a record carrying both spellings can only have been written by
 * a build that already knew the new id, so its entry is the later statement.
 */
export function normalizeBranchColumnWidths(
  columnWidths: Readonly<Record<string, number>>
): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [columnId, width] of Object.entries(columnWidths)) {
    const resolved = normalizeBranchColumnId(columnId);
    if (resolved === columnId || !Object.hasOwn(normalized, resolved)) {
      normalized[resolved] = width;
    }
  }
  return normalized;
}
