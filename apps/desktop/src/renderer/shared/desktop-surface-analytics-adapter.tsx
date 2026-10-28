import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsPageName,
} from "@repo/api/src/types/onboarding-analytics";
import {
  type AnalyticsPropertyValue,
  SharedAnalyticsComponent,
  Surface,
  type SurfaceAnalyticsCapture,
  type SurfaceAnalyticsCaptureEvent,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { type ReactNode, useCallback } from "react";
import { getBlockingOnboardingModalOpen } from "../components/onboarding/blocking-onboarding-modal-store";
import {
  hashToHrefEntries,
  matchRoute,
  normalizeRouteHref,
} from "../navigation/route-table";
import { pageNameForDesktopRoute } from "./desktop-click-page";

/**
 * Desktop adapter for the surface-attributed analytics port (FEA-1517, wired
 * by ISS-8752). Supplies `surface=desktop` and forwards each event over the
 * preload bridge to the main process, which relays it through the
 * product-analytics HTTP lane (server-side identity and the property allowlist
 * apply there; the lane is always on since PRD-736 P1 retired the
 * `desktop-server-analytics-relay` gate).
 *
 * Best-effort on every failure mode: an old preload without the bridge method,
 * or a rejected IPC call, drops the event — losing an observability event must
 * never break a render.
 */
export function DesktopSurfaceAnalyticsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const capture = useCallback<SurfaceAnalyticsCapture>((event, properties) => {
    const captureSurfaceAnalytics = window.desktopApi?.captureSurfaceAnalytics;
    if (!captureSurfaceAnalytics || properties.surface !== Surface.Desktop) {
      return;
    }
    const cleaned: Record<string, AnalyticsPropertyValue> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (value !== undefined) {
        cleaned[key] = value;
      }
    }
    if (isDesktopSurfaceAnalyticsEvent(event)) {
      if (!isSharedAnalyticsComponent(properties.component)) {
        return;
      }
      captureSurfaceAnalytics({
        event,
        properties: {
          ...cleaned,
          component: properties.component,
          surface: Surface.Desktop,
        },
      }).catch(() => undefined);
      return;
    }
    // The onboarding funnel (PRD-736, ISS-10502) rides the same IPC relay;
    // its events carry flow context, never a shared-component attribution.
    if (isOnboardingAnalyticsEvent(event)) {
      captureSurfaceAnalytics({
        event,
        properties: { ...cleaned, surface: Surface.Desktop },
      }).catch(() => undefined);
    }
  }, []);
  return (
    <SurfaceAnalyticsProvider
      capture={capture}
      getClickPage={getDesktopClickPage}
      surface={Surface.Desktop}
    >
      {children}
    </SurfaceAnalyticsProvider>
  );
}

function isSharedAnalyticsComponent(
  value: AnalyticsPropertyValue | undefined
): value is SharedAnalyticsComponent {
  return typeof value === "string" && SHARED_ANALYTICS_COMPONENTS.has(value);
}

function isDesktopSurfaceAnalyticsEvent(
  event: SurfaceAnalyticsCaptureEvent
): event is
  | typeof SurfaceAnalyticsEvent.SharedComponentRendered
  | typeof SurfaceAnalyticsEvent.GridviewRolloutDecision {
  return DESKTOP_SURFACE_ANALYTICS_EVENTS.has(event);
}

function isOnboardingAnalyticsEvent(
  event: SurfaceAnalyticsCaptureEvent
): event is OnboardingAnalyticsEvent {
  return ONBOARDING_ANALYTICS_EVENTS.has(event);
}

const DESKTOP_SURFACE_ANALYTICS_EVENTS: ReadonlySet<SurfaceAnalyticsCaptureEvent> =
  new Set([
    SurfaceAnalyticsEvent.SharedComponentRendered,
    SurfaceAnalyticsEvent.GridviewRolloutDecision,
  ]);

const ONBOARDING_ANALYTICS_EVENTS: ReadonlySet<SurfaceAnalyticsCaptureEvent> =
  new Set(Object.values(OnboardingAnalyticsEvent));

const SHARED_ANALYTICS_COMPONENTS: ReadonlySet<string> = new Set(
  Object.values(SharedAnalyticsComponent)
);

function getDesktopClickPage() {
  const hash = globalThis.location.hash;
  if (getBlockingOnboardingModalOpen()) {
    return {
      entry: "onboarding",
      pageName: OnboardingAnalyticsPageName.Onboarding,
    };
  }
  const href = normalizeRouteHref(hashToHrefEntries(hash).at(-1) ?? "/");
  const path = href.split("?")[0];
  const match = matchRoute(path);
  // Resolve legacy aliases through the same route table that owns the actual view.
  const resolved =
    match?.kind === "nav" && !match.params.id ? `/${match.navId}` : path;
  return { entry: resolved, pageName: pageNameForDesktopRoute(match) };
}
