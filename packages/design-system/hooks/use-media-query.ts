"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribes to a CSS media query and re-renders when its match state changes.
 * Server snapshot is `false` to avoid hydration mismatches.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (callback: () => void) => {
      if (typeof globalThis.matchMedia !== "function") {
        return () => undefined;
      }
      const media = globalThis.matchMedia(query);
      media.addEventListener("change", callback);
      return () => media.removeEventListener("change", callback);
    },
    [query]
  );

  const getSnapshot = () =>
    typeof globalThis.matchMedia === "function"
      ? globalThis.matchMedia(query).matches
      : false;
  const getServerSnapshot = () => false;

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
