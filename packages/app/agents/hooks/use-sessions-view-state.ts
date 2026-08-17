"use client";

import { useCallback } from "react";
import { z } from "zod";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import {
  type RestoredTableView,
  usePersistedTableViewState,
} from "../../shared/hooks/use-persisted-table-view-state";
import { SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY } from "../../shared/lib/feature-flags";
import type { DateRange } from "../../shared/lib/format-utils";
import { coerceSessionGroupBy, SessionGroupBy } from "../lib/session-grouping";
import {
  type SessionSortDir,
  type SessionSortKey,
  SessionSortDir as SortDir,
  SessionSortKey as SortKey,
} from "../lib/session-sort-group";
import {
  migrateSavedColumnOrder,
  migrateSavedHiddenColumns,
  SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
  SESSIONS_SAVED_VIEW_UNVERSIONED,
  SESSIONS_SAVED_VIEW_VERSION,
} from "../lib/sessions-saved-view-migration";
import {
  normalizeSessionColumnId,
  SESSIONS_AUTONOMY_COLUMN_ID,
  SESSIONS_COLUMN_SPECS,
  SESSIONS_COLUMN_WIDTH_PX,
  SESSIONS_DATA_COLUMN_ORDER,
  SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS,
  SESSIONS_ISSUES_COLUMN_ID,
  SESSIONS_LEAD_COLUMN_MIN_WIDTH_PX,
  SESSIONS_LEGIBLE_COLUMN_BUDGET_PX,
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_UPDATED_COLUMN_ID,
  type SessionsColumnGateState,
  type SessionsColumnId,
  selectOfferableSessionColumns,
} from "../lib/sessions-table-columns";

/**
 * Toggleable data columns for the Sessions table (the Name lead is always shown;
 * the always-visible "Autonomy" column is excluded).
 *
 * ISS-5713 / ISS-5770: DERIVED from `SESSIONS_COLUMN_SPECS` rather than typed
 * out again. This was a hand-maintained literal whose own doc comment promised
 * it "mirrors SESSIONS_COLUMN_SPECS order" — prose, holding two lists in step by
 * convention, which is precisely the declaration-versus-consumer drift ISS-5713
 * was filed about. It had already drifted: the menu carried `branch` where the
 * spec carried the same column, and the tail order (…Cost, Last active, PR,
 * Merge, Started) no longer matched the table's.
 *
 * Deriving makes the menu's ORDER the table's declared order by construction, so
 * a freshly-loaded table and its View menu cannot disagree. The old caveat still
 * applies and is unchanged by this: `sessions-toolbar` renders this list without
 * the user's persisted `columnOrder`, so after someone drag-reorders a header
 * (FEA-4021) the table moves and the menu does not. Default-state agreement is
 * the guarantee; tracking a customised order is not.
 *
 * Columns that ship hidden stay in this list — hiding a column by default must
 * never make it unreachable.
 *
 * ISS-5770 review (codex): this list is deliberately GATE-BLIND — it is every
 * toggleable column the build DECLARES, not the subset a given build+mount
 * offers. That is what the two things reading it need: it seeds the persistence
 * hook's valid-id set, and filtering a gated column out of THAT would make the
 * shared setter strip a user's persisted hide/reorder for the column the moment
 * its flag went off, losing a choice they made while it was on. The gate belongs
 * to the MENU, which is {@link sessionsToggleableColumns} — and that now reads
 * `spec.gate` rather than a hand-maintained id list.
 */
const SESSIONS_TOGGLEABLE_COLUMN_SPECS = SESSIONS_COLUMN_SPECS.filter(
  (spec) => spec.id !== SESSIONS_AUTONOMY_COLUMN_ID
).map((spec) => ({
  id: spec.id,
  label: String(spec.label),
  // Carried through so the menu derivation below can read each column's gate off
  // the DECLARATION. Dropping it here is what forced `sessionsToggleableColumns`
  // to re-state gatedness as a hand-maintained id list (ISS-5770 review).
  gate: spec.gate,
}));

