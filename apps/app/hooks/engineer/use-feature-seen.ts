"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Track whether a user has interacted with a named feature.
 * Uses useSyncExternalStore to read localStorage without hydration mismatches.
 * Server snapshot returns `true` (seen) so no feature dot renders during SSR.
 */
export function useFeatureSeen(featureName: string): {
  seen: boolean;
  markSeen: () => void;
} {
  const key = `feature-seen:${featureName}`;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const handler = (e: StorageEvent) => {
        if (e.key === key) {
          onStoreChange();
        }
      };
      globalThis.addEventListener("storage", handler);
      return () => globalThis.removeEventListener("storage", handler);
    },
    [key]
  );

  const getSnapshot = useCallback(
    () => localStorage.getItem(key) === "true",
    [key]
  );

  const getServerSnapshot = useCallback(() => true, []);

  const seen = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const markSeen = useCallback(() => {
    localStorage.setItem(key, "true");
    // Trigger re-render by dispatching a storage event for same-window listeners
    globalThis.dispatchEvent(new StorageEvent("storage", { key }));
  }, [key]);

  return { seen, markSeen };
}
