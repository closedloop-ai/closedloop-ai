"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import type { DateRange } from "../../shared/lib/format-utils";
import {
  type SessionSortDir,
  type SessionSortKey,
  SessionSortDir as SortDir,
  SessionSortKey as SortKey,
} from "../lib/session-sort-group";

/**
 * Toggleable data columns for the Sessions table (the Name lead is always shown;
 * the placeholder "Autonomy" column is excluded). Order is purely for the
 * columns menu; the table owns render order.
 */
export const SESSIONS_TOGGLEABLE_COLUMNS = [
  { id: "status", label: "Status" },
  { id: "repo", label: "Repository" },
  { id: "branch", label: "Branch" },
  { id: "harness", label: "Harness" },
  { id: "model", label: "Model" },
  { id: "duration", label: "Duration" },
  { id: "cost", label: "Cost" },
  { id: "started", label: "Started" },
  { id: "lastActivity", label: "Last active" },
] as const;

export type SessionColumnId =
  (typeof SESSIONS_TOGGLEABLE_COLUMNS)[number]["id"];

const VALID_COLUMN_IDS = new Set<string>(
  SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.id)
);

const SORT_KEYS = Object.values(SortKey) as [
  SessionSortKey,
  ...SessionSortKey[],
];
const SORT_DIRS = Object.values(SortDir) as [
  SessionSortDir,
  ...SessionSortDir[],
];

const savedViewSchema = z.object({
  // Null = no explicit sort: queries omit sortBy so the server uses its default
  // order (and the desktop local source keeps its fast paginated path).
  sortKey: z.enum(SORT_KEYS).nullable().default(null),
  sortDir: z.enum(SORT_DIRS),
  // Time window for the list + summary metrics. Defaults to the last 7 days.
  dateRange: z.enum(["7d", "30d", "90d", "all"]).default("7d"),
  hiddenColumns: z
    .preprocess(
      (value) =>
        Array.isArray(value)
          ? value.filter((item) => typeof item === "string")
          : [],
      z.array(z.string())
    )
    .default([]),
});

type SessionsSavedView = z.infer<typeof savedViewSchema>;

function storageKey(surface: string): string {
  return `sessions:saved-view:${surface}`;
}

function loadSavedView(surface: string): SessionsSavedView | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  try {
    const raw = localStorage.getItem(storageKey(surface));
    if (!raw) {
      return null;
    }
    const result = savedViewSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function saveSavedView(surface: string, view: SessionsSavedView): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(storageKey(surface), JSON.stringify(view));
  } catch {
    // Private mode / quota — persistence is best-effort.
  }
}

/**
 * Session-scoped view state for the Sessions toolbar: sort key + direction and
 * the visible data-column set. Mirrors `useBranchViewState`. Composes with the
 * page's own filter + pagination state.
 *
 * When `persistKey` is provided the sort/columns dimensions are restored from
 * `localStorage` on mount and re-persisted on every change, keyed by surface.
 * Persistence is fail-soft.
 */
export function useSessionsViewState(persistKey?: string) {
  const [saved] = useState(() =>
    persistKey ? loadSavedView(persistKey) : null
  );
  // PLN-1034: default to most-recent genuine activity, descending. A persisted
  // view still wins; a persisted null (older saved view) also resolves here.
  const [sortKey, setSortKey] = useState<SessionSortKey | null>(
    saved?.sortKey ?? SortKey.LastActivity
  );
  const [sortDir, setSortDir] = useState<SessionSortDir>(
    saved?.sortDir ?? SortDir.Desc
  );
  const [dateRange, setDateRange] = useState<DateRange>(
    saved?.dateRange ?? "7d"
  );
  const [hiddenColumns, setHiddenColumns] = useState<Set<SessionColumnId>>(
    () => {
      if (saved) {
        return new Set(
          saved.hiddenColumns.filter((id): id is SessionColumnId =>
            VALID_COLUMN_IDS.has(id)
          )
        );
      }
      return new Set();
    }
  );

  useEffect(() => {
    if (!persistKey) {
      return;
    }
    saveSavedView(persistKey, {
      sortKey,
      sortDir,
      dateRange,
      hiddenColumns: [...hiddenColumns],
    });
  }, [persistKey, sortKey, sortDir, dateRange, hiddenColumns]);

  const visibleColumns = useMemo(
    () =>
      new Set(
        SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.id).filter(
          (id) => !hiddenColumns.has(id)
        )
      ),
    [hiddenColumns]
  );

  const setSort = useCallback((key: SessionSortKey, dir?: SessionSortDir) => {
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

  const toggleColumn = useCallback((id: SessionColumnId) => {
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