export const SESSIONS_TOGGLEABLE_COLUMNS: readonly {
  id: SessionColumnId;
  label: string;
}[] = SESSIONS_TOGGLEABLE_COLUMN_SPECS.map((spec) => ({
  id: spec.id,
  label: spec.label,
}));

/**
 * ISS-5713 / ISS-5770: a Sessions data-column id, sourced from the canonical
 * declaration rather than from this module's own list.
 *
 * The union used to be read off the hand-written array above, which made the
 * menu its own second source of truth for which columns exist and what they are
 * called. `SESSIONS_COLUMN_SPECS` is the declaration; this is a view of it.
 */
export type SessionColumnId = SessionsColumnId;

// Stable module-level id list so the shared hook's derived memos don't churn.
const SESSIONS_COLUMN_IDS: readonly SessionColumnId[] =
  SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.id);

// The always-shown "Autonomy" column is rendered by SessionsTable but excluded
// from the toggleable menu (SESSIONS_TOGGLEABLE_COLUMNS). It still participates
// in reorder, so the header emits it inside `columnOrder`. The order-valid set
// passed to the shared hook must therefore include it — otherwise the shared
// setter's valid-id filter strips `autonomy` on persist and `orderColumns`
// re-appends it at the end, silently relocating Autonomy after any reorder
// (FEA-4150). Kept separate from SESSIONS_COLUMN_IDS so the columns menu and the
// glanceable set below stay Autonomy-free.
// Autonomy is the ONLY such exception: every other declared column is toggleable
// and so already rides in SESSIONS_COLUMN_IDS above.
const SESSIONS_ORDERABLE_COLUMN_IDS: readonly string[] = [
  ...SESSIONS_COLUMN_IDS,
  SESSIONS_AUTONOMY_COLUMN_ID,
];

const SORT_KEYS = Object.values(SortKey) as [
  SessionSortKey,
  ...SessionSortKey[],
];
const SORT_DIRS = Object.values(SortDir) as [
  SessionSortDir,
  ...SessionSortDir[],
];
const GROUP_BY_VALUES = Object.values(SessionGroupBy) as [
  SessionGroupBy,
  ...SessionGroupBy[],
];

/**
 * The default Sessions time window for both persisted-view surfaces (web
 * `/{org}/sessions` and desktop). Exported as the SSOT the honest empty state
 * compares the active window against to tell a narrowed filter from the default
 * (review cid 3653717604), so no surface re-hardcodes the literal.
 */
export const DEFAULT_SESSIONS_DATE_RANGE: DateRange = "7d";

