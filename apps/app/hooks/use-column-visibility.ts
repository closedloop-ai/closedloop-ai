"use client";

import { useLocalStorageState } from "@/hooks/use-local-storage-state";

/**
 * Standard column identifiers for artifact tables.
 * Each maps to a fixed-width property cell in the table.
 */
export const DocumentColumn = {
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
export type DocumentColumn =
  (typeof DocumentColumn)[keyof typeof DocumentColumn];

export const ARTIFACT_COLUMN_LABELS: Record<DocumentColumn, string> = {
  [DocumentColumn.Type]: "Type",
  [DocumentColumn.Parent]: "Parent",
  [DocumentColumn.DueDate]: "Due Date",
  [DocumentColumn.Assignee]: "Assignee",
  [DocumentColumn.Priority]: "Priority",
  [DocumentColumn.Score]: "Quality Score",
  [DocumentColumn.Loop]: "Loop",
  [DocumentColumn.Updated]: "Updated",
  [DocumentColumn.Project]: "Project",
};

/** Columns that should not be sortable. */
export const NON_SORTABLE_COLUMNS = new Set<DocumentColumn>([
  DocumentColumn.Loop,
  DocumentColumn.Score,
]);

/** All available columns in display order (artifact/feature table). */
export const ALL_ARTIFACT_COLUMNS: DocumentColumn[] = [
  DocumentColumn.Type,
  DocumentColumn.Assignee,
  DocumentColumn.Loop,
  DocumentColumn.Parent,
  DocumentColumn.Priority,
  DocumentColumn.Score,
];

/** Default columns for the projects table. */
export const PROJECT_DEFAULT_COLUMNS: DocumentColumn[] = [
  DocumentColumn.Priority,
  DocumentColumn.Assignee,
  DocumentColumn.DueDate,
  DocumentColumn.Updated,
];

/** Default columns for the team-level PRDs list. */
export const PRD_DEFAULT_COLUMNS: DocumentColumn[] = [
  DocumentColumn.Project,
  DocumentColumn.Assignee,
  DocumentColumn.Priority,
  DocumentColumn.Score,
];

/** Default columns for the My Tasks page (features assigned to current user). */
export const MY_TASKS_DEFAULT_COLUMNS: DocumentColumn[] = [
  DocumentColumn.Project,
  DocumentColumn.Assignee,
  DocumentColumn.Loop,
  DocumentColumn.Parent,
  DocumentColumn.Priority,
];

/** Default columns for the team-level Features list. */
export const FEATURE_DEFAULT_COLUMNS: DocumentColumn[] = [
  DocumentColumn.Project,
  DocumentColumn.Assignee,
  DocumentColumn.Parent,
  DocumentColumn.Priority,
];

/** Default columns for the team-level Plans list. */
export const PLAN_DEFAULT_COLUMNS: DocumentColumn[] = [
  DocumentColumn.Project,
  DocumentColumn.Assignee,
  DocumentColumn.Parent,
  DocumentColumn.Priority,
  DocumentColumn.Score,
];

export type ColumnVisibility = Record<DocumentColumn, boolean>;

const DEFAULT_VISIBILITY: ColumnVisibility = {
  [DocumentColumn.Type]: false,
  [DocumentColumn.Parent]: true,
  [DocumentColumn.DueDate]: true,
  [DocumentColumn.Assignee]: true,
  [DocumentColumn.Priority]: true,
  [DocumentColumn.Score]: true,
  [DocumentColumn.Loop]: true,
  [DocumentColumn.Updated]: true,
  [DocumentColumn.Project]: true,
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

  const toggleColumn = (column: DocumentColumn) => {
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
