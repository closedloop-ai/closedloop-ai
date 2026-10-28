"use client";

import {
  GridPreferenceGridKey,
  GridPreferenceScopeKey,
} from "@repo/api/src/types/grid-preferences";
import {
  EMPTY_TABLE_COLLAPSED_GROUPS,
  type TableCollapsedGroups,
} from "@repo/app/shared/lib/table-collapsed-groups";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { useCallback, useMemo } from "react";
import { isListCustomFieldWidthColumnId } from "../../custom-fields/lib/list-custom-field-columns";
import {
  type RestoredTableView,
  usePersistedTableViewState,
} from "../../shared/hooks/use-persisted-table-view-state";
import {
  type DateRange,
  DEFAULT_DATE_RANGE,
} from "../../shared/lib/format-utils";
import {
  advanceViewStateVersions,
  legacyViewStateVersions,
  resolveViewStateVersions,
  VIEW_STATE_AXIS_UNUSED,
  ViewStateAxis,
  type ViewStateLegacyMirrors,
  type ViewStateVersions,
} from "../../shared/lib/view-state-axes";
import {
  normalizeBranchColumnIds,
  normalizeBranchColumnWidths,
} from "../lib/branch-column-renames";
import { branchColumnLabel } from "../lib/branch-column-view-model";
import { parseBranchSavedView } from "../lib/branch-saved-view";
import type { BranchAppliedArrangement } from "../lib/branch-saved-views";
import {
  type BranchSortDir,
  type BranchSortKey,
  DEFAULT_BRANCH_SORT_DIR,
  DEFAULT_BRANCH_SORT_KEY,
  BranchSortDir as SortDir,
} from "../lib/branch-sort-group";

/**
 * Toggleable data columns (the Name lead is always shown). Order is purely for
 * the columns menu and the table's default render order.
 */
export const BRANCH_TOGGLEABLE_COLUMNS = [
  { id: "owner", label: branchColumnLabel("owner") },
  { id: "repo", label: branchColumnLabel("repo") },
  { id: "status", label: branchColumnLabel("status") },
  { id: "lastActivity", label: branchColumnLabel("lastActivity") },
  { id: "sessions", label: branchColumnLabel("sessions") },
  { id: "changes", label: branchColumnLabel("changes") },
  { id: "pr", label: branchColumnLabel("pr") },
  { id: "checks", label: "Checks" },
] as const;

/** PRD-601 visibility-only columns in their approved default order. */
export const APPROVED_BRANCH_TOGGLEABLE_COLUMNS = [
  { id: "owner", label: branchColumnLabel("owner") },
  // ISS-10332: listed here or no view state ever holds it visible. Shown by
  // default (operator ruling 5, 2026-09-21), offered only on an opted-in mount.
  { id: "priority", label: branchColumnLabel("priority") },
  { id: "collaborators", label: branchColumnLabel("collaborators") },
  { id: "sessions", label: branchColumnLabel("sessions") },
  { id: "changes", label: branchColumnLabel("changes") },
  { id: "status", label: branchColumnLabel("status") },
  { id: "pr", label: branchColumnLabel("pr") },
  { id: "lastActivity", label: branchColumnLabel("lastActivity") },
  { id: "repo", label: branchColumnLabel("repo") },
  { id: "tags", label: branchColumnLabel("tags") },
  // ISS-12453: listed here or no view state ever holds it visible, same as
  // Priority above — shown by default (operator ruling).
  { id: "project", label: branchColumnLabel("project") },
] as const;

export type BranchColumnId =
  | (typeof BRANCH_TOGGLEABLE_COLUMNS)[number]["id"]
  | (typeof APPROVED_BRANCH_TOGGLEABLE_COLUMNS)[number]["id"];

// Stable module-level id list so the shared hook's derived memos don't churn.
const BRANCH_COLUMN_IDS: readonly BranchColumnId[] =
  BRANCH_TOGGLEABLE_COLUMNS.map((column) => column.id);
const APPROVED_BRANCH_COLUMN_IDS: readonly BranchColumnId[] =
  APPROVED_BRANCH_TOGGLEABLE_COLUMNS.map((column) => column.id);

