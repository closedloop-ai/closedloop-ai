/**
 * ISS-4890: one-time, targeted repair of a persisted Sessions saved view.
 *
 * ISS-4788 moved Cost to the 3rd data column so its track ends at 712px —
 * inside `SESSIONS_LEGIBLE_COLUMN_BUDGET_PX` and clear of the desktop viewport
 * edge. That landed only for users who had NEVER drag-reordered a Sessions
 * column: `SessionsTable` runs `orderColumns(visibleDataSpecs, columnOrder)`,
 * which emits the persisted ids first, so anyone with a saved `columnOrder` kept
 * Cost in its old 6th slot at x ~1120–1220 — still past the fold, still
 * rendering `$772.3` for a row whose cost is `$772.39`. A clipped currency value
 * is a value lie, not a layout preference, and the affected population is
 * exactly the power users most likely to be reading the number.
 *
 * The repair is deliberately NARROW, in three ways:
 *
 *  1. **One column moves.** Only the named id is relocated; every other column
 *     stays exactly where the user put it, and sort, hidden columns, widths, and
 *     the date range are never touched. Bumping the `sessions:saved-view:` key
 *     prefix would have been one line, and would have discarded the whole saved
 *     view to fix one column's position — collateral damage well beyond the bug.
 *  2. **Relative, then BOUNDED BY THE FOLD.** The column lands immediately after
 *     the nearest canonical PREDECESSOR that is actually present in the user's
 *     order, rather than at a fixed index — a user who moved Owner and Status
 *     still gets Cost placed next to the columns it belongs with, instead of an
 *     index computed against an arrangement they do not have. But a relative
 *     anchor alone is not enough, because the anchor may itself sit past the
 *     fold: with a persisted `[repo, branch, owner, status, pr, cost]` the last
 *     surviving predecessor is Status, whose track already ends at 972px, so
 *     anchoring after it leaves Cost ending at 1,072px — still past the fold,
 *     i.e. the inverse of the repair (wongk + stage review). So the resolved
 *     slot is then CLAMPED left until Cost's own track ends within
 *     `SESSIONS_LEGIBLE_COLUMN_BUDGET_PX`. Relative placement is the preference;
 *     the budget is the guarantee.
 *  3. **Once.** The caller stamps the saved view with
 *     {@link SESSIONS_SAVED_VIEW_VERSION} after applying it, so a user who
 *     deliberately drags Cost back is not fought on every load.
 *
 * Pure functions over string ids — no React, no storage, no DOM — so the
 * relocation is unit-testable on its own and the hook stays responsible only for
 * wiring it to the restore boundary.
 */

/**
 * Schema version stamped onto a Sessions saved view once every migration below
 * has been applied to it.
 *
 * `0` (or absent) is a pre-ISS-4890 view that has never been migrated. The
 * restore path compares the persisted version against this constant, applies the
 * gap, and persists the result — so each migration runs at most once per saved
 * view, and a user who reverses a migration's effect by hand keeps their choice.
 *
 * Bump this — and extend `migrateSavedColumnOrder` — when a future change needs
 * another one-time repair of a persisted view.
 */
export const SESSIONS_SAVED_VIEW_VERSION = 1;

/** Version of a saved view that predates any migration marker. */
export const SESSIONS_SAVED_VIEW_UNVERSIONED = 0;

/**
 * The saved-view version at which the ISS-4890 Cost relocation was introduced.
 * Kept as its own constant so a later migration can bump
 * {@link SESSIONS_SAVED_VIEW_VERSION} without silently re-running this one.
 */
const SESSIONS_SAVED_VIEW_VERSION_COST_RELOCATION = 1;

/**
 * The column id the v1 migration relocates. Declared here rather than imported
 * from the table's column module so this pure migration stays readable as a
 * historical record: v1 moved *this* id, whatever the table's specs say later.
 * The canonical ORDER it is relocated against is still supplied by the caller
 * from `SESSIONS_DATA_COLUMN_ORDER`, so the destination can never drift.
 */
const SESSIONS_MIGRATED_COST_COLUMN_ID = "cost";

