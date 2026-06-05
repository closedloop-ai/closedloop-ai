"use client";

import { useCallback, useMemo } from "react";

import { useLocalStorageState } from "@/hooks/use-local-storage-state";

/**
 * Hook managing which groups are expanded/collapsed in a grouped table view.
 * Persists expanded groups to localStorage so state survives re-renders,
 * data refetches, and page navigation.
 *
 * Groups default to collapsed — only explicitly expanded groups are stored.
 */
export function useGroupExpansion(storageKey: string) {
  const [expandedKeys, setExpandedKeys] = useLocalStorageState<string[]>(
    storageKey,
    []
  );

  const expandedSet = useMemo(() => new Set(expandedKeys), [expandedKeys]);

  const isExpanded = useCallback(
    (groupKey: string) => expandedSet.has(groupKey),
    [expandedSet]
  );

  const toggleGroup = useCallback(
    (groupKey: string) => {
      setExpandedKeys((prev) => {
        const set = new Set(prev);
        if (set.has(groupKey)) {
          set.delete(groupKey);
        } else {
          set.add(groupKey);
        }
        return Array.from(set);
      });
    },
    [setExpandedKeys]
  );

  return { isExpanded, toggleGroup };
}