/**
 * The "extra" dimensions this surface persists alongside sort + columns, named.
 *
 * ISS-9676 put `grouping` here rather than in the list surface's own state:
 * grouping is a view dimension, so it has to be captured and applied by the
 * same hook that owns sort, the window and the column set, or a reader groups
 * the list, saves the view, and gets it back ungrouped.
 */
type BranchKnownExtras = {
  /**
   * ISS-9582: the bands collapsed under each grouping axis, beside `grouping`
   * for the same reason — a saved view that restores the axis and reopens every
   * band is not the view the reader saved.
   */
  collapsedGroups: TableCollapsedGroups;
  dateRange: DateRange;
  grouping: TableGroupingState;
  /** ISS-12664: the summary-card ids the reader hid (the complement of what the strip paints). */
  hiddenSummaryCards: string[];
  /**
   * ISS-9447 M5: the per-axis migration stamps. CARRY-ONLY on this surface —
   * see `BRANCH_VIEW_STATE_MIRRORS`. Deliberately not on the hook's public
   * return: it is restore-path bookkeeping, not view state a toolbar reads.
   */
  viewStateVersions: ViewStateVersions;
};

/**
 * The named dimensions PLUS whatever keys a NEWER build persisted.
 *
 * `extras` is the only channel a Branches key can survive in: the shared hook
 * writes a fixed reserved set plus this blob, so a key that is parsed and then
 * left out of `extras` is deleted on the very next write. The index half is
 * what makes the carry expressible; nothing reads through it.
 */
type BranchExtras = BranchKnownExtras & Record<string, unknown>;

/**
 * ISS-9447 M5: which extras field mirrors each axis — none, on this surface.
 *
 * The mirror channel only works for a field that was ALREADY SHIPPED, because
 * that is what makes an already-deployed build parse it, keep it, and re-emit
 * it. Sessions and Agent Components qualify. Branches has never shipped a
 * version field of any kind, so a mirror invented now would be stripped by the
 * shipped `branchSavedViewSchema` on read and absent from the `extras` that
 * build rebuilds — deleted by exactly the round trip it exists to survive.
 *
 * What carries the envelope past an old Branches build instead is the generic
 * unknown-key preservation this milestone adds: from this build forward the
 * live view round-trips a key it does not name. That makes UNUSED a true
 * statement about today rather than a ceiling — Branches ships zero view-state
 * migrations, so no axis has a step to skip.
 *
 * Declared against `BranchKnownExtras`, never `BranchExtras`: the index
 * signature on the latter would make `keyof` any string and silently accept a
 * mirror field that does not exist. Whoever ships the first Branches migration
 * names a real field here, and `advanceViewStateVersions` below stops
 * typechecking with `{}` until they also compute that axis's version.
 */
const BRANCH_VIEW_STATE_MIRRORS = {
  [ViewStateAxis.ColumnOrder]: VIEW_STATE_AXIS_UNUSED,
  [ViewStateAxis.HiddenColumns]: VIEW_STATE_AXIS_UNUSED,
  [ViewStateAxis.Sort]: VIEW_STATE_AXIS_UNUSED,
} as const satisfies ViewStateLegacyMirrors<BranchKnownExtras>;

const BRANCH_SORT_DIRS: readonly [BranchSortDir, BranchSortDir] = [
  SortDir.Asc,
  SortDir.Desc,
];
const DEFAULT_BRANCH_EXTRAS: BranchExtras = {
  collapsedGroups: EMPTY_TABLE_COLLAPSED_GROUPS,
  dateRange: DEFAULT_DATE_RANGE,
  grouping: EMPTY_TABLE_GROUPING,
  hiddenSummaryCards: [],
  viewStateVersions: {},
};

function parseLegacySavedView(
  raw: unknown
): RestoredTableView<BranchSortKey, BranchSortDir, BranchExtras> | null {
  return parseSavedView(raw);
}

function parseApprovedSavedView(
  raw: unknown
): RestoredTableView<BranchSortKey, BranchSortDir, BranchExtras> | null {
  return parseSavedView(raw);
}

