"use client";

import { useCallback } from "react";
import {
  type RestoredTableView,
  usePersistedTableViewState,
} from "../../shared/hooks/use-persisted-table-view-state";
import type { DateRange } from "../../shared/lib/format-utils";
import { parseBranchSavedView } from "../lib/branch-saved-view";
import {
  type BranchSortDir,
  type BranchSortKey,
  BranchSortDir as SortDir,
  BranchSortKey as SortKey,
} from "../lib/branch-sort-group";

/**
 * Toggleable data columns (the Name lead is always shown). Order is purely for
 * the columns menu; the table owns render order.
 */
export const BRANCH_TOGGLEABLE_COLUMNS = [
  { id: "owner", label: "Owner" },
  { id: "repo", label: "Repository" },
  { id: "status", label: "Status" },
  { id: "lastActivity", label: "Last active" },
  { id: "sessions", label: "Linked Sessions" },
  { id: "changes", label: "Changes" },
  { id: "pr", label: "Pull request" },
  { id: "checks", label: "Checks" },
] as const;

/** PRD-601 visibility-only columns in their immutable relative order. */
export const APPROVED_BRANCH_TOGGLEABLE_COLUMNS = [
  { id: "owner", label: "Owner" },
  { id: "collaborators", label: "Collaborators" },
  { id: "sessions", label: "Linked sessions" },
  { id: "changes", label: "Changes" },
  { id: "status", label: "Status" },
  { id: "pr", label: "Pull request" },
  { id: "lastActivity", label: "Last active" },
  { id: "repo", label: "Repository" },
  { id: "tags", label: "Tags" },
] as const;

export type BranchColumnId =
  | (typeof BRANCH_TOGGLEABLE_COLUMNS)[number]["id"]
  | (typeof APPROVED_BRANCH_TOGGLEABLE_COLUMNS)[number]["id"];

// Stable module-level id list so the shared hook's derived memos don't churn.
const BRANCH_COLUMN_IDS: readonly BranchColumnId[] =
  BRANCH_TOGGLEABLE_COLUMNS.map((column) => column.id);
const APPROVED_BRANCH_COLUMN_IDS: readonly BranchColumnId[] =
  APPROVED_BRANCH_TOGGLEABLE_COLUMNS.map((column) => column.id);

// Feature-specific "extra" dimensions persisted alongside sort + columns.
type BranchExtras = { dateRange: DateRange };
const BRANCH_SORT_DIRS: readonly [BranchSortDir, BranchSortDir] = [
  SortDir.Asc,
  SortDir.Desc,
];
const LEGACY_BRANCH_EXTRAS: BranchExtras = { dateRange: "7d" };
const APPROVED_BRANCH_EXTRAS: BranchExtras = { dateRange: "30d" };

function parseLegacySavedView(
  raw: unknown
): RestoredTableView<BranchSortKey, BranchSortDir, BranchExtras> | null {
  return parseSavedView(raw, false);
}

function parseApprovedSavedView(
  raw: unknown
): RestoredTableView<BranchSortKey, BranchSortDir, BranchExtras> | null {
  return parseSavedView(raw, true);
}

function parseSavedView(
  raw: unknown,
  approved: boolean
): RestoredTableView<BranchSortKey, BranchSortDir, BranchExtras> | null {
  const saved = parseBranchSavedView(raw);
  if (!saved) {
    return null;
  }
  const {
    sortKey,
    sortDir,
    hiddenColumns,
    columnOrder,
    columnWidths,
    dateRange,
  } = saved;
  return {
    sortKey,
    sortDir,
    hiddenColumns,
    columnOrder: approved ? [] : columnOrder,
    columnWidths,
    extras: { dateRange },
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
    columnIds,
    defaultSortKey: SortKey.LastActivity,
    defaultSortDir: SortDir.Desc,
    sortDirs: BRANCH_SORT_DIRS,
    defaultExtras: approved ? APPROVED_BRANCH_EXTRAS : LEGACY_BRANCH_EXTRAS,
    parse: approved ? parseApprovedSavedView : parseLegacySavedView,
  });

  const setDateRange = useCallback(
    (dateRange: DateRange) => setExtras((prev) => ({ ...prev, dateRange })),
    [setExtras]
  );

  // FEA-4180: the hidden-column id list (the complement of `visibleColumns`),
  // used to CAPTURE the current arrangement into a named saved view.
  const hiddenColumns = columnIds.filter((id) => !visibleColumns.has(id));

  // FEA-4180: switch the whole live view to a named saved view's arrangement in
  // one coherent transition (sort + window + visibility + order together). The
  // caller applies the saved filters separately (they live in the filter-state
  // hook, not here).
  const applyArrangement = useCallback(
    (arrangement: {
      sortKey: BranchSortKey;
      sortDir: BranchSortDir;
      dateRange: DateRange;
      hiddenColumns: string[];
      columnOrder: string[];
    }) =>
      applyView({
        sortKey: arrangement.sortKey,
        sortDir: arrangement.sortDir,
        hiddenColumns: arrangement.hiddenColumns,
        columnOrder: approved ? [] : arrangement.columnOrder,
        extras: { dateRange: arrangement.dateRange },
      }),
    [applyView, approved]
  );

  return {
    sortKey,
    sortDir,
    dateRange: extras.dateRange,
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
    setSort,
    toggleSortDir,
    setDateRange,
    toggleColumn,
    resetColumns,
    applyArrangement,
  };
}