/**
 * Move `columnId` to its canonical slot within a user's persisted column order,
 * leaving every other id in the exact relative order the user arranged them.
 *
 * The target slot is resolved RELATIVE to the user's own arrangement: the column
 * lands immediately after the LAST of its canonical predecessors that appears in
 * `persistedOrder`. With canonical `[owner, status, cost, repo, …]`, a persisted
 * `[owner, status, repo, branch, pr, cost, …]` puts Cost back at index 2 (after
 * `status`); a persisted `[repo, branch, owner, status, pr, cost, …]` puts it
 * after `status` at index 4 — next to the columns it belongs with, wherever the
 * user chose to keep those.
 *
 * That relative slot is then CLAMPED LEFT by `geometry`, when supplied, until
 * the relocated column's own track ends within
 * {@link ColumnBudgetGeometry.budgetPx}. Without the clamp a predecessor that
 * the user dragged past the fold drags the relocated column past it too, which
 * is the inverse of the repair — the migration would hide a value that was
 * legible, and then stamp the view so it is never reconsidered. Omitting
 * `geometry` keeps the purely relative placement (used where no track widths are
 * known).
 *
 * Returns a NEW array; the input is never mutated. Degrades to a plain copy —
 * never a throw, never a reordering nobody asked for — when there is nothing to
 * do:
 *  - `columnId` is absent from `persistedOrder` (the table already places an
 *    unlisted column by its natural position via `orderColumns`);
 *  - `columnId` is absent from `canonicalOrder` (an id this build no longer
 *    knows, so it has no canonical slot to move to);
 *  - the column already sits at the resolved slot.
 *
 * When NONE of the canonical predecessors survive in the user's order, the
 * column goes to the FRONT: every remaining id is one the canonical order ranks
 * after it, so leading is the only placement consistent with the arrangement
 * that is actually there.
 */
export function relocateColumnToCanonicalSlot(
  persistedOrder: readonly string[],
  canonicalOrder: readonly string[],
  columnId: string,
  geometry?: ColumnBudgetGeometry
): string[] {
  const canonicalIndex = canonicalOrder.indexOf(columnId);
  if (canonicalIndex === -1 || !persistedOrder.includes(columnId)) {
    return [...persistedOrder];
  }
  const predecessors = new Set(canonicalOrder.slice(0, canonicalIndex));
  const withoutColumn = persistedOrder.filter((id) => id !== columnId);
  // The slot AFTER the last surviving canonical predecessor. `findLastIndex`
  // returns -1 when none survive, which lands the column at index 0 — the front.
  const anchorIndex = findLastIndex(withoutColumn, (id) =>
    predecessors.has(id)
  );
  const insertAt = geometry
    ? Math.min(
        anchorIndex + 1,
        lastSlotWithinBudget(withoutColumn, columnId, geometry)
      )
    : anchorIndex + 1;
  const next = [...withoutColumn];
  next.splice(insertAt, 0, columnId);
  return next;
}

/**
 * Apply every saved-view column-order migration this build knows about to a
 * persisted order last stamped at `fromVersion`, and report the version the
 * result should be re-stamped with.
 *
 * `columnOrder` is returned unchanged (a copy) for a view already at
 * {@link SESSIONS_SAVED_VIEW_VERSION} or beyond — including a view written by a
 * NEWER build than this one, whose higher version is preserved rather than
 * rolled back, so a user moving between builds never has a future migration
 * silently re-run against them.
 *
 * Deliberately UNLIKE {@link migrateSavedHiddenColumns}, which clamps a future
 * stamp down. The restore drops unknown ids from both arrays, but the losses are
 * not the same defect: an id missing from `columnOrder` is placed at its natural
 * position by `orderColumns`, so the view degrades to a layout the user did not
 * choose, while an id missing from `hiddenColumns` RENDERS A COLUMN this build
 * ships hidden. Only the second is worth re-running a future migration to heal.
 *
 * An empty `columnOrder` (the natural-order convention) still advances the
 * version: there is nothing to repair, and stamping it means the next load skips
 * this check entirely instead of re-deriving the same no-op.
 */
