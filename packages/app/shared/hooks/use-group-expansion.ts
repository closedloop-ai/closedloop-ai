"use client";

import { useCallback, useMemo } from "react";

import { useLocalStorageState } from "./use-local-storage-state";

/**
 * Hook managing which groups are expanded/collapsed in a grouped table view.
 * Persists toggled groups to localStorage so state survives re-renders,
 * data refetches, and page navigation.
 *
 * @param storageKey - localStorage key for persisting state.
 * @param options.defaultExpanded - When true, groups default to expanded and
 *   the stored keys represent *collapsed* groups. Default: false (collapsed).
 */
export function useGroupExpansion(
  storageKey: string,
  options?: { defaultExpanded?: boolean }
) {
  const defaultExpanded = options?.defaultExpanded ?? false;
  const [toggledKeys, setToggledKeys] = useLocalStorageState<string[]>(
    storageKey,
    []
  );

  const toggledSet = useMemo(() => new Set(toggledKeys), [toggledKeys]);

  const isExpanded = useCallback(
    (groupKey: string) =>
      defaultExpanded ? !toggledSet.has(groupKey) : toggledSet.has(groupKey),
    [toggledSet, defaultExpanded]
  );

  const toggleGroup = useCallback(
    (groupKey: string) => {
      setToggledKeys((prev) => {
        const set = new Set(prev);
        if (set.has(groupKey)) {
          set.delete(groupKey);
        } else {
          set.add(groupKey);
        }
        return Array.from(set);
      });
    },
    [setToggledKeys]
  );

  return { isExpanded, toggleGroup };
}
