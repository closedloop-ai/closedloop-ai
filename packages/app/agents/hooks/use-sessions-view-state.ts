"use client";

import { GridPreferenceGridKey } from "@repo/api/src/types/grid-preferences";
import { useCallback, useMemo } from "react";
import { z } from "zod";
import { isListCustomFieldWidthColumnId } from "../../custom-fields/lib/list-custom-field-columns";
import {
  type RestoredTableView,
  usePersistedTableViewState,
} from "../../shared/hooks/use-persisted-table-view-state";
import {
  DATE_RANGES,
  type DateRange,
  DEFAULT_DATE_RANGE,
} from "../../shared/lib/format-utils";
import {
  advanceViewStateVersions,
  legacyViewStateVersions,
  PERSISTED_COLUMN_WIDTHS_SCHEMA,
  PERSISTED_PAGE_SIZE_SCHEMA,
  PERSISTED_STRING_ARRAY_SCHEMA,
  PERSISTED_VERSION_MARKER_SCHEMA,
  PERSISTED_VIEW_STATE_VERSIONS_SCHEMA,
  persistedEnumValues,
  resolveViewStateVersions,
  VIEW_STATE_AXIS_UNUSED,
  ViewStateAxis,
  type ViewStateLegacyMirrors,
  type ViewStateVersions,
  viewStateVersionOf,
} from "../../shared/lib/view-state-axes";
import { coerceSessionGroupBy, SessionGroupBy } from "../lib/session-grouping";
import {
  type SessionSortDir,
  type SessionSortKey,
  type SessionSortRule,
  SessionSortDir as SortDir,
  SessionSortKey as SortKey,
} from "../lib/session-sort-group";
import { selectOfferableSessionColumns } from "../lib/sessions-column-visibility";
import {
  migrateSavedColumnOrder,
  migrateSavedHiddenColumns,
  SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
  SESSIONS_SAVED_VIEW_VERSION,
} from "../lib/sessions-saved-view-migration";
import {
  normalizeSessionColumnId,
  SESSIONS_AUTONOMY_COLUMN_ID,
  SESSIONS_COLUMN_SPECS,
  SESSIONS_DATA_COLUMN_ORDER,
  SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS,
  SESSIONS_ISSUES_COLUMN_ID,
  SESSIONS_LEAD_COLUMN_MIN_WIDTH_PX,
  SESSIONS_LEGIBLE_COLUMN_BUDGET_PX,
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_UPDATED_COLUMN_ID,
  type SessionsColumnGateState,
  type SessionsColumnId,
} from "../lib/sessions-table-columns";
import { TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_WIDTH_PX } from "../lib/sessions-total-estimated-cost-columns";

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
 * applies and is unchanged by this: a host that renders this list without the
 * user's persisted `columnOrder` leaves the menu behind after someone
 * drag-reorders a header (FEA-4021) — the table moves and the menu does not.
 * Default-state agreement is the guarantee; tracking a customised order is not.
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

const SORT_KEYS = persistedEnumValues(SortKey);
const SORT_DIRS = persistedEnumValues(SortDir);
const GROUP_BY_VALUES = persistedEnumValues(SessionGroupBy);

const secondarySortSchema = z.object({
  direction: z.enum(SORT_DIRS),
  // ISS-9447 M3: normalized through the same rename map the column axes use.
  // A secondary rule naming a renamed column is a stored SORT id, and an
  // unmapped one fails the closed enum, which drops the WHOLE rule list.
  fieldId: z.preprocess(normalizeStoredSortKey, z.enum(SORT_KEYS)),
});

