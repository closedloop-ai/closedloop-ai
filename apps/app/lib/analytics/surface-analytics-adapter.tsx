"use client";

import { useAnalytics } from "@repo/analytics/client";
import { Surface, type SurfaceAnalyticsCapture } from "@repo/analytics/surface";
import { SurfaceAnalyticsProvider } from "@repo/analytics/surface-context";
import { type ReactNode, useCallback } from "react";

/**
 * Web adapter for the surface-attributed analytics port (FEA-1517). Supplies
 * `surface=web` and forwards the injected `capture` to PostHog via the
 * `@repo/analytics` client, so shared components emit surface-attributed events
 * on the web surface. Mounted inside `<AnalyticsProvider>` (which provides the
 * PostHog context `useAnalytics()` reads from).
 */
export function AppSurfaceAnalyticsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const analytics = useAnalytics();
  const capture = useCallback<SurfaceAnalyticsCapture>(
    (event, properties) => {
      analytics.capture(event, properties);
    },
    [analytics]
  );

  return (
    <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
      {children}
    </SurfaceAnalyticsProvider>
  );
}
