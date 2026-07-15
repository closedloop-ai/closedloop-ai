"use client";

import {
  AgentComponentGroupBy,
  AgentComponentSortDir,
  AgentComponentSortKey,
  AgentMetricMode,
} from "@repo/api/src/types/agent-component";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";

/**
 * Toggleable data columns for the Agents workspace inventory table (the Name
 * lead is always shown). Order is purely for the columns menu; the table owns
 * render order.
 */
export const AGENT_COMPONENT_TOGGLEABLE_COLUMNS = [
  { id: "name", label: "Name" },
  { id: "type", label: "Type" },
  { id: "metric", label: "Metric" },
  { id: "owner", label: "Owner" },
  { id: "collaborators", label: "Collaborators" },
  { id: "source", label: "Source" },
  { id: "harness", label: "Harness" },
  { id: "invocations", label: "Invocations" },
  { id: "sessions", label: "Sessions" },
  { id: "actions", label: "Actions" },
] as const;

export type AgentComponentColumnId =
  (typeof AGENT_COMPONENT_TOGGLEABLE_COLUMNS)[number]["id"];

const VALID_COLUMN_IDS = new Set<string>(
  AGENT_COMPONENT_TOGGLEABLE_COLUMNS.map((column) => column.id)
);

// ---------------------------------------------------------------------------
// Zod schema for persisted view — same approach as use-sessions-view-state.ts.
// ---------------------------------------------------------------------------

const SORT_KEYS = Object.values(AgentComponentSortKey) as [
  AgentComponentSortKey,
  ...AgentComponentSortKey[],
];
const SORT_DIRS = Object.values(AgentComponentSortDir) as [
  AgentComponentSortDir,
  ...AgentComponentSortDir[],
];
const GROUP_BY_VALUES = Object.values(AgentComponentGroupBy) as [
  AgentComponentGroupBy,
  ...AgentComponentGroupBy[],
];
const METRIC_MODES = Object.values(AgentMetricMode) as [
  AgentMetricMode,
  ...AgentMetricMode[],
];

const savedViewSchema = z.object({
  sortKey: z.enum(SORT_KEYS).default(AgentComponentSortKey.Name),
  sortDir: z.enum(SORT_DIRS).default(AgentComponentSortDir.Asc),
  groupBy: z.enum(GROUP_BY_VALUES).default(AgentComponentGroupBy.None),
  metricMode: z.enum(METRIC_MODES).default(AgentMetricMode.KlocPerDollar),
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

type AgentComponentsSavedView = z.infer<typeof savedViewSchema>;

function storageKey(surface: string): string {
  return `agents:saved-view:${surface}`;
}

function loadSavedView(surface: string): AgentComponentsSavedView | null {
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

function saveSavedView(surface: string, view: AgentComponentsSavedView): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(storageKey(surface), JSON.stringify(view));
  } catch {
    // Private mode / quota — persistence is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * View state for the Agents workspace inventory table (T-2.3): sort key +
 * direction, grouping dimension, metric mode, and the visible data-column set.
 * Mirrors `useSessionsViewState` / `useBranchViewState`.
 *
 * When `persistKey` is provided (e.g. `"agents:web"` or `"agents:desktop"`),
 * all dimensions are restored from `localStorage` on mount and re-persisted on
 * every change, keyed by surface. Persistence is fail-soft.
 *
 * Surface key convention:
 *   - `"agents:web"`     — web /[orgSlug]/agents page
 *   - `"agents:desktop"` — desktop NavId.Agents renderer
 */
export function useAgentComponentsViewState(persistKey?: string) {
  const [saved] = useState(() =>
    persistKey ? loadSavedView(persistKey) : null
  );

  const [sortKey, setSortKey] = useState<AgentComponentSortKey>(
    saved?.sortKey ?? AgentComponentSortKey.Name
  );
  const [sortDir, setSortDir] = useState<AgentComponentSortDir>(
    saved?.sortDir ?? AgentComponentSortDir.Asc
  );
  const [groupBy, setGroupBy] = useState<AgentComponentGroupBy>(
    saved?.groupBy ?? AgentComponentGroupBy.None
  );
  const [metricMode, setMetricMode] = useState<AgentMetricMode>(
    saved?.metricMode ?? AgentMetricMode.KlocPerDollar
  );
  const [hiddenColumns, setHiddenColumns] = useState<
    Set<AgentComponentColumnId>
  >(() => {
    if (saved) {
      return new Set(
        saved.hiddenColumns.filter((id): id is AgentComponentColumnId =>
          VALID_COLUMN_IDS.has(id)
        )
      );
    }
    return new Set();
  });

  useEffect(() => {
    if (!persistKey) {
      return;
    }
    saveSavedView(persistKey, {
      sortKey,
      sortDir,
      groupBy,
      metricMode,
      hiddenColumns: [...hiddenColumns],
    });
  }, [persistKey, sortKey, sortDir, groupBy, metricMode, hiddenColumns]);

  const visibleColumns = useMemo(
    () =>
      new Set(
        AGENT_COMPONENT_TOGGLEABLE_COLUMNS.map((column) => column.id).filter(
          (id) => !hiddenColumns.has(id)
        )
      ),
    [hiddenColumns]
  );

  const setSort = useCallback(
    (key: AgentComponentSortKey, dir?: AgentComponentSortDir) => {
      setSortKey(key);
      if (dir) {
        setSortDir(dir);
      }
    },
    []
  );

  const toggleSortDir = useCallback(
    () =>
      setSortDir((dir) =>
        dir === AgentComponentSortDir.Asc
          ? AgentComponentSortDir.Desc
          : AgentComponentSortDir.Asc
      ),
    []
  );

  const toggleColumn = useCallback((id: AgentComponentColumnId) => {
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

  // Restore all columns to visible — part of "Reset view" (parity with the
  // prototype's resetView, which cleared hidden columns alongside group/sort).
  const resetColumns = useCallback(() => {
    setHiddenColumns(new Set());
  }, []);

  return {
    sortKey,
    sortDir,
    groupBy,
    metricMode,
    visibleColumns,
    setSort,
    toggleSortDir,
    toggleColumn,
    resetColumns,
    setGroupBy,
    setMetricMode,
  };
}
