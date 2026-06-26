"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DateRange } from "../../shared/lib/format-utils";
import {
  loadBranchSavedView,
  saveBranchSavedView,
} from "../lib/branch-saved-view";
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
  { id: "repo", label: "Repository" },
  { id: "status", label: "Status" },
  { id: "lastActivity", label: "Last active" },
  { id: "sessions", label: "Linked Sessions" },
  { id: "changes", label: "Changes" },
  { id: "pr", label: "Pull request" },
] as const;

export type BranchColumnId = (typeof BRANCH_TOGGLEABLE_COLUMNS)[number]["id"];

const DEFAULT_HIDDEN: readonly BranchColumnId[] = [];

const VALID_COLUMN_IDS = new Set<string>(
  BRANCH_TOGGLEABLE_COLUMNS.map((column) => column.id)
);

/**
 * Session-scoped view state for the Branches toolbar (Epic B / B5a): sort key +
 * direction and the visible data-column set. Composes with `useBranchFilterState`
 * (which owns filters + pagination).
 *
 * When `persistKey` is provided (B5b — "save view"), the sort/columns dimensions
 * are restored from `localStorage` on mount and re-persisted on every change,
 * keyed by surface. Persistence is fail-soft (see `branch-saved-view`).
 */
export function useBranchViewState(persistKey?: string) {
  const [saved] = useState(() =>
    persistKey ? loadBranchSavedView(persistKey) : null
  );
  const [sortKey, setSortKey] = useState<BranchSortKey>(
    saved?.sortKey ?? SortKey.LastActivity
  );
  const [sortDir, setSortDir] = useState<BranchSortDir>(
    saved?.sortDir ?? SortDir.Desc
  );
  const [dateRange, setDateRange] = useState<DateRange>(
    saved?.dateRange ?? "7d"
  );
  const [hiddenColumns, setHiddenColumns] = useState<Set<BranchColumnId>>(
    () => {
      if (saved) {
        return new Set(
          saved.hiddenColumns.filter((id): id is BranchColumnId =>
            VALID_COLUMN_IDS.has(id)
          )
        );
      }
      return new Set(DEFAULT_HIDDEN);
    }
  );

  useEffect(() => {
    if (!persistKey) {
      return;
    }
    saveBranchSavedView(persistKey, {
      sortKey,
      sortDir,
      dateRange,
      hiddenColumns: [...hiddenColumns],
    });
  }, [persistKey, sortKey, sortDir, dateRange, hiddenColumns]);

  const visibleColumns = useMemo(
    () =>
      new Set(
        BRANCH_TOGGLEABLE_COLUMNS.map((column) => column.id).filter(
          (id) => !hiddenColumns.has(id)
        )
      ),
    [hiddenColumns]
  );

  const setSort = useCallback((key: BranchSortKey, dir?: BranchSortDir) => {
    setSortKey(key);
    if (dir) {
      setSortDir(dir);
    }
  }, []);

  const toggleSortDir = useCallback(
    () =>
      setSortDir((dir) => (dir === SortDir.Asc ? SortDir.Desc : SortDir.Asc)),
    []
  );

  const toggleColumn = useCallback((id: BranchColumnId) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  return {
    sortKey,
    sortDir,
    dateRange,
    visibleColumns,
    setSort,
    toggleSortDir,
    setDateRange,
    toggleColumn,
  };
}
