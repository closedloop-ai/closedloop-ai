"use client";

import { useCallback, useMemo } from "react";

import { useLocalStorageState } from "@/hooks/use-local-storage-state";

/**
 * Hook managing which groups are expanded/collapsed in a grouped table view.
 * Persists collapsed groups to localStorage so state survives re-renders,
 * data refetches, and page navigation.
 *
 * Groups default to expanded — only explicitly collapsed groups are stored.
 */
export function useGroupExpansion(storageKey: string) {
  const [collapsedKeys, setCollapsedKeys] = useLocalStorageState<string[]>(
    storageKey,
    []
  );

  const collapsedSet = useMemo(() => new Set(collapsedKeys), [collapsedKeys]);

  const isExpanded = useCallback(
    (groupKey: string) => !collapsedSet.has(groupKey),
    [collapsedSet]
  );

  const toggleGroup = useCallback(
    (groupKey: string) => {
      setCollapsedKeys((prev) => {
        const set = new Set(prev);
        if (set.has(groupKey)) {
          set.delete(groupKey);
        } else {
          set.add(groupKey);
        }
        return Array.from(set);
      });
    },
    [setCollapsedKeys]
  );

  return { isExpanded, toggleGroup };
}