const savedViewSchema = z.object({
  // Null = no explicit sort: queries omit sortBy so the server uses its default
  // order (and the desktop local source keeps its fast paginated path).
  //
  // ISS-9447 M3: the stored id is normalized BEFORE the closed enum runs, which
  // is the only order that works — `z.enum` rejects a renamed id, and a rejected
  // `sortKey` fails the whole object parse and discards the reader's columns,
  // window and grouping along with their sort. Normalizing first fixes that
  // without widening the enum, which a `.catch` would have done permanently.
  sortKey: z
    .preprocess(normalizeStoredSortKey, z.enum(SORT_KEYS).nullable())
    .default(null),
  sortDir: z.enum(SORT_DIRS),
  /**
   * ISS-8335: the sort rules AFTER `sortKey`/`sortDir`, in priority order.
   *
   * The v2 toolbar stacks rules and this view had one slot, so the rest lived in
   * host-component state, reached no query, and reordered nothing. They are
   * persisted here for the same reason the primary is — a rule the reader can
   * see in the toolbar has to be a rule the next read applies.
   *
   * Entries are validated against the SAME closed `SORT_KEYS`/`SORT_DIRS` the
   * primary uses, and a malformed or unknown entry drops the WHOLE list back to
   * empty rather than the view: the fields are optional with a `[]` default, so
   * a view written before this existed restores as "no secondary rules", which
   * is exactly what it meant.
   */
  secondarySorts: z
    .preprocess(
      (value) => (Array.isArray(value) ? value : []),
      z.array(secondarySortSchema).catch([])
    )
    .default([]),
  // Time window for the list + summary metrics. Defaults to the shared
  // DEFAULT_DATE_RANGE (the SSOT the honest empty state compares the active
  // window against to tell a narrowed filter from the default).
  dateRange: z.enum(DATE_RANGES).default(DEFAULT_DATE_RANGE),
  // ISS-5315: persisted Group-by dimension. An unknown/legacy value degrades to
  // "none" rather than failing the whole view parse.
  groupBy: z
    .preprocess((value) => coerceSessionGroupBy(value), z.enum(GROUP_BY_VALUES))
    .default(SessionGroupBy.None),
  hiddenColumns: PERSISTED_STRING_ARRAY_SCHEMA,
  // FEA-4021: persisted data-column order (ids). Same data-cleaning preprocess
  // as `hiddenColumns` — keep only the string entries; a missing/non-array
  // value degrades to the table's natural order.
  columnOrder: PERSISTED_STRING_ARRAY_SCHEMA,
  // ISS-9447 M2 declared this so a width map a NEWER build persisted survived
  // this build's mount: `usePersistedTableViewState` writes the whole record on
  // restore, so an undeclared field is stripped by this `z.object` and then
  // written back as `{}` — a whole axis destroyed by a reader who only opened
  // the page. ISS-9567 gave the axis a READER as well as a keeper; Sessions has
  // shipped drag-resizable headers throughout, which is what made the sentence
  // this replaces wrong rather than merely narrow.
  //
  // ISS-10356 (Perrin, confirmed with Marisol, 2026-09-15): this axis carries
  // `custom-field:*` widths beside the declared columns' — see
  // `isWidthOnlyColumnId` below. Custom-field VISIBILITY is deliberately NOT in
  // this record and stays host-local (FEA-4222): a saved view restores how a
  // custom column the host shows LOOKS, never WHICH custom fields it shows.
  columnWidths: PERSISTED_COLUMN_WIDTHS_SCHEMA,
  // ISS-4890: which one-time saved-view migrations have already been applied to
  // THIS stored view. Absent (every view written before ISS-4890) or malformed
  // degrades to `SESSIONS_SAVED_VIEW_UNVERSIONED`, which is exactly the "never
  // migrated" state — so an older or corrupt marker is safe rather than skipping
  // a repair. A version from a NEWER build is preserved verbatim (see
  // `migrateSavedColumnOrder`) instead of being rolled back.
  //
  // ISS-9447 M2: this and `hiddenColumnsVersion` are now the LEGACY MIRROR of
  // `viewStateVersions` below. Still read (a view written before the envelope
  // carries only these) and still written (a build without the envelope reads
  // only these), which is what makes the new shape an additive superset.
  savedViewVersion: PERSISTED_VERSION_MARKER_SCHEMA,
  // FEA-4217: summary cards the reader has switched off in the toolbar's Options
  // menu. Stored as the HIDDEN ids, the same direction `hiddenColumns` uses, so
  // a card added in a later build is visible for a reader whose stored view
  // predates it instead of silently missing until they reset. Same data-cleaning
  // preprocess: keep only the string entries, degrade a missing/non-array value
  // to "nothing hidden" rather than failing the whole view parse.
  hiddenSummaryCards: PERSISTED_STRING_ARRAY_SCHEMA,
  // ISS-6005: which one-time HIDDEN-COLUMNS migrations have been applied to
  // this stored view. A separate marker from `savedViewVersion` because the
  // column-order migrations are flag-gated while this one runs for everyone —
  // see `SESSIONS_SAVED_VIEW_HIDDEN_VERSION`. Absent/malformed degrades to
  // unversioned ("never migrated"), the safe direction.
  hiddenColumnsVersion: PERSISTED_VERSION_MARKER_SCHEMA,
  // ISS-9447 M2: the canonical per-axis envelope. Laid OVER the two legacy
  // markers above, so a record carrying only those still restores every stamp
  // and a record carrying both takes the envelope's answer.
  viewStateVersions: PERSISTED_VIEW_STATE_VERSIONS_SCHEMA,
  // ISS-9692: persisted rows-per-page. A malformed or non-positive value
  // degrades to `undefined` ("nothing stored", so the surface default stands)
  // rather than failing the whole view parse and costing the reader their sort
  // and columns too. It is NOT clamped to the ladder here — the ladder moves
  // with a feature flag, so the raw choice is kept and resolved at render
  // (`useTablePageSizeOptions`).
  pageSize: PERSISTED_PAGE_SIZE_SCHEMA,
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
  /** ISS-8335: the sort rules after the primary — see the schema field above. */
  secondarySorts: readonly SessionSortRule[];
  /**
   * ISS-9447 M2: the canonical per-axis stamps. The two scalars below are its
   * LEGACY MIRROR, derived from it by `advanceViewStateVersions` at the one
   * place the view is assembled, so the envelope and the fields beside it
   * cannot drift — and required rather than optional, for the reason
   * `SESSIONS_VIEW_STATE_MIRRORS` gives.
   */
  viewStateVersions: ViewStateVersions;
  savedViewVersion: number;
  /** ISS-6005: hidden-columns migration marker — see the schema field above. */
  hiddenColumnsVersion: number;
  /** FEA-4217: switched-off summary cards — see the schema field above. */
  hiddenSummaryCards: readonly string[];
};

/**
 * ISS-9447: which extras field mirrors each axis, and the reason the mirror is
 * mandatory rather than a courtesy.
 *
 * A build deployed before the envelope existed parses this view with a plain
 * `z.object`, which strips `viewStateVersions`, and re-serializes a fixed field
 * set that never names it — so the envelope is DELETED by any round trip
 * through such a build, and nothing we do here can change that. The loose
 * mirror is the only channel that survives it. `ViewStateLegacyMirrors` makes
 * that structural: it is exhaustive over `ViewStateAxis`, so a new axis fails
 * `tsc` here until it names a real `SessionsExtras` field, and
 * `advanceViewStateVersions` will not stamp an axis this table leaves unused.
 * An envelope-only axis therefore cannot ship — which matters because it would
 * come back reading as never-migrated and re-run every step, re-hiding a column
 * the reader deliberately showed (ISS-6065) by a third route.
 */
const SESSIONS_VIEW_STATE_MIRRORS = {
  [ViewStateAxis.ColumnOrder]: "savedViewVersion",
  [ViewStateAxis.HiddenColumns]: "hiddenColumnsVersion",
  // Sessions persists no sort migration, so it has no marker to mirror.
  [ViewStateAxis.Sort]: VIEW_STATE_AXIS_UNUSED,
} as const satisfies ViewStateLegacyMirrors<SessionsExtras>;

/** The stamps a NEVER-SAVED view starts at: every repair this build ships is moot. */
const DEFAULT_SESSIONS_AXIS_VERSIONS = {
  [ViewStateAxis.ColumnOrder]: SESSIONS_SAVED_VIEW_VERSION,
  [ViewStateAxis.HiddenColumns]: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
} as const;

const DEFAULT_SESSIONS_VERSION_STATE = advanceViewStateVersions(
  SESSIONS_VIEW_STATE_MIRRORS,
  {},
  DEFAULT_SESSIONS_AXIS_VERSIONS
);

// Stable module-level reference so the shared hook's restore effect (which takes
// `defaultExtras` as a dependency) does not see a fresh object every render.
const DEFAULT_SESSIONS_EXTRAS: SessionsExtras = {
  dateRange: DEFAULT_DATE_RANGE,
  groupBy: SessionGroupBy.None,
  secondarySorts: [],
  viewStateVersions: DEFAULT_SESSIONS_VERSION_STATE.versions,
  ...DEFAULT_SESSIONS_VERSION_STATE.mirrors,
  hiddenSummaryCards: [],
};

/** ISS-4890: applies the one-time saved-view migrations on the way out. */
function parseSavedViewWithMigrations(
  raw: unknown
): RestoredTableView<
  SessionSortKey | null,
  SessionSortDir,
  SessionsExtras
> | null {
  return parseSavedViewInternal(raw);
}

function parseSavedViewInternal(
  raw: unknown
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
    columnWidths,
    dateRange,
    groupBy,
    savedViewVersion,
    hiddenColumnsVersion,
    viewStateVersions,
    hiddenSummaryCards,
    secondarySorts,
    pageSize,
  } = result.data;
  // ISS-9447 M2: the legacy marker names are mapped to axes by THIS surface's
  // table, not in the shared module. `savedViewVersion` means the COLUMN-ORDER
  // axis on this surface and the SORT axis on Agent Components — the two do not
  // collide only because the surfaces use different storage keys — so one table
  // naming both would silently stamp one axis with the other's repair.
  const storedVersions = resolveViewStateVersions(
    legacyViewStateVersions(SESSIONS_VIEW_STATE_MIRRORS, {
      hiddenColumnsVersion,
      savedViewVersion,
    }),
    viewStateVersions
  );
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
  // ISS-6005: the hidden-columns migration is version-stamped via its own marker
  // so a user who re-shows a column afterwards is not fought on the next load;
  // the shared hook re-persists the migrated view after restore, which is what
  // advances the stored marker.
  const migratedHidden = migrateSavedHiddenColumns(
    hiddenColumns,
    viewStateVersionOf(storedVersions, ViewStateAxis.HiddenColumns)
  );
  const migrated = migrateSavedColumnOrder(
    columnOrder,
    SESSIONS_DATA_COLUMN_ORDER,
    viewStateVersionOf(storedVersions, ViewStateAxis.ColumnOrder),
    {
      // ISS-4890 (whitlockk + stage review): the relocation is bounded by the
      // legible-width budget, not only by a canonical predecessor — a
      // predecessor the user dragged past the fold would otherwise drag Cost
      // past it too, hiding a figure that was legible and then stamping the
      // view so it is never revisited. THIS view's hidden columns are passed
      // because a hidden column renders no track and so costs nothing.
      budgetPx: SESSIONS_LEGIBLE_COLUMN_BUDGET_PX,
      // The POST-migration hidden set: a column the hidden migration just hid
      // renders no track, so the budget arithmetic must not charge it.
      hiddenColumnIds: new Set(migratedHidden.hiddenColumns),
      leadWidthPx: SESSIONS_LEAD_COLUMN_MIN_WIDTH_PX,
      // The map `SessionsTable` actually DRAWS, not the spec declaration.
      // ISS-10636 widened the Cost track to 168px for the one dollar phrase; a
      // budget charging the spec's 124 calls a placement legible that ends 44px
      // past the fold, and then stamps the view so it is never revisited
      // (tamsinb review).
      widthsPx: TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_WIDTH_PX,
    }
  );
  // The envelope the migrated view is re-persisted with: every stamp the record
  // arrived with, including one for an axis only a NEWER build names, with the
  // two axes this build just ran laid over it — plus the legacy mirrors derived
  // from the same value, so the envelope and the fields beside it cannot drift.
  const advanced = advanceViewStateVersions(
    SESSIONS_VIEW_STATE_MIRRORS,
    storedVersions,
    {
      [ViewStateAxis.ColumnOrder]: migrated.version,
      [ViewStateAxis.HiddenColumns]: migratedHidden.version,
    }
  );
  return {
    sortKey,
    sortDir,
    hiddenColumns: migratedHidden.hiddenColumns,
    columnOrder: migrated.columnOrder,
    columnWidths,
    pageSize,
    extras: {
      dateRange,
      groupBy,
      viewStateVersions: advanced.versions,
      ...advanced.mirrors,
      hiddenSummaryCards,
      secondarySorts,
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
  const {
    sortKey,
    sortDir,
    extras,
    setExtras,
    isViewReady,
    visibleColumns,
    columnOrder,
    setColumnOrder,
    columnWidths,
    setColumnWidth,
    pageSize,
    setPageSize,
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
    // ISS-9450: the account-level copy of this record. Inert until the
    // closed-by-default gate inside `useGridPreferenceRemote` opens.
    gridKey: GridPreferenceGridKey.Sessions,
    // Includes the always-shown, non-toggleable `autonomy` column so a persisted
    // reorder that carries it survives the shared setter's valid-id filter
    // (FEA-4150). The columns menu is built separately from
    // SESSIONS_TOGGLEABLE_COLUMNS, so autonomy stays out of the show/hide menu.
    columnIds: SESSIONS_ORDERABLE_COLUMN_IDS,
    // ISS-10356: widths only — see `columnWidths` in the schema above. A
    // custom-field id stays out of `columnIds`, so the record never restores it
    // into the visible set; `toSessionsHostViewState` keeps it out of the
    // hidden one.
    isWidthOnlyColumnId: isListCustomFieldWidthColumnId,
    // PLN-1034: default to most-recent genuine activity, descending. A persisted
    // view still wins; a persisted null (older saved view) also resolves here.
    // ISS-5315: PR / Merge / Started ship hidden. Only seeds a never-saved view
    // (and "Reset view") — a saved view's own `hiddenColumns` still wins.
    defaultHiddenColumns: SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS,
    defaultSortKey: SortKey.LastActivity,
    defaultSortDir: SortDir.Desc,
    sortDirs: [SortDir.Asc, SortDir.Desc],
    defaultExtras: DEFAULT_SESSIONS_EXTRAS,
    resetColumnVersions: resetSessionsColumnVersions,
    parse: parseSavedViewWithMigrations,
  });

  const hiddenSummaryCards = useMemo(
    () => new Set(extras.hiddenSummaryCards),
    [extras.hiddenSummaryCards]
  );

  const setDateRange = useCallback(
    (dateRange: DateRange) => setExtras((prev) => ({ ...prev, dateRange })),
    [setExtras]
  );

  const setGroupBy = useCallback(
    (groupBy: SessionGroupBy) => setExtras((prev) => ({ ...prev, groupBy })),
    [setExtras]
  );

  /**
   * FEA-4217: flip one summary card's visibility.
   *
   * Reported one id at a time rather than as a whole replacement set, matching
   * `toggleColumn` and the design-system Options menu's own contract — a caller
   * that had to hand back a Set would have to hold visibility in local state,
   * which is exactly what persisting it here is meant to avoid.
   */
  const toggleSummaryCard = useCallback(
    (cardId: string) =>
      setExtras((prev) => {
        const next = new Set(prev.hiddenSummaryCards);
        if (next.has(cardId)) {
          next.delete(cardId);
        } else {
          next.add(cardId);
        }
        return { ...prev, hiddenSummaryCards: [...next] };
      }),
    [setExtras]
  );

  /**
   * The View menu's "Reset view" — back to how the surface ships.
   *
   * #4480 (whitlockk): that has to include the Group-by dimension. It is persisted
   * in the same saved view, chosen from the same menu, and sits directly above
   * the control that resets it, so a reset that restored the columns and left
   * the rows banded was not a reset. `resetColumns` alone (the shared hook's
   * column-only reset) is what shipped, which is the bug.
   */
  const resetView = useCallback(() => {
    resetColumns();
    // FEA-4217: for the same reason Group-by is here. A hidden summary card is
    // persisted in the same saved view and switched off from the same menu, so a
    // "Reset view" that restored the columns and left the strip missing two
    // cards would not be a reset.
    setExtras((prev) => ({
      ...prev,
      groupBy: DEFAULT_SESSIONS_EXTRAS.groupBy,
      hiddenSummaryCards: DEFAULT_SESSIONS_EXTRAS.hiddenSummaryCards,
      // ISS-8335: for the same reason as the two above. A secondary sort rule is
      // persisted in this same view and set from the same toolbar, so a "Reset
      // view" that restored the columns and left the list still ordered by a
      // second rule would not be a reset.
      secondarySorts: DEFAULT_SESSIONS_EXTRAS.secondarySorts,
    }));
  }, [resetColumns, setExtras]);

  /**
   * ISS-8335: replace the sort rules AFTER the primary.
   *
   * A sibling of `setSort` rather than a widening of it, because the two write
   * different stores — the primary is the shared hook's own `sortKey`/`sortDir`,
   * the rest is this surface's `extras`. A caller that moves the primary and the
   * tail in one gesture calls both; they land in the same render.
   */
  const setSecondarySorts = useCallback(
    (next: readonly SessionSortRule[]) => {
      setExtras((prev) => ({ ...prev, secondarySorts: next }));
    },
    [setExtras]
  );

  return {
    sortKey,
    sortDir,
    dateRange: extras.dateRange,
    // ISS-7250: `dateRange` above is still the DEFAULT until the persisted view
    // restores (a post-mount effect by design, FEA-4125). A consumer reporting
    // the window — to telemetry or to a query key — needs to know when it has
    // stopped being a guess, exactly as `useBranchViewState` re-exports this.
    //
    // ISS-6382 (follow-up to ISS-4655): `sortKey`/`sortDir` land in that query
    // key too, so surfaces gate their READ on this and paginate once, against
    // the view the user actually keeps. Fails OPEN after
    // `VIEW_RESTORE_AUTH_DEADLINE_MS`; see the shared hook.
    isViewReady,
    groupBy: extras.groupBy,
    setGroupBy,
    // FEA-4217: a Set, not the stored array, so the strip and the menu both ask
    // membership rather than each building their own lookup and drifting on how
    // an unknown id is treated. Memoized on the stored array so an unrelated
    // change in this hook does not hand every consumer a fresh identity.
    hiddenSummaryCards,
    toggleSummaryCard,
    visibleColumns,
    columnOrder,
    setColumnOrder,
    // ISS-9567: the record has carried `columnWidths` since ISS-9447 M2; handing
    // it back is what lets a Sessions resize outlive its mount.
    columnWidths,
    setColumnWidth,
    // ISS-9692: the rows-per-page the reader last chose, restored from the same
    // saved view the sort and columns come from. RAW — not clamped to the ladder
    // in force, which is `useTablePageSizeOptions`' job at the render site.
    pageSize,
    setPageSize,
    secondarySorts: extras.secondarySorts,
    setSecondarySorts,
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
 * ISS-5770 review (codex + whitlockk): it takes the SAME `enabledGates` /
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

/**
 * ISS-9447 M3: one stored SORT id, resolved through the column-rename map.
 *
 * The map is keyed by COLUMN id, and every Sessions sort key is its column's id
 * — with one exception, Owner, whose column is `owner` and whose sort key is
 * `user` (`columnIdToSessionSortKey` bridges the two). So renaming Owner would
 * need that bridge as well as this; renaming any other column is covered here.
 *
 * A non-string is returned untouched so `null` ("no explicit sort") and an
 * absent key still reach the schema as themselves.
 */
function normalizeStoredSortKey(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return normalizeSessionColumnId(value);
}

/**
 * ISS-9447: the stamps a "Reset view" puts back, alongside the columns it just
 * rewrote.
 *
 * A reset lands the reader on THIS build's default hidden set and natural order,
 * so the two axes are, by definition, fully repaired at this build's versions.
 * Leaving a newer build's stamp on that payload is the ISS-6065 defect by a
 * second route: the newer build reads its own stamp, skips the step that hides
 * the column it ships hidden, and renders it permanently. The stamp has to
 * describe what is stored, and after a reset that is this build.
 *
 * The envelope is spread first so an axis only a NEWER build names keeps its
 * stamp — the same version-skew rule the restore path follows. A reset of the
 * column axes says nothing about anyone else's.
 */
function resetSessionsColumnVersions(extras: SessionsExtras): SessionsExtras {
  const reset = advanceViewStateVersions(
    SESSIONS_VIEW_STATE_MIRRORS,
    extras.viewStateVersions,
    DEFAULT_SESSIONS_AXIS_VERSIONS
  );
  return {
    ...extras,
    viewStateVersions: reset.versions,
    ...reset.mirrors,
  };
}