function parseSavedView(
  raw: unknown
): RestoredTableView<BranchSortKey, BranchSortDir, BranchExtras> | null {
  const saved = parseBranchSavedView(raw);
  if (!saved) {
    return null;
  }
  // Every key this build names is destructured out, so `carried` is exactly the
  // residue a NEWER build wrote. It cannot shadow a reserved key: those are
  // named here, and `serializeTableView` re-applies them over `extras` anyway.
  const {
    sortKey,
    sortDir,
    hiddenColumns,
    columnOrder,
    columnWidths,
    dateRange,
    grouping,
    collapsedGroups,
    pageSize,
    viewStateVersions,
    hiddenSummaryCards,
    ...carried
  } = saved;
  const storedVersions = resolveViewStateVersions(
    legacyViewStateVersions(BRANCH_VIEW_STATE_MIRRORS, {}),
    viewStateVersions
  );
  // No axis is mirrored and no migration ran, so this is the stamps the record
  // arrived with, handed straight back. The call is still the seam: the day an
  // axis names a mirror, `{}` stops typechecking here.
  const advanced = advanceViewStateVersions(
    BRANCH_VIEW_STATE_MIRRORS,
    storedVersions,
    {}
  );
  return {
    sortKey,
    sortDir,
    hiddenColumns: normalizeBranchColumnIds(hiddenColumns),
    columnOrder: normalizeBranchColumnIds(columnOrder),
    // The widths map is keyed by column id too, so it resolves on the same read
    // boundary as the two lists above — a rename left off this axis moves the
    // sort, the hidden set and the order and strands the width under the old id.
    columnWidths: normalizeBranchColumnWidths(columnWidths),
    pageSize,
    extras: {
      ...carried,
      collapsedGroups,
      dateRange,
      grouping,
      hiddenSummaryCards,
      ...advanced.mirrors,
      viewStateVersions: advanced.versions,
    },
  };
}

/**
 * Session-scoped view state for the Branches toolbar (Epic B / B5a): sort key +
 * direction, the time window, and the visible data-column set. Wraps the shared
 * `usePersistedTableViewState` (which owns the sort/columns/persistence
 * machinery). Composes with `useBranchFilterState` (which owns filters +
 * pagination).
 *
 * When `persistKey` is provided (B5b — "save view"), the dimensions are restored
 * from `localStorage` on mount and re-persisted on every change, keyed by surface.
 * Persistence is fail-soft (see `branch-saved-view`).
 */
