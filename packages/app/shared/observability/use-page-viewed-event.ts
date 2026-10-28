"use client";

import {
  OnboardingAnalyticsEvent,
  type OnboardingAnalyticsPageName,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import type { SurfaceAnalyticsProperties } from "@repo/api/src/types/surface-analytics";
import { useEffect, useRef } from "react";
import { useSurfaceAnalytics } from "./surface-analytics-context";

/**
 * Emits the PRD-736 `page_viewed` event exactly once per mount / navigation
 * entry (ISS-10501) — never per re-render, and StrictMode's dev effect replay
 * stays a single emit, following `useSharedComponentRenderedEvent`. `pageName`
 * is the closed enum, so a page outside the vocabulary cannot emit. Web keeps
 * PostHog's automatic `$pageview`; this is the cross-surface event, additive.
 *
 * `ready` defers the single emit until page-scoped properties have settled
 * (the dashboard's session-volume buckets); it can only delay the emit, never
 * repeat it. `properties` is read at emit time, so its identity never re-arms
 * anything.
 */
export function usePageViewedEvent(
  pageName: OnboardingAnalyticsPageName,
  options?: {
    ready?: boolean;
    properties?: SurfaceAnalyticsProperties;
  }
): void {
  const { capture } = useSurfaceAnalytics();
  const emittedRef = useRef(false);
  const propertiesRef = useRef(options?.properties);
  propertiesRef.current = options?.properties;
  const ready = options?.ready ?? true;

  useEffect(() => {
    if (emittedRef.current || !ready) {
      return;
    }
    emittedRef.current = true;
    capture(OnboardingAnalyticsEvent.PageViewed, {
      ...propertiesRef.current,
      [OnboardingAnalyticsProperty.PageName]: pageName,
    });
  }, [capture, pageName, ready]);
}