const savedViewSchema = z.object({
  // Null = no explicit sort: queries omit sortBy so the server uses its default
  // order (and the desktop local source keeps its fast paginated path).
  sortKey: z.enum(SORT_KEYS).nullable().default(null),
  sortDir: z.enum(SORT_DIRS),
  // Time window for the list + summary metrics. Defaults to
  // DEFAULT_SESSIONS_DATE_RANGE (the SSOT the honest empty state compares the
  // active window against to tell a narrowed filter from the default).
  dateRange: z
    .enum(["7d", "30d", "90d", "all"])
    .default(DEFAULT_SESSIONS_DATE_RANGE),
  // ISS-5315: persisted Group-by dimension. An unknown/legacy value degrades to
  // "none" rather than failing the whole view parse.
  groupBy: z
    .preprocess((value) => coerceSessionGroupBy(value), z.enum(GROUP_BY_VALUES))
    .default(SessionGroupBy.None),
  hiddenColumns: z
    .preprocess(
      (value) =>
        Array.isArray(value)
          ? value.filter((item) => typeof item === "string")
          : [],
      z.array(z.string())
    )
    .default([]),
  // FEA-4021: persisted data-column order (ids). Same data-cleaning preprocess
  // as `hiddenColumns` — keep only the string entries; a missing/non-array
  // value degrades to the table's natural order.
  columnOrder: z
    .preprocess(
      (value) =>
        Array.isArray(value)
          ? value.filter((item) => typeof item === "string")
          : [],
      z.array(z.string())
    )
    .default([]),
  // ISS-4890: which one-time saved-view migrations have already been applied to
  // THIS stored view. Absent (every view written before ISS-4890) or malformed
  // degrades to `SESSIONS_SAVED_VIEW_UNVERSIONED`, which is exactly the "never
  // migrated" state — so an older or corrupt marker is safe rather than skipping
  // a repair. A version from a NEWER build is preserved verbatim (see
  // `migrateSavedColumnOrder`) instead of being rolled back.
  savedViewVersion: z.preprocess(
    (value) =>
      typeof value === "number" && Number.isInteger(value) && value >= 0
        ? value
        : SESSIONS_SAVED_VIEW_UNVERSIONED,
    z.number()
  ),
  // ISS-6005: which one-time HIDDEN-COLUMNS migrations have been applied to
  // this stored view. A separate marker from `savedViewVersion` because the
  // column-order migrations are flag-gated while this one runs for everyone —
  // see `SESSIONS_SAVED_VIEW_HIDDEN_VERSION`. Absent/malformed degrades to
  // unversioned ("never migrated"), the safe direction.
  hiddenColumnsVersion: z.preprocess(
    (value) =>
      typeof value === "number" && Number.isInteger(value) && value >= 0
        ? value
        : SESSIONS_SAVED_VIEW_UNVERSIONED,
    z.number()
  ),
});

// Feature-specific "extra" dimensions persisted alongside sort + columns.
// `savedViewVersion` rides here rather than as a top-level field because the
// shared persistence hook writes a fixed set of reserved keys plus the feature's
// `extras` blob — so extras is the only channel a feature can add a persisted
// dimension through. It is deliberately NOT surfaced on the hook's public return
// value: it is bookkeeping for the restore path, not view state a toolbar reads.
type SessionsExtras = {
  dateRange: DateRange;
  groupBy: SessionGroupBy;
  savedViewVersion: number;
  /** ISS-6005: hidden-columns migration marker — see the schema field above. */
  hiddenColumnsVersion: number;
};

// Stable module-level reference so the shared hook's restore effect (which takes
// `defaultExtras` as a dependency) does not see a fresh object every render.
const DEFAULT_SESSIONS_EXTRAS: SessionsExtras = {
  dateRange: DEFAULT_SESSIONS_DATE_RANGE,
  groupBy: SessionGroupBy.None,
  savedViewVersion: SESSIONS_SAVED_VIEW_VERSION,
  hiddenColumnsVersion: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
};

function parseSavedView(
  raw: unknown
): RestoredTableView<
  SessionSortKey | null,
  SessionSortDir,
  SessionsExtras
> | null {
  return parseSavedViewInternal(raw, false);
}

/**
 * ISS-4890: the same parser, with the one-time saved-view migrations applied on
 * the way out — used only while the fold-legibility flag is on.
 *
 * Selected as a whole function (rather than the migration being a branch inside
 * one parser) because the shared persistence hook takes `parse` as a dependency
 * and expects a stable module-level reference; two module-level functions swap
 * cleanly, a closure over the flag would not.
 */
function parseSavedViewWithMigrations(
  raw: unknown
): RestoredTableView<
  SessionSortKey | null,
  SessionSortDir,
  SessionsExtras
> | null {
  return parseSavedViewInternal(raw, true);
}

function parseSavedViewInternal(
  raw: unknown,
  applyMigrations: boolean
): RestoredTableView<
  SessionSortKey | null,
  SessionSortDir,
  SessionsExtras
