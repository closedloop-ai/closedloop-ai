"use client";

import { useLocalStorageState } from "./use-local-storage-state";

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
  Tags: "tags",
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
  [DocumentColumn.Tags]: "Tags",
  [DocumentColumn.Updated]: "Updated",
  [DocumentColumn.Project]: "Project",
};

/** Columns that should not be sortable. */
export const NON_SORTABLE_COLUMNS = new Set<DocumentColumn>([
  DocumentColumn.Loop,
  DocumentColumn.Score,
  DocumentColumn.Tags,
]);

/** All available columns in display order (artifact/feature table). */
export const ALL_ARTIFACT_COLUMNS: DocumentColumn[] = [
  DocumentColumn.Type,
  DocumentColumn.Assignee,
  DocumentColumn.Loop,
  DocumentColumn.Parent,
  DocumentColumn.Priority,
  DocumentColumn.Score,
  DocumentColumn.Tags,
];

/** Default columns for the projects table. */
export const PROJECT_DEFAULT_COLUMNS: DocumentColumn[] = [
  DocumentColumn.Priority,
  DocumentColumn.Assignee,
  DocumentColumn.DueDate,
  DocumentColumn.Updated,
];

/** Default columns for the My Tasks page (artifacts assigned to current user). */
export const MY_TASKS_DEFAULT_COLUMNS: DocumentColumn[] = [
  DocumentColumn.Type,
  DocumentColumn.Project,
  DocumentColumn.Assignee,
  DocumentColumn.Loop,
  DocumentColumn.Parent,
  DocumentColumn.Priority,
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
  [DocumentColumn.Tags]: true,
  [DocumentColumn.Updated]: true,
  [DocumentColumn.Project]: true,
};

/**
 * Hook managing which columns are visible in the artifact table.
 *
 * @param options.storageKey - Local storage key used to persist user visibility preferences.
 * @param options.overrides - Per-column forced visibility (e.g., hide Type when filtering to a single type).
 *   These override user toggles and are not saved.
 * @param options.defaults - Per-column default visibility used as the initial value before
 *   the user has stored a preference. Differs from `overrides` in that the user can still
 *   toggle columns; once toggled, the stored preference takes effect.
 */
export function useColumnVisibility(options: {
  storageKey: string;
  overrides?: Partial<ColumnVisibility>;
  defaults?: Partial<ColumnVisibility>;
}) {
  const { storageKey, overrides, defaults } = options;
  const initialVisibility: ColumnVisibility = defaults
    ? { ...DEFAULT_VISIBILITY, ...defaults }
    : DEFAULT_VISIBILITY;
  const [userVisibility, setUserVisibility] =
    useLocalStorageState<ColumnVisibility>(storageKey, initialVisibility);

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
