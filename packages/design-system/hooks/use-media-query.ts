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

/** Tracks the effective visual viewport, including browser zoom changes. */
export function useViewportWidth(): number | null {
  return useSyncExternalStore(
    subscribeToViewportWidth,
    viewportWidthSnapshot,
    serverViewportWidthSnapshot
  );
}

function subscribeToViewportWidth(onChange: () => void): () => void {
  const browserWindow = globalThis.window;
  const visualViewport = browserWindow?.visualViewport;
  browserWindow?.addEventListener("resize", onChange);
  visualViewport?.addEventListener("resize", onChange);
  return () => {
    browserWindow?.removeEventListener("resize", onChange);
    visualViewport?.removeEventListener("resize", onChange);
  };
}

function viewportWidthSnapshot(): number | null {
  const browserWindow = globalThis.window;
  return browserWindow?.visualViewport?.width ?? browserWindow?.innerWidth ?? null;
}

function serverViewportWidthSnapshot(): null {
  return null;
}
