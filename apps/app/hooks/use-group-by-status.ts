"use client";

import { useLocalStorageState } from "@/hooks/use-local-storage-state";

/**
 * Hook managing whether the table groups items by status.
 * Persists the preference to localStorage.
 */
export function useGroupByStatus(storageKey: string) {
  const [groupByStatus, setGroupByStatus] = useLocalStorageState<boolean>(
    storageKey,
    false
  );

  const toggleGroupByStatus = () => {
    setGroupByStatus((prev) => !prev);
  };

  return { groupByStatus, toggleGroupByStatus };
}