export function migrateSavedColumnOrder(
  columnOrder: readonly string[],
  canonicalOrder: readonly string[],
  fromVersion: number,
  geometry?: ColumnBudgetGeometry
): { columnOrder: string[]; version: number } {
  if (fromVersion >= SESSIONS_SAVED_VIEW_VERSION) {
    return { columnOrder: [...columnOrder], version: fromVersion };
  }
  // v1 (ISS-4890): put Cost back in front of the fold. Guarded on the version,
  // not on the current position, so a user who deliberately drags it back after
  // the migration keeps their choice.
  const migrated =
    fromVersion < SESSIONS_SAVED_VIEW_VERSION_COST_RELOCATION
      ? relocateColumnToCanonicalSlot(
          columnOrder,
          canonicalOrder,
          SESSIONS_MIGRATED_COST_COLUMN_ID,
          geometry
        )
      : [...columnOrder];
  return { columnOrder: migrated, version: SESSIONS_SAVED_VIEW_VERSION };
}

/**
 * ISS-6005: version stamp for the HIDDEN-COLUMNS migrations, tracked separately
 * from {@link SESSIONS_SAVED_VIEW_VERSION}.
 *
 * Separate on purpose, not as a second copy of the same idea: the column-ORDER
 * migrations above are applied only while the `sessions-grid-fold-legibility`
 * flag is on (an ISS-4890 review decision), so their version stamp advances only
 * on flag-on loads. The hidden-columns migration must reach EVERY user — Mike's
 * defect is precisely that persisted views predating ISS-5315 keep showing the
 * PR/Merge columns — so it runs unconditionally in both parsers. Sharing one
 * scalar would force a choice between skipping the ungated repair while the flag
 * is off, or stamping a version that silently retires the gated v1 relocation
 * for users it never ran for. Two dimensions, two markers.
 *
 * ISS-6065 raised this to 2. v1 shipped only three of the six default-hidden
 * ids, so `started` (default-hidden since ISS-5315) kept rendering on every
 * pre-ISS-5315 view, and `projects` / `issues` were set to auto-show the moment
 * `grid-table-v2` flips on. A new step rather than an edit to the v1 payload:
 * views loaded since ISS-6005 are already stamped 1, and the version guard would
 * skip a widened v1 for exactly the population that needs it.
 */
export const SESSIONS_SAVED_VIEW_HIDDEN_VERSION = 2;

/**
 * The column ids the v1 hidden-columns migration hides in a persisted view.
 *
 * `pr` / `merge`: ISS-5315 made them default-hidden — the Linked-branches cell
 * carries the PR summary and merge state in its tooltip, so no fact is lost —
 * but the default only seeds a never-saved view. A view persisted BEFORE that
 * change carries a `hiddenColumns` without them, and the shared hook derives
 * visibility as columnIds minus that set, so those users kept both columns
 * (`—` on most rows). Migrated once, per the operator's direction; persisted
 * state cannot distinguish "never touched" from "deliberately re-enabled
 * pre-ISS-5315", so a deliberate re-enable is migrated too and the View menu
 * remains the one-click way back.
 *
 * `updated`: the ISS-6005 column ships default-hidden, and the same
 * columnIds-minus-hidden derivation would AUTO-SHOW a new id that no persisted
 * `hiddenColumns` names (proven by fixture in the test file — the "no migration
 * needed for an off-by-default addition" assumption does not hold for this
 * hook). Hiding it here keeps the addition invisible-by-default for saved views
 * too.
 *
 * Declared as a literal, like `SESSIONS_MIGRATED_COST_COLUMN_ID` above, so the
 * migration stays a historical record: v1 hides THESE ids, whatever the table's
 * specs say later.
 */
const SESSIONS_HIDDEN_MIGRATION_V1_COLUMN_IDS = ["pr", "merge", "updated"];

