"use client";

import {
  mergeColumnOrder,
  orderColumns,
} from "@repo/design-system/lib/column-order";
import { useCallback, useMemo } from "react";
import { booleanRecordOrFallback } from "../lib/local-storage-validators";
import { PRIORITY_COLUMN_LABEL } from "../lib/priority-constants";
import { useOptionalPersistedState } from "./use-optional-persisted-state";

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
  [DocumentColumn.Priority]: PRIORITY_COLUMN_LABEL,
  [DocumentColumn.Tags]: "Tags",
  [DocumentColumn.Updated]: "Updated",
  [DocumentColumn.Project]: "Project",
};

/** Columns that should not be sortable. */
export const NON_SORTABLE_COLUMNS = new Set<DocumentColumn>([
  DocumentColumn.Tags,
]);

/** All available columns in display order (artifact/feature table). */
export const ALL_ARTIFACT_COLUMNS: DocumentColumn[] = [
  DocumentColumn.Type,
  DocumentColumn.Assignee,
  DocumentColumn.Parent,
  DocumentColumn.Priority,
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
  [DocumentColumn.Tags]: true,
  [DocumentColumn.Updated]: true,
  [DocumentColumn.Project]: true,
};

// `string[]`, not `DocumentColumn[]`: the stored order legitimately carries ids
// this build has no column for, on both the read and the write path (ISS-9908).
const EMPTY_COLUMN_ORDER: string[] = [];

/**
 * Hook managing which columns are visible in the artifact table, in what
 * order they render, and persistence of both preferences.
 *
 * @param options.storageKey - Local storage key used to persist user visibility preferences,
 *   or `null` to hold them in memory and persist nothing (ISS-9726: the active organization
 *   has not resolved, so there is no key this preference can honestly be written under).
 * @param options.overrides - Per-column forced visibility (e.g., hide Type when filtering to a single type).
 *   These override user toggles and are not saved.
 * @param options.defaults - Per-column default visibility used as the initial value before
 *   the user has stored a preference. Differs from `overrides` in that the user can still
 *   toggle columns; once toggled, the stored preference takes effect.
 * @param options.orderStorageKey - Local storage key used to persist the user's column
 *   ORDER (FEA-4165). Kept separate from `storageKey` so the visibility payload's shape is
 *   unchanged and either preference can be present without the other. OMIT to disable
 *   reordering (order falls back to the canonical `columns` order); pass `null` to keep
 *   reordering available but memory-only, which is the ISS-9726 unresolved-org case. The
 *   two are deliberately different: a table that never offered reordering must not start
 *   offering it while an organization resolves.
 * @param options.columns - The full canonical column set (in default order) this table
 *   toggles + reorders. Defaults to {@link ALL_ARTIFACT_COLUMNS}; pass a table-specific list
 *   (e.g. My Tasks) so ordering + visibility operate over exactly that table's columns.
 */
