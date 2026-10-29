"use client";

import { useAnalytics } from "@repo/analytics/client";
import {
  Surface,
  type SurfaceAnalyticsCapture,
  type SurfaceAnalyticsPersonPropertySetter,
} from "@repo/api/src/types/surface-analytics";
import { pageNameForWebPath } from "@repo/app/shared/observability/click-page-context";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { type ReactNode, useCallback, useEffect } from "react";
import { setClientEventSink } from "@/lib/analytics/client-event-sink";
import { usePathValue } from "@/lib/navigation/next-adapter";

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
  const pathname = usePathValue();
  const getClickPage = useCallback(
    () => ({
      pageName: pageNameForWebPath(pathname ?? globalThis.location.pathname),
      entry: pathname ?? globalThis.location.pathname,
    }),
    [pathname]
  );
  const capture = useCallback<SurfaceAnalyticsCapture>(
    (event, properties) => {
      analytics.capture(event, properties);
    },
    [analytics]
  );
  const setPersonProperties = useCallback<SurfaceAnalyticsPersonPropertySetter>(
    (properties) => {
      analytics.setPersonProperties(properties);
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
    <SurfaceAnalyticsProvider
      capture={capture}
      getClickPage={getClickPage}
      setPersonProperties={setPersonProperties}
      surface={Surface.Web}
    >
      {children}
    </SurfaceAnalyticsProvider>
  );
}