/**
 * The stamp a view carries once the v1 hidden-columns step has been applied.
 * Its own constant, like {@link SESSIONS_SAVED_VIEW_VERSION_COST_RELOCATION},
 * so ISS-6065's v2 step could raise {@link SESSIONS_SAVED_VIEW_HIDDEN_VERSION}
 * without silently re-running v1 against a view that already took it.
 */
export const SESSIONS_HIDDEN_MIGRATION_V1_VERSION = 1;

/**
 * The column ids the v2 hidden-columns migration adds (ISS-6065).
 *
 * `started`: ISS-5315 made it default-hidden alongside `pr` / `merge` — it
 * collapses to the same coarse "3h ago" label as Last active — but v1 named only
 * the other two, and `started` is ungated, so every pre-ISS-5315 saved view kept
 * rendering it.
 *
 * `projects` / `issues`: ISS-5770 made them default-hidden so flipping
 * `grid-table-v2` on would not grow two columns the prototype's default view
 * does not have. That is a DEFAULT, and the same columnIds-minus-hidden
 * derivation would auto-show them on every persisted view the moment the gate
 * opens — the precise outcome that ticket exists to prevent.
 */
const SESSIONS_HIDDEN_MIGRATION_V2_COLUMN_IDS = [
  "started",
  "projects",
  "issues",
];

/**
 * The stamp a view carries once the v2 step has been applied. FROZEN at 2, not
 * read from {@link SESSIONS_SAVED_VIEW_HIDDEN_VERSION}: a v3 step would raise
 * that constant, and a v2 step whose version rose with it would re-hide
 * `started` / `projects` / `issues` for every user who had deliberately shown
 * them again — the exact "not fought on every load" promise the version guard
 * exists to keep.
 */
const SESSIONS_HIDDEN_MIGRATION_V2_VERSION = 2;

/**
 * Every hidden-columns migration in version order: a step's ids are appended to
 * a view stamped BELOW its version, so a user who has already taken v1 takes
 * only v2. Kept as one table so the applied payload and
 * {@link SESSIONS_HIDDEN_MIGRATION_COLUMN_IDS} cannot drift apart.
 *
 * Exported so a guard test can PIN each step's payload. That pin is what makes
 * the subset guard load-bearing: a default-hidden id appended to an
 * already-shipped step would satisfy the subset relation while every view
 * stamped at that step's version short-circuits and never hides it. Pinned, the
 * only green way to add one is a NEW step — which needs a new version, which
 * reaches the views that already took the old ones.
 */
export const SESSIONS_HIDDEN_MIGRATION_STEPS: readonly {
  version: number;
  columnIds: readonly string[];
}[] = [
  {
    version: SESSIONS_HIDDEN_MIGRATION_V1_VERSION,
    columnIds: SESSIONS_HIDDEN_MIGRATION_V1_COLUMN_IDS,
  },
  {
    version: SESSIONS_HIDDEN_MIGRATION_V2_VERSION,
    columnIds: SESSIONS_HIDDEN_MIGRATION_V2_COLUMN_IDS,
  },
];

/**
 * The union of every hidden-migration payload — every id this build has ever
 * repaired a persisted view for.
 *
 * Exported for the guard test that asserts `SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS`
 * is a subset of it. That subset relation is the invariant ISS-6065 was: a
 * default-hidden id no migration names does not stay hidden for a saved view, it
 * silently renders.
 */
export const SESSIONS_HIDDEN_MIGRATION_COLUMN_IDS: readonly string[] =
  SESSIONS_HIDDEN_MIGRATION_STEPS.flatMap((step) => step.columnIds);

