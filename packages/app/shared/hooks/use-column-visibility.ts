"use client";

import {
  mergeColumnOrder,
  orderColumns,
} from "@repo/design-system/lib/column-order";
import { useCallback, useMemo } from "react";
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
  [DocumentColumn.Tags]: "Tags",
  [DocumentColumn.Updated]: "Updated",
  [DocumentColumn.Project]: "Project",
};

/** Columns that should not be sortable. */
export const NON_SORTABLE_COLUMNS = new Set<DocumentColumn>([
  DocumentColumn.Score,
  DocumentColumn.Tags,
]);

/** All available columns in display order (artifact/feature table). */
export const ALL_ARTIFACT_COLUMNS: DocumentColumn[] = [
  DocumentColumn.Type,
  DocumentColumn.Assignee,
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
  [DocumentColumn.Tags]: true,
  [DocumentColumn.Updated]: true,
  [DocumentColumn.Project]: true,
};

const EMPTY_COLUMN_ORDER: DocumentColumn[] = [];

/**
 * Hook managing which columns are visible in the artifact table, in what
 * order they render, and persistence of both preferences.
 *
 * @param options.storageKey - Local storage key used to persist user visibility preferences.
 * @param options.overrides - Per-column forced visibility (e.g., hide Type when filtering to a single type).
 *   These override user toggles and are not saved.
 * @param options.defaults - Per-column default visibility used as the initial value before
 *   the user has stored a preference. Differs from `overrides` in that the user can still
 *   toggle columns; once toggled, the stored preference takes effect.
 * @param options.orderStorageKey - Local storage key used to persist the user's column
 *   ORDER (FEA-4165). Kept separate from `storageKey` so the visibility payload's shape is
 *   unchanged and either preference can be present without the other. Omit to disable
 *   reordering (order falls back to the canonical `columns` order).
 * @param options.columns - The full canonical column set (in default order) this table
 *   toggles + reorders. Defaults to {@link ALL_ARTIFACT_COLUMNS}; pass a table-specific list
 *   (e.g. My Tasks) so ordering + visibility operate over exactly that table's columns.
 */
export function useColumnVisibility(options: {
  storageKey: string;
  overrides?: Partial<ColumnVisibility>;
  defaults?: Partial<ColumnVisibility>;
  orderStorageKey?: string;
  columns?: readonly DocumentColumn[];
}) {
  const { storageKey, overrides, defaults, orderStorageKey, columns } = options;
  const allColumns = columns ?? ALL_ARTIFACT_COLUMNS;
  const initialVisibility: ColumnVisibility = useMemo(
    () =>
      defaults ? { ...DEFAULT_VISIBILITY, ...defaults } : DEFAULT_VISIBILITY,
    [defaults]
  );
  const [userVisibility, setUserVisibility] =
    useLocalStorageState<ColumnVisibility>(storageKey, initialVisibility);
  // FEA-4165: persisted data-column order (ids). Empty ⇒ the table's canonical
  // `allColumns` order. Persisted under its own key so a stale/absent order
  // degrades gracefully and never clobbers the visibility payload. When ordering
  // is disabled the fallback key is a suffixed derivative that no other reader
  // touches — never the visibility `storageKey` — so this reader can never
  // deserialize the visibility record as an order array.
  const orderingEnabled = orderStorageKey != null;
  const [rawColumnOrder, setColumnOrder] = useLocalStorageState<
    DocumentColumn[]
  >(orderStorageKey ?? `${storageKey}:order`, EMPTY_COLUMN_ORDER);
  // useLocalStorageState only JSON.parses the raw value; a malformed record (a
  // stored object/number/string, or an array with non-string members) would
  // otherwise reach orderColumns and throw during render (`for…of` on a
  // non-iterable). Coerce to a string[] here — anything else degrades to the
  // canonical order (empty).
  const columnOrder = useMemo(
    () => sanitizeColumnOrder(rawColumnOrder),
    [rawColumnOrder]
  );

  const toggleColumn = useCallback(
    (column: DocumentColumn) => {
      setUserVisibility((prev) => ({ ...prev, [column]: !prev[column] }));
    },
    [setUserVisibility]
  );

  const allColumnIds = useMemo(
    () => allColumns.map((column) => String(column)),
    [allColumns]
  );

  // Reorder the columns (FEA-4165). The header hands back the reordered VISIBLE
  // subset; `mergeColumnOrder` folds it into the CURRENT complete order (the
  // persisted order arranged over the canonical set) so hidden columns keep the
  // slots the user last left them in — merging into the raw canonical order
  // instead would silently snap a previously-moved-then-hidden column back to
  // its canonical position. Only ids the table still has survive.
  const reorderColumns = useCallback(
    (visibleOrder: readonly string[]) => {
      if (!orderingEnabled) {
        return;
      }
      const validIds = new Set<string>(allColumnIds);
      // Current full order: canonical set arranged by the persisted order, so a
      // prior move of a now-hidden column is preserved as the merge base.
      const currentOrder = orderColumns(
        allColumnIds.map((id) => ({ id })),
        columnOrder
      ).map((entry) => entry.id);
      const merged = mergeColumnOrder(currentOrder, visibleOrder).filter((id) =>
        validIds.has(id)
      ) as DocumentColumn[];
      setColumnOrder(merged);
    },
    [orderingEnabled, allColumnIds, columnOrder, setColumnOrder]
  );

  // Restore the canonical column order (part of a table's "Reset view").
  const resetColumnOrder = useCallback(() => {
    setColumnOrder(EMPTY_COLUMN_ORDER);
  }, [setColumnOrder]);

  // Merge defaults under user preferences under overrides. A stored record
  // predates any column added after it was written (e.g. Parent for the
  // table:columns:my-tasks key), so it legitimately omits that key; layering
  // initialVisibility underneath backfills the default for missing columns so a
  // truthy `visibility[c]` filter does not silently hide a column that a
  // partial old record never mentioned.
  const visibility: ColumnVisibility = useMemo(
    () => ({ ...initialVisibility, ...userVisibility, ...overrides }),
    [initialVisibility, userVisibility, overrides]
  );

  // Order the canonical columns by the persisted order (when enabled), THEN
  // drop the hidden ones. Ordering the full set first keeps a hidden column's
  // remembered slot so re-showing it lands where the user left it.
  const visibleColumns = useMemo(() => {
    const ordered = orderingEnabled
      ? orderColumns(
          allColumns.map((column) => ({ id: String(column), column })),
          columnOrder
        ).map((entry) => entry.column)
      : allColumns;
    return ordered.filter((c) => visibility[c]);
  }, [orderingEnabled, allColumns, columnOrder, visibility]);

  return {
    visibility,
    userVisibility,
    visibleColumns,
    toggleColumn,
    columnOrder,
    reorderColumns,
    resetColumnOrder,
  };
}

/**
 * Coerce a persisted column-order value of unknown shape into a `DocumentColumn[]`.
 * `useLocalStorageState` returns `JSON.parse(raw)` unvalidated, so a corrupt or
 * legacy record could be any JSON type. A non-array, or an array carrying
 * non-string members, degrades to the empty (canonical) order rather than
 * throwing when it reaches `orderColumns`. Unknown ids are kept — `orderColumns`
 * already ignores ids the table does not have, preserving version-skew safety.
 */
function sanitizeColumnOrder(value: unknown): DocumentColumn[] {
  if (!Array.isArray(value)) {
    return EMPTY_COLUMN_ORDER;
  }
  if (value.every((id) => typeof id === "string")) {
    return value as DocumentColumn[];
  }
  return EMPTY_COLUMN_ORDER;
}