> | null {
  const result = savedViewSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  const {
    sortKey,
    sortDir,
    hiddenColumns: storedHiddenColumns,
    columnOrder: storedColumnOrder,
    dateRange,
    groupBy,
    savedViewVersion,
    hiddenColumnsVersion,
  } = result.data;
  // ISS-5770: THE restore boundary — every persisted column id enters the app
  // through here, so this is the one place the `branch` → `branches` rename has
  // to be absorbed. Applied to BOTH arrays, before anything downstream reads
  // them: `columnOrder` feeds the migration and `orderColumns` (a stale id there
  // sends the column to the end of the user's arrangement), and `hiddenColumns`
  // feeds the visible-column set (a stale id there silently stops hiding the
  // column the user hid).
  //
  // Normalising here rather than at each consumer is deliberate: a consumer that
  // forgot the alias would fail silently and differently from its siblings,
  // which is the drift ISS-5713 is about. Idempotent, so a view already written
  // with the new spelling is untouched.
  const hiddenColumns = storedHiddenColumns.map(normalizeSessionColumnId);
  const columnOrder = storedColumnOrder.map(normalizeSessionColumnId);
  // ISS-6005: the hidden-columns migration runs UNCONDITIONALLY — in BOTH
  // parsers, unlike the flag-gated column-order migration below. The defect it
  // repairs (a persisted view rendering a column this build ships default-hidden
  // — PR/Merge/Started on views predating ISS-5315, and `Updated` / `Projects` /
  // `Issues` on any view that predates their addition) must not depend on an
  // unrelated flag resolving on. Version-stamped via its own marker so a user
  // who re-shows a column afterwards is not fought on the next load; the
  // shared hook re-persists the migrated view after restore, which is what
  // advances the stored marker.
  const migratedHidden = migrateSavedHiddenColumns(
    hiddenColumns,
    hiddenColumnsVersion
  );
  // Flag OFF: the stored order and its version are returned untouched, so
  // nothing is rewritten and the next load still sees an unmigrated view.
  const migrated = applyMigrations
    ? migrateSavedColumnOrder(
        columnOrder,
        SESSIONS_DATA_COLUMN_ORDER,
        savedViewVersion,
        {
          // ISS-4890 (wongk + stage review): the relocation is bounded by the
          // legible-width budget, not only by a canonical predecessor — a
          // predecessor the user dragged past the fold would otherwise drag Cost
          // past it too, hiding a figure that was legible and then stamping the
          // view so it is never revisited. THIS view's hidden columns are passed
          // because a hidden column renders no track and so costs nothing.
          budgetPx: SESSIONS_LEGIBLE_COLUMN_BUDGET_PX,
          // The POST-migration hidden set: a column the hidden migration just
          // hid renders no track, so the budget arithmetic must not charge it.
          hiddenColumnIds: new Set(migratedHidden.hiddenColumns),
          leadWidthPx: SESSIONS_LEAD_COLUMN_MIN_WIDTH_PX,
          widthsPx: SESSIONS_COLUMN_WIDTH_PX,
        }
      )
    : { columnOrder, version: savedViewVersion };
  return {
    sortKey,
    sortDir,
    hiddenColumns: migratedHidden.hiddenColumns,
    columnOrder: migrated.columnOrder,
    extras: {
      dateRange,
      groupBy,
      savedViewVersion: migrated.version,
      hiddenColumnsVersion: migratedHidden.version,
    },
  };
}

/**
 * Session-scoped view state for the Sessions toolbar: sort key + direction, the
 * time window, and the visible data-column set. Wraps the shared
 * `usePersistedTableViewState` (which owns the sort/columns/persistence
 * machinery). Composes with the page's own filter + pagination state.
 *
 * When `persistKey` is provided the dimensions are restored from `localStorage`
 * on mount and re-persisted on every change, keyed by surface. Persistence is
 * fail-soft.
 */