/**
 * Apply the one-time hidden-columns migrations to a persisted `hiddenColumns`
 * set last stamped at `fromVersion`, and report the version to re-stamp with.
 *
 * The PAYLOAD is returned unchanged (a copy) at
 * {@link SESSIONS_SAVED_VIEW_HIDDEN_VERSION} or beyond. Below it, the ids of
 * every step the view has not taken are appended (deduplicated, existing entries
 * and their order untouched). Guarded on the version, not on the current
 * membership, so a user who shows a migrated column again AFTER its step keeps
 * that choice on every later load.
 *
 * The returned VERSION is always this build's stamp — a marker from a NEWER
 * build is clamped DOWN rather than preserved (ISS-6065, wongk). Preserving it
 * was the intent, but this build cannot honour what it certifies: the shared
 * `usePersistedTableViewState` restore drops every hidden id outside this
 * build's `columnIds` and then re-persists the filtered set alongside the
 * untouched marker, so a v3-only default-hidden id is destroyed while the stamp
 * still swears v3 ran. Back on v3 the version guard short-circuits and the
 * column silently renders — ISS-6065's own defect, reintroduced by a downgrade.
 * Clamping re-runs exactly the steps above this build on return, which is
 * exactly the set whose ids this build may have dropped. The cost is bounded and
 * strictly smaller: a column deliberately re-shown on the newer build is hidden
 * once more, rather than a hidden column silently coming back.
 */
export function migrateSavedHiddenColumns(
  hiddenColumns: readonly string[],
  fromVersion: number
): { hiddenColumns: string[]; version: number } {
  if (fromVersion >= SESSIONS_SAVED_VIEW_HIDDEN_VERSION) {
    return {
      hiddenColumns: [...hiddenColumns],
      version: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
    };
  }
  const present = new Set(hiddenColumns);
  const added: string[] = [];
  const pending = SESSIONS_HIDDEN_MIGRATION_STEPS.filter(
    (step) => fromVersion < step.version
  ).flatMap((step) => step.columnIds);
  for (const id of pending) {
    if (!present.has(id)) {
      present.add(id);
      added.push(id);
    }
  }
  return {
    hiddenColumns: [...hiddenColumns, ...added],
    version: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
  };
}

/** Index of the LAST element satisfying `predicate`, or -1 when none does. */
function findLastIndex<T>(
  items: readonly T[],
  predicate: (item: T) => boolean
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index;
    }
  }
  return -1;
}

/**
 * The track arithmetic {@link relocateColumnToCanonicalSlot} needs to tell a
 * legible destination from one that is past the horizontal fold (ISS-4890,
 * wongk + stage review).
 *
 * Kept as a caller-supplied value rather than imported here so this module stays
 * a pure function over ids and numbers — the Sessions table owns its geometry,
 * and a future migration of a different table can pass its own.
 */
export type ColumnBudgetGeometry = {
  /** Track width (px) per data-column id. An unknown id contributes `0`. */
  widthsPx: Readonly<Record<string, number>>;
  /** Width (px) of the always-rendered leading track every data column follows. */
  leadWidthPx: number;
  /** How far right (px, from the table's left edge) the moved track may END. */
  budgetPx: number;
  /**
   * Ids the saved view hides. A hidden column renders no track, so it costs
   * nothing against the budget; omitting the set treats every persisted id as
   * visible, which is the conservative direction (it can only place the moved
   * column further left than strictly necessary, never further right).
   */
  hiddenColumnIds?: ReadonlySet<string>;
};

/**
 * The RIGHTMOST index in `order` at which inserting `columnId` still ends its
 * track within `geometry.budgetPx`.
 *
 * Walks the tracks left to right accumulating the rendered width in front of
 * each candidate slot, and stops at the first slot the moved column would
 * overhang. Returns `0` when even the leading slot busts the budget — the front
 * is then the least-bad placement, and never a negative index that would splice
 * from the end.
 */
function lastSlotWithinBudget(
  order: readonly string[],
  columnId: string,
  geometry: ColumnBudgetGeometry
): number {
  const { widthsPx, leadWidthPx, budgetPx, hiddenColumnIds } = geometry;
  const movedWidthPx = widthsPx[columnId] ?? 0;
  let endPx = leadWidthPx + movedWidthPx;
  let lastFitting = 0;
  for (const [index, id] of order.entries()) {
    if (endPx > budgetPx) {
      return lastFitting;
    }
    lastFitting = index;
    if (!hiddenColumnIds?.has(id)) {
      endPx += widthsPx[id] ?? 0;
    }
  }
  return endPx > budgetPx ? lastFitting : order.length;
}