export function useColumnVisibility(options: {
  storageKey: string | null;
  overrides?: Partial<ColumnVisibility>;
  defaults?: Partial<ColumnVisibility>;
  orderStorageKey?: string | null;
  columns?: readonly DocumentColumn[];
}) {
  const { storageKey, overrides, defaults, orderStorageKey, columns } = options;
  const allColumns = columns ?? ALL_ARTIFACT_COLUMNS;
  const initialVisibility: ColumnVisibility = useMemo(
    () =>
      defaults ? { ...DEFAULT_VISIBILITY, ...defaults } : DEFAULT_VISIBILITY,
    [defaults]
  );
  // ISS-8533: this record is returned RAW as well as merged, so a stored `null`
  // throws at `!prev[column]` below and at the `userVisibility[c] !== false` reads in
  // the projects tables. Coerced in the hook rather than downstream, so the raw value
  // and the merged one can never disagree.
  const [userVisibility, setUserVisibility] =
    useOptionalPersistedState<ColumnVisibility>(
      storageKey,
      initialVisibility,
      booleanRecordOrFallback
    );
  // FEA-4165: persisted data-column order (ids). Empty ⇒ the table's canonical
  // `allColumns` order. Persisted under its own key so a stale/absent order
  // degrades gracefully and never clobbers the visibility payload. When ordering
  // is disabled the fallback key is a suffixed derivative that no other reader
  // touches — never the visibility `storageKey` — so this reader can never
  // deserialize the visibility record as an order array.
  const orderingEnabled = orderStorageKey !== undefined;
  // ISS-9726: `null` means ordering IS offered but has nowhere to persist yet,
  // so it takes the same memory path visibility does above. `undefined` still
  // means ordering is off, and keeps the suffixed fallback key that no other
  // reader touches.
  const [rawColumnOrder, setColumnOrder] = useOptionalPersistedState<string[]>(
    resolveColumnOrderKey(storageKey, orderStorageKey),
    EMPTY_COLUMN_ORDER
  );
  // useLocalStorageState only JSON.parses the raw value; a malformed record (a
  // stored object/number/string, or an array with non-string members) would
  // otherwise reach orderColumns and throw during render (`for…of` on a
  // non-iterable). Coerce to a string[] here — anything else degrades to the
  // canonical order (empty).
  //
  // ISS-8533 added a `validate` parameter to useLocalStorageState and the visibility
  // read one call up now uses it. This ORDER read keeps coercing downstream instead:
  // both are guarded, by two different mechanisms, and neither is the unguarded one.
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
  // subset; `mergeColumnOrder` folds it into the CURRENT complete order so
  // hidden columns keep the slots the user last left them in — merging into the
  // raw canonical order instead would silently snap a previously-moved-then-
  // hidden column back to its canonical position.
  const reorderColumns = useCallback(
    (visibleOrder: readonly string[]) => {
      if (!orderingEnabled) {
        return;
      }
      const knownIds = new Set<string>(allColumnIds);
      const storedIds = new Set<string>(columnOrder);
      // The complete stored order, plus any column this build has that the
      // stored order predates. Seeded from the STORED order rather than rebuilt
      // from `allColumnIds`, so an id this build has no column for stays in the
      // base and keeps its slot through the merge (ISS-9908; ISS-9447 D1) —
      // `mergeColumnOrder` substitutes the reordered subset into the slots that
      // subset occupies and leaves every other slot alone, so an unrecognized id
      // is treated exactly as a hidden column is: not drawn, not moved, not lost.
      const currentOrder = [
        ...columnOrder,
        ...allColumnIds.filter((id) => !storedIds.has(id)),
      ];
      const merged = mergeColumnOrder(currentOrder, visibleOrder);
      // A caller-supplied id that is neither a column of this table nor already
      // in the stored record cannot enter storage through `visibleOrder`.
      setColumnOrder(
        merged.filter((id) => knownIds.has(id) || storedIds.has(id))
      );
    },
    [orderingEnabled, allColumnIds, columnOrder, setColumnOrder]
  );

  // Restore the canonical column order (part of a table's "Reset view"). This
  // discards carried ids too, deliberately and unlike `reorderColumns`: a reset
  // is the reader asking for the shipped arrangement outright, so dropping them
  // is a choice they made and can see, which is the opposite of the silent
  // erasure ISS-9908 removes. `usePersistedTableViewState.resetColumns` makes
  // the same call for the same reason.
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
 * Coerce a persisted column-order value of unknown shape into a `string[]`.
 * `useLocalStorageState` returns `JSON.parse(raw)` unvalidated, so a corrupt or
 * legacy record could be any JSON type. A non-array, or an array carrying
 * non-string members, degrades to the empty (canonical) order rather than
 * throwing when it reaches `orderColumns`.
 *
 * Unknown ids are kept, on BOTH paths, so the stored record round-trips whole
 * (ISS-9908). READ: `orderColumns` emits only the columns the table has, so an
 * id with no column never reaches the render path. WRITE: `reorderColumns`
 * seeds its merge base from this value rather than from the canonical set, so
 * that same id keeps its stored slot in the record written back. The return type
 * is `string[]` rather than `DocumentColumn[]` because of exactly this: a
 * carried id is by definition not a `DocumentColumn` of this build.
 */
function sanitizeColumnOrder(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return EMPTY_COLUMN_ORDER;
  }
  if (value.every((id) => typeof id === "string")) {
    return value;
  }
  return EMPTY_COLUMN_ORDER;
}

/**
 * The key the column-ORDER read is bound to, or `null` for memory-only.
 *
 * `null` covers both an explicitly memory-only order (ISS-9726, organization
 * unresolved) and a disabled-ordering table whose visibility key is itself
 * memory-only — neither has a key its order could be written under. Ordering
 * disabled with a real visibility key keeps the suffixed derivative, which no
 * other reader touches, so this read can never deserialize the visibility
 * record as an order array.
 */
function resolveColumnOrderKey(
  storageKey: string | null,
  orderStorageKey: string | null | undefined
): string | null {
  if (typeof orderStorageKey === "string") {
    return orderStorageKey;
  }
  if (orderStorageKey === null || storageKey === null) {
    return null;
  }
  return `${storageKey}:order`;
}
