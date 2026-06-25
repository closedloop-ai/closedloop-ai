"use client";

import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { useLocalStorageState } from "@repo/app/shared/hooks/use-local-storage-state";
import { useCallback } from "react";

const VALID_MODES = new Set<GroupByMode>([
  GroupByMode.None,
  GroupByMode.Status,
  GroupByMode.Assignee,
  GroupByMode.Priority,
]);

/**
 * Resolve any persisted value (including legacy boolean "group by status")
 * into a valid GroupByMode.
 */
function resolveGroupBy(raw: unknown): GroupByMode {
  if (typeof raw === "string" && VALID_MODES.has(raw as GroupByMode)) {
    return raw as GroupByMode;
  }
  if (raw === true) {
    return GroupByMode.Status;
  }
  return GroupByMode.None;
}

/**
 * Hook managing which field the table groups items by. Persists to localStorage.
 * Migrates legacy boolean "group by status" values to the new enum.
 */
export function useGroupBy(storageKey: string) {
  const [rawValue, setRawValue] = useLocalStorageState<unknown>(
    storageKey,
    GroupByMode.None
  );

  const groupBy = resolveGroupBy(rawValue);

  const setGroupBy = useCallback(
    (mode: GroupByMode) => {
      setRawValue(mode);
    },
    [setRawValue]
  );

  return { groupBy, setGroupBy };
}
