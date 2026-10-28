"use client";

import {
  type ProjectArtifactBoardFilters,
  ProjectArtifactBoardSort,
  ProjectArtifactBoardSortDirection,
} from "@repo/api/src/types/project-artifact-board-page";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import type { TableFilters } from "@repo/app/documents/hooks/use-table-filters";
import { tableFilterDateWindow } from "@repo/app/documents/lib/table-filter-date-window";
import type { ProjectArtifactBoardPageSort } from "@repo/app/projects/hooks/use-project-artifact-board-page";
import { useRef } from "react";

/**
 * ISS-12929 (724-F5): the project table's active filters and search as the
 * board route's filters, so the server pages the filtered population instead
 * of the browser loading every page to filter it. Undefined when nothing
 * narrows.
 */
export function projectBoardFilters(
  filters: TableFilters | undefined,
  filterText: string,
  now: Date
): ProjectArtifactBoardFilters | undefined {
  const search = filterText.trim();
  const dateWindow = filters ? tableFilterDateWindow(filters, now) : null;
  const board: ProjectArtifactBoardFilters = {
    ...(filters?.assigneeIds.length
      ? { assigneeIds: filters.assigneeIds }
      : {}),
    ...(dateWindow ? { dateWindow } : {}),
    ...(filters?.favoritesOnly ? { favoritesOnly: true } : {}),
    ...(filters?.hideCompletedItems ? { hideCompletedItems: true } : {}),
    ...(filters?.priorities.length ? { priorities: filters.priorities } : {}),
    ...(search ? { search } : {}),
    ...(filters?.statuses.length ? { statuses: filters.statuses } : {}),
    ...(filters?.tagIds.length ? { tagIds: filters.tagIds } : {}),
  };
  return Object.keys(board).length > 0 ? board : undefined;
}

/**
 * {@link projectBoardFilters} resolved once per selection. A date preset is
 * resolved against the clock when the selection changes and then held, so the
 * query key stays stable and every page of one board reads the same window.
 */
export function useProjectBoardFilters(
  filters: TableFilters | undefined,
  filterText: string
): ProjectArtifactBoardFilters | undefined {
  const key = JSON.stringify([filters ?? null, filterText.trim()]);
  const resolved = useRef<{
    key: string;
    value: ProjectArtifactBoardFilters | undefined;
  } | null>(null);
  if (resolved.current?.key !== key) {
    resolved.current = {
      key,
      value: projectBoardFilters(filters, filterText, new Date()),
    };
  }
  return resolved.current.value;
}

/**
 * ISS-12929 (724-F5): the project table's column sort as the board's order,
 * or undefined for stack rank, the board's manual order.
 */
export function projectBoardSort(
  sortBy: SortKey | null,
  sortDir: "asc" | "desc"
): ProjectArtifactBoardPageSort | undefined {
  const by = sortBy ? BOARD_SORT_BY_TABLE_SORT[sortBy] : null;
  if (!by || by === ProjectArtifactBoardSort.StackRank) {
    return undefined;
  }
  return {
    by,
    direction:
      sortDir === "desc"
        ? ProjectArtifactBoardSortDirection.Desc
        : ProjectArtifactBoardSortDirection.Asc,
  };
}

const BOARD_SORT_BY_TABLE_SORT: Record<SortKey, ProjectArtifactBoardSort> = {
  [SortKey.Assignee]: ProjectArtifactBoardSort.Assignee,
  [SortKey.Priority]: ProjectArtifactBoardSort.Priority,
  [SortKey.Slug]: ProjectArtifactBoardSort.Slug,
  [SortKey.StackRank]: ProjectArtifactBoardSort.StackRank,
  [SortKey.Status]: ProjectArtifactBoardSort.Status,
  [SortKey.Title]: ProjectArtifactBoardSort.Title,
  [SortKey.Type]: ProjectArtifactBoardSort.Type,
  [SortKey.Updated]: ProjectArtifactBoardSort.Updated,
};
