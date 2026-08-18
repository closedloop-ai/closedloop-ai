"use client";

import { useAnalytics } from "@repo/analytics/client";
import { Surface, type SurfaceAnalyticsCapture } from "@repo/analytics/surface";
import { SurfaceAnalyticsProvider } from "@repo/analytics/surface-context";
import { type ReactNode, useCallback, useEffect } from "react";
import { setClientEventSink } from "@/lib/analytics/client-event-sink";

/**
 * Web adapter for the surface-attributed analytics port (FEA-1517). Supplies
 * `surface=web` and forwards the injected `capture` to PostHog via the
 * `@repo/analytics` client, so shared components emit surface-attributed events
 * on the web surface. Mounted inside `<AnalyticsProvider>` (which provides the
 * PostHog context `useAnalytics()` reads from).
 *
 * Also installs the same PostHog capture as the app's non-React client event
 * sink, so a plain fetch/parse module — which cannot call a hook, and is barred
 * from logging — still has one way to report. Mounted at the root layout, so one
 * registration covers every surface.
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

  useEffect(() => {
    setClientEventSink((event, properties) => {
      analytics.capture(event, properties);
    });
    return () => setClientEventSink(undefined);
  }, [analytics]);

  return (
    <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
      {children}
    </SurfaceAnalyticsProvider>
  );
}