export function useBranchViewState(persistKey?: string, approved = false) {
  const columnIds = approved ? APPROVED_BRANCH_COLUMN_IDS : BRANCH_COLUMN_IDS;
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
    applyView,
  } = usePersistedTableViewState<
    BranchSortKey,
    BranchSortDir,
    BranchColumnId,
    BranchExtras
  >({
    persistKey: approved && persistKey ? `${persistKey}:approved` : persistKey,
    keyPrefix: "branches:saved-view:",
    // ISS-9450: the account-level copy of this record. The approved projection
    // keeps its own layout, so it takes the one non-default scope the
    // `grid_preferences` selector declares rather than sharing the row. Inert
    // until the closed-by-default gate inside `useGridPreferenceRemote` opens.
    gridKey: GridPreferenceGridKey.Branches,
    scopeKey: approved
      ? GridPreferenceScopeKey.Approved
      : GridPreferenceScopeKey.Default,
    columnIds,
    // ISS-12663: a custom-field column's WIDTH rides the saved view, as on
    // Sessions (ISS-10356); which custom fields show stays surface-local.
    isWidthOnlyColumnId: isListCustomFieldWidthColumnId,
    defaultSortKey: DEFAULT_BRANCH_SORT_KEY,
    defaultSortDir: DEFAULT_BRANCH_SORT_DIR,
    sortDirs: BRANCH_SORT_DIRS,
    defaultExtras: DEFAULT_BRANCH_EXTRAS,
    parse: approved ? parseApprovedSavedView : parseLegacySavedView,
  });

  const setDateRange = useCallback(
    (dateRange: DateRange) => setExtras((prev) => ({ ...prev, dateRange })),
    [setExtras]
  );

  const setGrouping = useCallback(
    (grouping: TableGroupingState) =>
      setExtras((prev) => ({ ...prev, grouping })),
    [setExtras]
  );

  const setCollapsedGroups = useCallback(
    (collapsedGroups: TableCollapsedGroups) =>
      setExtras((prev) => ({ ...prev, collapsedGroups })),
    [setExtras]
  );

  const hiddenSummaryCards = useMemo(
    () => new Set(extras.hiddenSummaryCards),
    [extras.hiddenSummaryCards]
  );

  const toggleSummaryCard = useCallback(
    (cardId: string) =>
      setExtras((prev) => {
        const next = new Set(prev.hiddenSummaryCards);
        if (!next.delete(cardId)) {
          next.add(cardId);
        }
        return { ...prev, hiddenSummaryCards: [...next] };
      }),
    [setExtras]
  );

  // The Options menu's "Reset view", acting as Sessions' does: everything the
  // menu and toolbar persist in this view except the primary sort and window.
  // Collapsed bands go with the grouping they are keyed under.
  const resetView = useCallback(() => {
    resetColumns();
    setExtras((prev) => ({
      ...prev,
      collapsedGroups: DEFAULT_BRANCH_EXTRAS.collapsedGroups,
      grouping: DEFAULT_BRANCH_EXTRAS.grouping,
      hiddenSummaryCards: DEFAULT_BRANCH_EXTRAS.hiddenSummaryCards,
    }));
  }, [resetColumns, setExtras]);

  // FEA-4180: the hidden-column id list (the complement of `visibleColumns`),
  // used to CAPTURE the current arrangement into a named saved view.
  const hiddenColumns = columnIds.filter((id) => !visibleColumns.has(id));

  // FEA-4180: switch the whole live view to a named saved view's arrangement in
  // one coherent transition (sort + window + visibility + order + widths +
  // rows-per-page together). The caller applies the saved filters separately
  // (they live in the filter-state hook, not here).
  const applyArrangement = useCallback(
    (arrangement: BranchAppliedArrangement) =>
      applyView({
        sortKey: arrangement.sortKey,
        sortDir: arrangement.sortDir,
        hiddenColumns: arrangement.hiddenColumns,
        columnOrder: arrangement.columnOrder,
        columnWidths: arrangement.columnWidths,
        // RAW, never resolved. A view saved before ISS-9447 M5 captured no
        // rows-per-page, and `applyView` reads an omitted `pageSize` as "this
        // view has no opinion" and leaves the live one — the reader's footer
        // choice, or the `?pageSize=` the link they opened stated. Resolving it
        // to the surface default here made that guard unreachable and turned
        // every old view into a silent reset to 25, which is the same rule the
        // `extras` updater below states four lines down and the opposite of
        // what this line used to do. The DEFAULT arrangement carries an
        // explicit size, because "the defaults" genuinely is an opinion about
        // rows-per-page.
        pageSize: arrangement.pageSize,
        // An updater, so the version envelope and any key a newer build wrote
        // survive the switch. An arrangement captured elsewhere says nothing
        // about either, and "the view did not mention it" is not "the reader
        // wants it gone" — the same rule the carried column ids follow.
        extras: (previous) => ({
          ...previous,
          collapsedGroups: arrangement.collapsedGroups,
          dateRange: arrangement.dateRange,
          grouping: arrangement.grouping,
        }),
      }),
    [applyView]
  );

  return {
    sortKey,
    sortDir,
    dateRange: extras.dateRange,
    grouping: extras.grouping,
    setGrouping,
    collapsedGroups: extras.collapsedGroups,
    setCollapsedGroups,
    hiddenSummaryCards,
    toggleSummaryCard,
    // ISS-4655: `dateRange` above lands in the branches query key, and until the
    // persisted view has restored it is still the DEFAULT. Surfaces gate their
    // read on this so they paginate the corpus once, against the window the user
    // actually keeps.
    isViewReady,
    visibleColumns,
    hiddenColumns,
    columnOrder,
    setColumnOrder,
    columnWidths,
    setColumnWidth,
    // ISS-9692: the rows-per-page the reader last chose, restored from the same
    // saved view the sort and columns come from. RAW — the ladder in force is
    // resolved at the render site (`useTablePageSizeOptions`).
    pageSize,
    setPageSize,
    setSort,
    toggleSortDir,
    setDateRange,
    toggleColumn,
    resetColumns,
    resetView,
    applyArrangement,
  };
}
