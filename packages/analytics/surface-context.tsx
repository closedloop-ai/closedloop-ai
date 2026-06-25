"use client";

import { createContext, type ReactNode, useMemo } from "react";
import type { Surface, SurfaceAnalyticsCapture } from "./surface";

type SurfaceAnalyticsContextValue = {
  surface: Surface;
  capture: SurfaceAnalyticsCapture;
};

const SurfaceAnalyticsContext =
  createContext<SurfaceAnalyticsContextValue | null>(null);

/**
 * Mounts the surface-attributed analytics port (FEA-1517). Each shell injects
 * its own `surface` value and a `capture` sink at the app root — the web shell
 * forwards `capture` to PostHog via `useAnalytics()`; other surfaces inject
 * their own. Shared components then emit through `useSurfaceAnalytics()`
 * without knowing which surface they render on.
 */
export function SurfaceAnalyticsProvider({
  surface,
  capture,
  children,
}: {
  surface: Surface;
  capture: SurfaceAnalyticsCapture;
  children: ReactNode;
}) {
  // Stable context value so the consumer hook's useMemo([context]) actually
  // holds between renders (surface is a constant and each shell memoizes its
  // capture sink). Mirrors @repo/navigation's stable-adapter contract.
  const value = useMemo(() => ({ surface, capture }), [surface, capture]);
  return (
    <SurfaceAnalyticsContext.Provider value={value}>
      {children}
    </SurfaceAnalyticsContext.Provider>
  );
}