export function useSessionsViewState(persistKey?: string) {
  // ISS-4890: gates the one-time relocation of a persisted `columnOrder`'s Cost
  // column to its canonical pre-fold slot. Read OPTIONALLY so a mount without a
  // flag provider (Storybook, hook tests) resolves OFF and restores the stored
  // view verbatim.
  //
  // A LATE resolve applies mid-session, not on the next load (wongk review): the
  // gate picks the parser below, and `usePersistedTableViewState` re-runs its
  // restore whenever the parser identity changes, so the false→true flip
  // re-reads the stored view through the migrating parser. That matters most on
  // Desktop, where every Labs key starts `false` and hydrates asynchronously
  // while Sessions stays mounted — a restore-wins race would otherwise leave the
  // view unmigrated on every single launch.
  const foldLegibilityEnabled = useFeatureFlagEnabledOptional(
    SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY
  );
  const {
    sortKey,
    sortDir,
    extras,
    setExtras,
    visibleColumns,
    columnOrder,
    setColumnOrder,
    setSort,
    toggleSortDir,
    toggleColumn,
    resetColumns,
  } = usePersistedTableViewState<
    SessionSortKey | null,
    SessionSortDir,
    string,
    SessionsExtras
  >({
    persistKey,
    keyPrefix: "sessions:saved-view:",
    // Includes the always-shown, non-toggleable `autonomy` column so a persisted
    // reorder that carries it survives the shared setter's valid-id filter
    // (FEA-4150). The columns menu is built separately from
    // SESSIONS_TOGGLEABLE_COLUMNS, so autonomy stays out of the show/hide menu.
    columnIds: SESSIONS_ORDERABLE_COLUMN_IDS,
    // PLN-1034: default to most-recent genuine activity, descending. A persisted
    // view still wins; a persisted null (older saved view) also resolves here.
    // ISS-5315: PR / Merge / Started ship hidden. Only seeds a never-saved view
    // (and "Reset view") — a saved view's own `hiddenColumns` still wins.
    defaultHiddenColumns: SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS,
    defaultSortKey: SortKey.LastActivity,
    defaultSortDir: SortDir.Desc,
    sortDirs: [SortDir.Asc, SortDir.Desc],
    defaultExtras: DEFAULT_SESSIONS_EXTRAS,
    parse: foldLegibilityEnabled
      ? parseSavedViewWithMigrations
      : parseSavedView,
  });

  const setDateRange = useCallback(
    (dateRange: DateRange) => setExtras((prev) => ({ ...prev, dateRange })),
    [setExtras]
  );

  const setGroupBy = useCallback(
    (groupBy: SessionGroupBy) => setExtras((prev) => ({ ...prev, groupBy })),
    [setExtras]
  );

  /**
   * The View menu's "Reset view" — back to how the surface ships.
   *
   * #4480 (wongk): that has to include the Group-by dimension. It is persisted
   * in the same saved view, chosen from the same menu, and sits directly above
   * the control that resets it, so a reset that restored the columns and left
   * the rows banded was not a reset. `resetColumns` alone (the shared hook's
   * column-only reset) is what shipped, which is the bug.
   */
  const resetView = useCallback(() => {
    resetColumns();
    setGroupBy(DEFAULT_SESSIONS_EXTRAS.groupBy);
  }, [resetColumns, setGroupBy]);

  return {
    sortKey,
    sortDir,
    dateRange: extras.dateRange,
    groupBy: extras.groupBy,
    setGroupBy,
    visibleColumns,
    columnOrder,
    setColumnOrder,
    setSort,
    toggleSortDir,
    setDateRange,
    toggleColumn,
    resetColumns,
    resetView,
  };
}

/**
 * FEA-4006: glanceable column set for embedded dashboard / telemetry / insights
 * mini-tables. Owner is now a shown-by-default column on the primary Sessions
 * lists, but those compact tables are "which sessions ran this / recent
 * activity" reads, not the fleet operator view — Owner would add a 180px track
 * they never carried before (previously Owner was opt-in, so a no-`visibleColumns`
 * mini-table dropped it). Passing this set preserves the prior compact layout by
 * rendering every toggleable column except Owner.
 *
 * ISS-5666: `Signals` is NO LONGER excluded. ISS-5282 could leave it out because
 * with its flag off the qualifier chips still rendered beside the session name,
 * so a mini-table without the column still showed them. Retiring that flag
 * removed the lead-cell placement, which turned this exclusion into a silent
 * drop: these embeds mount `SyncedSessionsTable` (it wires `renderQualifiers`),
 * so excluding the id was the only thing standing between the row and its
 * `Awaiting input` / `Local only` / transcript verdict. Dropping a verdict is
 * the one thing this vocabulary must never do, so the column rides along.
 */
