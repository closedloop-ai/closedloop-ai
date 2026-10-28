"use client";

import { OnboardingAnalyticsEvent } from "@repo/api/src/types/onboarding-analytics";
import {
  type SharedAnalyticsComponent,
  type Surface,
  type SurfaceAnalyticsCapture,
  SurfaceAnalyticsEvent,
  type SurfaceAnalyticsPersonPropertySetter,
  type SurfaceAnalyticsProperties,
} from "@repo/api/src/types/surface-analytics";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import {
  type ButtonClickTracker,
  type ClickPageContext,
  installButtonClickTracker,
} from "./button-click-tracker";

type SurfaceAnalyticsContextValue = {
  surface: Surface | null;
  capture: SurfaceAnalyticsCapture;
  /** No-op when the shell injects none — see the provider contract. */
  setPersonProperties: SurfaceAnalyticsPersonPropertySetter;
};

const SurfaceAnalyticsContext =
  createContext<SurfaceAnalyticsContextValue | null>(null);

/**
 * Mounts the surface-attributed analytics port (FEA-1517). Each shell injects
 * its own `surface` value and a `capture` sink at the app root — the web shell
 * forwards `capture` to PostHog; the desktop renderer forwards over IPC to the
 * main process's product-analytics transport. Shared components then emit
 * through {@link useSurfaceAnalytics} without knowing which surface they
 * render on.
 *
 * The provider stamps `surface` into every event's properties, after the
 * caller's own properties, so surface attribution cannot be dropped or
 * overridden at an emit site.
 */
export function SurfaceAnalyticsProvider({
  surface,
  capture,
  setPersonProperties,
  children,
  getClickPage,
}: {
  surface: Surface;
  capture: SurfaceAnalyticsCapture;
  /**
   * Person-property sink (PRD-736: `first_org_user` at org-step resolution).
   * Optional so a shell whose transport has no person store (the desktop
   * renderer relays events only) injects nothing and the port stays a no-op.
   */
  setPersonProperties?: SurfaceAnalyticsPersonPropertySetter;
  children: ReactNode;
  getClickPage?: () => ClickPageContext;
}) {
  const tracker = useRef<ButtonClickTracker | null>(null);
  const pageResolver = useRef(getClickPage);
  pageResolver.current = getClickPage;
  const pageView = useRef<{
    entry: string;
    properties: SurfaceAnalyticsProperties;
  } | null>(null);
  // Stable context value so the consumer hook holds between renders (surface
  // is a constant and each shell memoizes its capture sink). Mirrors
  // @repo/navigation's stable-adapter contract.
  const value = useMemo<SurfaceAnalyticsContextValue>(
    () => ({
      surface,
      capture: (event, properties) => {
        if (event === OnboardingAnalyticsEvent.PageViewed) {
          const page = pageResolver.current?.();
          if (page) {
            pageView.current = {
              entry: page.entry,
              properties: { ...properties },
            };
          }
          tracker.current?.recordPageView(properties);
        }
        capture(event, { ...properties, surface });
      },
      setPersonProperties: setPersonProperties ?? NOOP_PERSON_PROPERTIES,
    }),
    [surface, capture, setPersonProperties]
  );
  useLayoutEffect(() => {
    if (!getClickPage) {
      return;
    }
    const installed = installButtonClickTracker({
      document: globalThis.document,
      capture: value.capture,
      surface,
      getPage: getClickPage,
    });
    tracker.current = installed;
    if (pageView.current?.entry === getClickPage().entry) {
      installed.recordPageView(pageView.current.properties);
    } else {
      pageView.current = null;
    }
    return () => {
      installed.dispose();
      tracker.current = null;
    };
  }, [getClickPage, surface, value]);
  return (
    <SurfaceAnalyticsContext.Provider value={value}>
      {children}
    </SurfaceAnalyticsContext.Provider>
  );
}

/**
 * The surface-analytics port. Without a mounted provider (tests, Storybook,
 * prototypes) `capture` is a no-op — losing an observability event must never
 * break a render — and `surface` is null rather than falsely claiming web.
 */
export function useSurfaceAnalytics(): SurfaceAnalyticsContextValue {
  return useContext(SurfaceAnalyticsContext) ?? NO_PROVIDER_VALUE;
}

/**
 * Emits `shared_component_rendered` for one MLP-tracked shared component,
 * exactly once per mount — never per render. The ref survives StrictMode's
 * dev-only effect replay, so dev double-invocation stays a single emit too.
 */
export function useSharedComponentRenderedEvent(
  component: SharedAnalyticsComponent
): void {
  const { capture } = useSurfaceAnalytics();
  const emittedRef = useRef(false);
  useEffect(() => {
    if (emittedRef.current) {
      return;
    }
    emittedRef.current = true;
    capture(SurfaceAnalyticsEvent.SharedComponentRendered, { component });
  }, [capture, component]);
}

const NOOP_PERSON_PROPERTIES: SurfaceAnalyticsPersonPropertySetter = () =>
  undefined;

const NO_PROVIDER_VALUE: SurfaceAnalyticsContextValue = {
  surface: null,
  capture: () => undefined,
  setPersonProperties: NOOP_PERSON_PROPERTIES,
};
