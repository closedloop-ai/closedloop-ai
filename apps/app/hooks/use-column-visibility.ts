"use client";

import { useLocalStorageState } from "@/hooks/use-local-storage-state";

/**
 * Standard column identifiers for artifact tables.
 * Each maps to a fixed-width property cell in the table.
 */
export const ArtifactColumn = {
  Type: "type",
  Parent: "parent",
  DueDate: "dueDate",
  Assignee: "assignee",
  Priority: "priority",
  Score: "score",
  Loop: "loop",
  // Project-specific columns
  Updated: "updated",
  // Team-level list columns
  Project: "project",
} as const;
export type ArtifactColumn =
  (typeof ArtifactColumn)[keyof typeof ArtifactColumn];

export const ARTIFACT_COLUMN_LABELS: Record<ArtifactColumn, string> = {
  [ArtifactColumn.Type]: "Type",
  [ArtifactColumn.Parent]: "Parent",
  [ArtifactColumn.DueDate]: "Due Date",
  [ArtifactColumn.Assignee]: "Assignee",
  [ArtifactColumn.Priority]: "Priority",
  [ArtifactColumn.Score]: "Quality Score",
  [ArtifactColumn.Loop]: "Loop",
  [ArtifactColumn.Updated]: "Updated",
  [ArtifactColumn.Project]: "Project",
};

/** Columns that should not be sortable. */
export const NON_SORTABLE_COLUMNS = new Set<ArtifactColumn>([
  ArtifactColumn.Loop,
  ArtifactColumn.Score,
]);

/** All available columns in display order (artifact/feature table). */
export const ALL_ARTIFACT_COLUMNS: ArtifactColumn[] = [
  ArtifactColumn.Type,
  ArtifactColumn.Assignee,
  ArtifactColumn.Loop,
  ArtifactColumn.Parent,
  ArtifactColumn.Priority,
  ArtifactColumn.Score,
];

/** Default columns for the projects table. */
export const PROJECT_DEFAULT_COLUMNS: ArtifactColumn[] = [
  ArtifactColumn.Priority,
  ArtifactColumn.Assignee,
  ArtifactColumn.DueDate,
  ArtifactColumn.Updated,
];

/** Default columns for the team-level PRDs list. */
export const PRD_DEFAULT_COLUMNS: ArtifactColumn[] = [
  ArtifactColumn.Project,
  ArtifactColumn.Assignee,
  ArtifactColumn.Priority,
  ArtifactColumn.Score,
];

/** Default columns for the My Tasks page (features assigned to current user). */
export const MY_TASKS_DEFAULT_COLUMNS: ArtifactColumn[] = [
  ArtifactColumn.Project,
  ArtifactColumn.Assignee,
  ArtifactColumn.Parent,
  ArtifactColumn.Priority,
];

/** Default columns for the team-level Features list. */
export const FEATURE_DEFAULT_COLUMNS: ArtifactColumn[] = [
  ArtifactColumn.Project,
  ArtifactColumn.Assignee,
  ArtifactColumn.Parent,
  ArtifactColumn.Priority,
];

/** Default columns for the team-level Plans list. */
export const PLAN_DEFAULT_COLUMNS: ArtifactColumn[] = [
  ArtifactColumn.Project,
  ArtifactColumn.Assignee,
  ArtifactColumn.Parent,
  ArtifactColumn.Priority,
  ArtifactColumn.Score,
];

export type ColumnVisibility = Record<ArtifactColumn, boolean>;

const DEFAULT_VISIBILITY: ColumnVisibility = {
  [ArtifactColumn.Type]: false,
  [ArtifactColumn.Parent]: true,
  [ArtifactColumn.DueDate]: true,
  [ArtifactColumn.Assignee]: true,
  [ArtifactColumn.Priority]: true,
  [ArtifactColumn.Score]: true,
  [ArtifactColumn.Loop]: true,
  [ArtifactColumn.Updated]: true,
  [ArtifactColumn.Project]: true,
};

/**
 * Hook managing which columns are visible in the artifact table.
 *
 * @param options.storageKey - Local storage key used to persist user visibility preferences.
 * @param options.overrides - Per-column forced visibility (e.g., hide Type when filtering to a single type).
 *   These override user toggles and are not saved.
 */
export function useColumnVisibility(options: {
  storageKey: string;
  overrides?: Partial<ColumnVisibility>;
}) {
  const { storageKey, overrides } = options;
  const [userVisibility, setUserVisibility] =
    useLocalStorageState<ColumnVisibility>(storageKey, DEFAULT_VISIBILITY);

  const toggleColumn = (column: ArtifactColumn) => {
    setUserVisibility((prev) => ({ ...prev, [column]: !prev[column] }));
  };

  // Merge user preferences with overrides
  const visibility: ColumnVisibility = { ...userVisibility, ...overrides };

  const visibleColumns = ALL_ARTIFACT_COLUMNS.filter((c) => visibility[c]);

  return {
    visibility,
    userVisibility,
    visibleColumns,
    toggleColumn,
  };
}