export const SESSIONS_GLANCEABLE_COLUMNS: Set<string> = new Set(
  SESSIONS_COLUMN_IDS.filter(
    (id) =>
      id !== "owner" &&
      // FEA-4209 / FEA-4210: excluded for the same reason Owner is — two more
      // 160px tracks is not a glanceable "which sessions ran this" read. These
      // hosts do not opt into the columns anyway, so this only keeps the set
      // honest about what a compact table is.
      id !== SESSIONS_PROJECTS_COLUMN_ID &&
      id !== SESSIONS_ISSUES_COLUMN_ID &&
      // ISS-6005: `Updated` is excluded for the same reason, and for one more.
      // These embedded hosts pass this set explicitly and mount NO View menu,
      // so an id in it is not "on by default, one click from off" — it is
      // permanently on. The column ships default-HIDDEN on the primary lists
      // (SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS), so including it here would let a
      // column the ticket declares off render unconditionally on the two
      // surfaces that cannot turn it off, and spend a 120px track on a
      // record-mutation clock that mostly repeats the `Last active` column
      // sitting beside it.
      //
      // This is deliberately a per-id exclusion rather than deriving the set
      // from SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS: `pr`, `merge`, and `started`
      // are also default-hidden yet belong here, because these embeds carried
      // them before the ISS-5315 defaults existed. Rederiving the set would
      // silently drop three columns from the mini-tables, which is a different
      // change than this ticket's.
      id !== SESSIONS_UPDATED_COLUMN_ID
  )
);

/**
 * ISS-5282: the columns-menu entries for a given surface, including the
 * row-qualifiers (`Signals`) column.
 *
 * The column started life OUT of the menu entirely, on the argument that a menu
 * entry is perceivable UI and so listing it would leak a closed-by-default
 * feature. Paying for that with a permanently unhideable column was the wrong
 * trade (review cid 3731458717): every other optional column here is the user's
 * to turn off, and a cloud-only web list renders this one as a column of dashes
 * on most rows.
 *
 * ISS-5666 retired the `sessions-row-qualifiers-column` gate to its ENABLED
 * state, so the leak argument no longer applies to anyone — the entry is offered
 * unconditionally and the column hides like any other.
 *
 * A function rather than reading {@link SESSIONS_TOGGLEABLE_COLUMNS} at the call
 * site so the menu and the table cannot drift.
 *
 * ISS-5770 review (codex + wongk): it takes the SAME `enabledGates` /
 * `hostSuppliedColumnIds` pair `SessionsTable` hands
 * {@link resolveRenderedSessionColumnIds}, and answers with the SAME
 * {@link selectOfferableSessionColumns} derivation, reading each column's `gate`
 * off the declaration.
 *
 * It used to take a single `linkedEntityColumnsEnabled` boolean and subtract a
 * hardcoded `projects`/`issues` pair. That was the very duplication this ticket
 * exists to remove, surviving in the menu path: a column added behind any OTHER
 * gate would have compiled, stayed absent from the table (whose resolver reads
 * `spec.gate`), and still shown a switch in this menu — a control that toggles
 * a column the user cannot see. Two hosts asking one question two ways is how
 * that happens; now there is one question and one answer.
 */
export function sessionsToggleableColumns({
  enabledGates = {},
  hostSuppliedColumnIds,
}: {
  enabledGates?: SessionsColumnGateState;
  hostSuppliedColumnIds?: readonly string[];
} = {}): readonly { id: SessionColumnId; label: string }[] {
  return selectOfferableSessionColumns(SESSIONS_TOGGLEABLE_COLUMN_SPECS, {
    enabledGates,
    ...(hostSuppliedColumnIds ? { hostSuppliedColumnIds } : {}),
  }).map((column) => ({ id: column.id, label: column.label }));
}
