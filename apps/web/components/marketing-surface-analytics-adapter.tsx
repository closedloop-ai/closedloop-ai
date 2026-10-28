"use client";

import { useAnalytics } from "@repo/analytics/client";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import type { ClickPageContext } from "@repo/app/shared/observability/button-click-tracker";
import { pageNameForMarketingPath } from "@repo/app/shared/observability/click-page-context";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import languine from "@repo/internationalization/languine.json" with {
  type: "json",
};
import { type ReactNode, useCallback } from "react";

/**
 * Marketing adapter for the shared `button_clicked` tracker (ISS-12557,
 * PRD-790 requirement 5). Forwards through the root PostHog client, whose
 * capture-time context (ISS-12555) stamps `surface` and `environment` and
 * honors opt-out. Mounted inside `<AnalyticsProvider>`.
 */
export function MarketingSurfaceAnalyticsProvider({
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
    <SurfaceAnalyticsProvider
      capture={capture}
      getClickPage={marketingClickPage}
      surface={Surface.Marketing}
    >
      {children}
    </SurfaceAnalyticsProvider>
  );
}

const LOCALES: readonly string[] = [
  languine.locale.source,
  ...languine.locale.targets,
];

// Read at activation, so a client-side navigation can never leave a stale page
// behind, and one listener set survives every route change.
function marketingClickPage(): ClickPageContext {
  const path = globalThis.location.pathname;
  return { pageName: pageNameForMarketingPath(path, LOCALES), entry: path };
}
