"use client";

import {
  AgentComponentGroupBy,
  AgentComponentSortDir,
  AgentComponentSortKey,
  AgentMetricMode,
  LEGACY_AGENT_METRIC_MODES,
} from "@repo/api/src/types/agent-component";
import { GridPreferenceGridKey } from "@repo/api/src/types/grid-preferences";
import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions";
import { AGENT_COMPONENT_AUTHORS_LABEL } from "@repo/app/agents/lib/agent-component-authors";
import { useCallback } from "react";
import { z } from "zod";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import {
  type RestoredTableView,
  usePersistedTableViewState,
} from "../../shared/hooks/use-persisted-table-view-state";
import {
  AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY,
  AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY,
} from "../../shared/lib/feature-flags";
import {
  advanceViewStateVersions,
  legacyViewStateVersions,
  PERSISTED_COLUMN_WIDTHS_SCHEMA,
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
import {
  AGENTS_SAVED_VIEW_UNVERSIONED,
  AGENTS_SAVED_VIEW_VERSION,
  LEGACY_AGENTS_DEFAULT_SORT,
  migrateSavedSort,
  USAGE_AGENTS_DEFAULT_SORT,
} from "../lib/agents-saved-view-migration";

/**
 * Toggleable data columns for the Agents workspace inventory table. Order is
 * purely for the columns menu; the table owns render order.
 *
 * ISS-4672: this list must contain ONLY columns the grid actually gates on
 * `visibleColumns`. The Name lead and the trailing row-actions column are
 * always-rendered chrome — `agents-table.tsx` renders Name via `LEAD_WIDTH`
 * and appends `ACTIONS_SPEC` (the shared `ROW_ACTIONS_COLUMN`, now declared
 * non-toggleable chrome) unconditionally, and neither id appears in the
 * `COLUMN_SPECS` the table filters by `visibleColumns`. Listing `name`/`actions`
 * here would surface View-menu toggles that write a persisted `hiddenColumns`
 * state the grid never honors (the checkbox flips but the column keeps
 * rendering — a state contradiction). Keep both out of this list.
 */
export const AGENT_COMPONENT_TOGGLEABLE_COLUMNS = [
  { id: "type", label: "Type" },
  // ISS-4866 (review cid 3701359142): the Show/Hide list names this column by
  // the SHARED unit label the grid header renders, not a second word for the
  // same thing. With the metric-mode picker retired, "Metric" was the last place
  // calling the column something its own header does not say. The `metric` id is
  // an internal state key (persisted hiddenColumns / columnOrder) and is
  // deliberately unchanged; only the visible label moved — the same split
  // FEA-4266 made for `collaborators`/"Authors".
  // FEA-4098 (Slice 3): Owner removed; the Authors column is the authors
  // people-set. FEA-4266: only the visible label changed; the `collaborators`
  // column id stays (it is a persisted hiddenColumns/columnOrder state key).
  { id: "collaborators", label: AGENT_COMPONENT_AUTHORS_LABEL },
  { id: "source", label: "Source" },
  { id: "harness", label: "Harness" },
  // ISS-5366: listed where the grid renders it — at the head of the numeric
  // block (see `COLUMN_SPECS` in `agents-table.tsx`). This list IS the
  // Show/Hide menu's visual order, so leaving Metric at position 2 here would
  // make the menu disagree with the table it toggles. Order carries no other
  // meaning: the ids feed a validity `Set` and the derived `AgentComponentColumnId`
  // union, neither of which is position-sensitive.
  {
    id: "metric",
    label:
      LOC_METRIC_DEFINITION[LocMetricDefinitionId.ComponentLinesChanged].label,
  },
  { id: "invocations", label: "Invocations" },
  { id: "sessions", label: "Sessions" },
] as const;

export type AgentComponentColumnId =
  (typeof AGENT_COMPONENT_TOGGLEABLE_COLUMNS)[number]["id"];

// Stable module-level id list so the shared hook's derived memos don't churn.
const AGENT_COMPONENT_COLUMN_IDS: readonly AgentComponentColumnId[] =
  AGENT_COMPONENT_TOGGLEABLE_COLUMNS.map((column) => column.id);

// ISS-5528: the two default-hidden sets, at module scope because the shared
// hook's restore effect takes this array as a dependency and a fresh literal
// every render would re-run the restore on every paint.
const SOURCE_COLUMN_HIDDEN_BY_DEFAULT: readonly AgentComponentColumnId[] = [
  "source",
];
const NO_COLUMNS_HIDDEN_BY_DEFAULT: readonly AgentComponentColumnId[] = [];

// Zod schema for persisted view — same approach as use-sessions-view-state.ts.

const SORT_KEYS = persistedEnumValues(AgentComponentSortKey);
const SORT_DIRS = persistedEnumValues(AgentComponentSortDir);
const GROUP_BY_VALUES = persistedEnumValues(AgentComponentGroupBy);
const METRIC_MODES = persistedEnumValues(AgentMetricMode);

const savedViewSchema = z.object({
  // ISS-5005: a view missing either sort field decodes to the LEGACY default
  // pair, not the flag-selected one, because "absent" is exactly the state the
  // one-time rewrite below is designed to promote. Deciding the promotion in one
  // place (`migrateSavedSort`) keeps the parse honest about what was stored.
  sortKey: z.enum(SORT_KEYS).default(LEGACY_AGENTS_DEFAULT_SORT.sortKey),
  sortDir: z.enum(SORT_DIRS).default(LEGACY_AGENTS_DEFAULT_SORT.sortDir),
  groupBy: z.enum(GROUP_BY_VALUES).default(AgentComponentGroupBy.None),
  // ISS-4667: a view persisted before the LOC/$ reconciliation stores
  // `kloc-per-dollar` or the inverted `dollar-per-kloc`. Migrate those to the
  // canonical mode BEFORE the enum check — an unmigrated legacy value would fail
  // `z.enum`, fail the whole object parse, and silently throw away the user's
  // entire saved view (sort, hidden columns, column order) alongside it.
  metricMode: z
    .preprocess(
      (value) =>
        typeof value === "string" && value in LEGACY_AGENT_METRIC_MODES
          ? LEGACY_AGENT_METRIC_MODES[value]
          : value,
      z.enum(METRIC_MODES)
    )
    .default(AgentMetricMode.LocPerDollar),
  hiddenColumns: PERSISTED_STRING_ARRAY_SCHEMA,
  // FEA-4021: persisted data-column order (ids). Same data-cleaning preprocess
  // as `hiddenColumns` — keep only the string entries; a missing/non-array
  // value degrades to the table's natural order.
  columnOrder: PERSISTED_STRING_ARRAY_SCHEMA,
  // ISS-9447 M2: declared even though the catalog offers no column resizing, so
  // a width map a NEWER build persisted survives this build's mount. The shared
  // hook rewrites the whole record on restore, so an undeclared field is
  // stripped by this `z.object` and written back as `{}` — a whole axis lost to
  // a reader who only opened the page.
  columnWidths: PERSISTED_COLUMN_WIDTHS_SCHEMA,
  // ISS-5005: which one-time saved-view migrations have already been applied to
  // THIS stored view. Absent (every view written before ISS-5005) or malformed
  // degrades to `AGENTS_SAVED_VIEW_UNVERSIONED`, which is exactly the "never
  // migrated" state — so an older or corrupt marker is safe rather than skipping
  // a repair. A version from a NEWER build is preserved verbatim (see
  // `migrateSavedSort`) instead of being rolled back.
  //
  // ISS-9447 M2: this is now the LEGACY MIRROR of `viewStateVersions` below,
  // still read and still written so a build without the envelope keeps working.
  // Note it names the SORT axis here and the COLUMN-ORDER axis on Sessions — the
  // reason the legacy names are mapped per surface and never in one table.
  savedViewVersion: PERSISTED_VERSION_MARKER_SCHEMA,
  // ISS-9447 M2: the canonical per-axis envelope, laid over the legacy marker.
  viewStateVersions: PERSISTED_VIEW_STATE_VERSIONS_SCHEMA,
});

// Feature-specific "extra" dimensions persisted alongside sort + columns.
// `savedViewVersion` rides here rather than as a top-level field because the
// shared persistence hook writes a fixed set of reserved keys plus the feature's
// `extras` blob — so extras is the only channel a feature can add a persisted
// dimension through. It is deliberately NOT surfaced on the hook's public return
// value: it is bookkeeping for the restore path, not view state a toolbar reads.
type AgentComponentsExtras = {
  groupBy: AgentComponentGroupBy;
  metricMode: AgentMetricMode;
  /**
   * ISS-9447 M2: the canonical per-axis stamps. `savedViewVersion` below is its
   * LEGACY MIRROR, derived from it by `advanceViewStateVersions` where the view
   * is assembled so the two cannot drift — and required rather than optional,
   * for the reason `AGENTS_VIEW_STATE_MIRRORS` gives.
   */
  viewStateVersions: ViewStateVersions;
  savedViewVersion: number;
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
 * `tsc` here until it names a real `AgentComponentsExtras` field, and
 * `advanceViewStateVersions` will not stamp an axis this table leaves unused.
 * An envelope-only axis therefore cannot ship — it would come back reading as
 * never-migrated and re-run every step, which on this surface means dragging a
 * reader off the sort they chose and back onto the migrated default.
 */
const AGENTS_VIEW_STATE_MIRRORS = {
  // The catalog persists no column-order or hidden-column migration, so it has
  // no marker to mirror for either.
  [ViewStateAxis.ColumnOrder]: VIEW_STATE_AXIS_UNUSED,
  [ViewStateAxis.HiddenColumns]: VIEW_STATE_AXIS_UNUSED,
  [ViewStateAxis.Sort]: "savedViewVersion",
} as const satisfies ViewStateLegacyMirrors<AgentComponentsExtras>;

// Stable module-level references so the shared hook's restore effect (which
// takes `defaultExtras` as a dependency) does not see a fresh object every
// render.
//
// ISS-5005: the two differ ONLY in the version a FRESH view is stamped with,
// and that difference is load-bearing. `usePersistedTableViewState` writes the
// resolved view as soon as its restore effect commits, so a first visit while
// the flag is OFF persists the legacy sort immediately. Stamping that write
// `UNVERSIONED` leaves it migratable, so a later flag flip still promotes it;
// stamping it current would mark a dark-launch write as already-migrated and
// strand the user on the alphabetical default forever. With the flag ON the
// fresh default already IS the usage sort, so there is nothing to migrate and
// the view is stamped current.
const DEFAULT_EXTRAS_UNVERSIONED: AgentComponentsExtras = {
  groupBy: AgentComponentGroupBy.None,
  metricMode: AgentMetricMode.LocPerDollar,
  ...defaultAgentsVersionState(AGENTS_SAVED_VIEW_UNVERSIONED),
};

const DEFAULT_EXTRAS_MIGRATED: AgentComponentsExtras = {
  groupBy: AgentComponentGroupBy.None,
  metricMode: AgentMetricMode.LocPerDollar,
  ...defaultAgentsVersionState(AGENTS_SAVED_VIEW_VERSION),
};

function parseSavedView(
  raw: unknown
): RestoredTableView<
  AgentComponentSortKey,
  AgentComponentSortDir,
  AgentComponentsExtras
> | null {
  return parseSavedViewInternal(raw, false);
}

/**
 * ISS-5005: the same parser, with the one-time saved-view sort migration applied
 * on the way out — used only while the usage-default flag is on.
 *
 * Selected as a whole function (rather than the migration being a branch inside
 * one parser) because the shared persistence hook takes `parse` as a dependency
 * and expects a stable module-level reference; two module-level functions swap
 * cleanly, a closure over the flag would not.
 */
function parseSavedViewWithMigrations(
  raw: unknown
): RestoredTableView<
  AgentComponentSortKey,
  AgentComponentSortDir,
  AgentComponentsExtras
> | null {
  return parseSavedViewInternal(raw, true);
}

function parseSavedViewInternal(
  raw: unknown,
  applyMigrations: boolean
): RestoredTableView<
  AgentComponentSortKey,
  AgentComponentSortDir,
  AgentComponentsExtras
> | null {
  const result = savedViewSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  const {
    sortKey,
    sortDir,
    hiddenColumns,
    columnOrder,
    columnWidths,
    groupBy,
    metricMode,
    savedViewVersion,
    viewStateVersions,
  } = result.data;
  // ISS-9447 M2: the legacy marker is mapped to THIS surface's axis by its own
  // table. `savedViewVersion` is the SORT stamp on the catalog and the
  // COLUMN-ORDER stamp on Sessions, so the mapping cannot live in the shared
  // module.
  const storedVersions = resolveViewStateVersions(
    legacyViewStateVersions(AGENTS_VIEW_STATE_MIRRORS, { savedViewVersion }),
    viewStateVersions
  );
  // Flag OFF: the stored sort and its version are returned untouched, so the
  // next load still sees an unmigrated view.
  //
  // "Untouched" is about the VIEW, not the stored bytes. The shared persist
  // effect re-serializes the whole view on every mount and now carries
  // `savedViewVersion` in `extras`, so a pre-ISS-5005 view does gain an inert
  // `savedViewVersion: 0` key even on the dark path. That value IS the
  // never-migrated state, so it changes no behavior and leaves the view fully
  // migratable if the flag is later turned on. No sort, column, order, grouping,
  // or metric-mode dimension is altered while the flag is off.
  const storedSortVersion = viewStateVersionOf(
    storedVersions,
    ViewStateAxis.Sort
  );
  const migrated = applyMigrations
    ? migrateSavedSort({ sortDir, sortKey }, storedSortVersion)
    : { sort: { sortDir, sortKey }, version: storedSortVersion };
  // Every stamp the record arrived with — including one for an axis only a
  // NEWER build names — with the sort axis this build just ran laid over it,
  // plus the legacy mirror derived from the same value so the two cannot drift.
  const advanced = advanceViewStateVersions(
    AGENTS_VIEW_STATE_MIRRORS,
    storedVersions,
    { [ViewStateAxis.Sort]: migrated.version }
  );
  return {
    sortKey: migrated.sort.sortKey,
    sortDir: migrated.sort.sortDir,
    hiddenColumns,
    columnOrder,
    columnWidths,
    extras: {
      groupBy,
      metricMode,
      ...advanced.mirrors,
      viewStateVersions: advanced.versions,
    },
  };
}

// Hook

/**
 * View state for the Agents workspace inventory table (T-2.3): sort key +
 * direction, grouping dimension, metric mode, and the visible data-column set.
 * Wraps the shared `usePersistedTableViewState` (which owns the
 * sort/columns/persistence machinery).
 *
 * When `persistKey` is provided (e.g. `"agents:web"` or `"agents:desktop"`),
 * all dimensions are restored from `localStorage` on mount and re-persisted on
 * every change, keyed by surface. Persistence is fail-soft.
 *
 * Surface key convention:
 *   - `"agents:web"`     — web /[orgSlug]/agents page
 *   - `"agents:desktop"` — desktop NavId.Agents renderer
 *
 * ISS-5005: the DEFAULT sort is flag-dependent. Off (the default) it is Component
 * ascending, exactly as shipped; on, it is Invocations descending, and a stored
 * view still carrying the untouched alphabetical default is promoted once. See
 * `agents-saved-view-migration.ts` for why the stored view has to be met too.
 */
export function useAgentComponentsViewState(persistKey?: string) {
  // ISS-5005: gates the usage-bearing default sort and the one-time rewrite of a
  // persisted view still carrying the untouched alphabetical default. Read
  // OPTIONALLY so a mount without a flag provider (Storybook, hook tests)
  // resolves OFF and restores the stored view verbatim.
  //
  // A LATE resolve applies mid-session, not on the next load: the gate picks both
  // the defaults and the parser below, and `usePersistedTableViewState` re-runs
  // its restore whenever either identity changes, so the false→true flip re-reads
  // the stored view through the migrating parser. That matters most on Desktop,
  // where every Labs key starts `false` and hydrates asynchronously while the
  // catalog stays mounted — a restore-wins race would otherwise leave the view
  // unmigrated on every single launch.
  const usageDefaultSortEnabled = useFeatureFlagEnabledOptional(
    AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY
  );
  const defaultSort = usageDefaultSortEnabled
    ? USAGE_AGENTS_DEFAULT_SORT
    : LEGACY_AGENTS_DEFAULT_SORT;
  // ISS-5528 (ISS-4779 closed-by-default): Source is a verbatim echo of the
  // Component name until the ISS-5009 provenance projection graduates — the same
  // string, 196px away, in a different face and colour, and both truncated — so
  // it spends a fixed 196px of a horizontal budget that is already
  // over-subscribed to say nothing new. It stays in the View menu's Show/Hide
  // list, so a reader who wants it is one click away and a stored view that
  // already shows it is untouched; only the DEFAULT changes.
  const sourceColumnOptIn = useFeatureFlagEnabledOptional(
    AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY
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
    isViewReady,
  } = usePersistedTableViewState<
    AgentComponentSortKey,
    AgentComponentSortDir,
    AgentComponentColumnId,
    AgentComponentsExtras
  >({
    persistKey,
    keyPrefix: "agents:saved-view:",
    // ISS-9450: the account-level copy of this record. Inert until the
    // closed-by-default gate inside `useGridPreferenceRemote` opens.
    gridKey: GridPreferenceGridKey.Agents,
    columnIds: AGENT_COMPONENT_COLUMN_IDS,
    defaultHiddenColumns: sourceColumnOptIn
      ? SOURCE_COLUMN_HIDDEN_BY_DEFAULT
      : NO_COLUMNS_HIDDEN_BY_DEFAULT,
    defaultSortKey: defaultSort.sortKey,
    defaultSortDir: defaultSort.sortDir,
    sortDirs: [AgentComponentSortDir.Asc, AgentComponentSortDir.Desc],
    defaultExtras: usageDefaultSortEnabled
      ? DEFAULT_EXTRAS_MIGRATED
      : DEFAULT_EXTRAS_UNVERSIONED,
    parse: usageDefaultSortEnabled
      ? parseSavedViewWithMigrations
      : parseSavedView,
  });

  const setGroupBy = useCallback(
    (groupBy: AgentComponentGroupBy) =>
      setExtras((prev) => ({ ...prev, groupBy })),
    [setExtras]
  );

  const setMetricMode = useCallback(
    (metricMode: AgentMetricMode) =>
      setExtras((prev) => ({ ...prev, metricMode })),
    [setExtras]
  );

  return {
    sortKey,
    sortDir,
    groupBy: extras.groupBy,
    metricMode: extras.metricMode,
    visibleColumns,
    columnOrder,
    setColumnOrder,
    setSort,
    toggleSortDir,
    toggleColumn,
    resetColumns,
    setGroupBy,
    setMetricMode,
    // ISS-6141: the ISS-4655 restore gate, surfaced so the surface can hold its
    // page-data read until the saved sort has landed. `sortKey`/`sortDir` are
    // in that request's query key, so a read issued before the restore is a
    // read of the DEFAULT view that the restore then repeats — and this read
    // costs up to three full org population builds at the producer.
    isViewReady,
  };
}

/** The envelope and its legacy mirror for a never-saved view, from one value. */
function defaultAgentsVersionState(version: number): {
  savedViewVersion: number;
  viewStateVersions: ViewStateVersions;
} {
  const state = advanceViewStateVersions(
    AGENTS_VIEW_STATE_MIRRORS,
    {},
    {
      [ViewStateAxis.Sort]: version,
    }
  );
  return { ...state.mirrors, viewStateVersions: state.versions };
}
