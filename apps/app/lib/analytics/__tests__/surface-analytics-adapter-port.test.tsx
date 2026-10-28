/**
 * ISS-8752 — the web half of the surface-attributed analytics port.
 *
 * `AppSurfaceAnalyticsProvider` is the only place the web shell injects the
 * port's capture sink; this proves an event emitted through
 * `useSurfaceAnalytics()` reaches PostHog carrying `surface: "web"`, so the
 * adapter cannot silently stop forwarding (the FEA-1517 defect ISS-8752 fixed
 * was exactly a port nothing carried through to a destination).
 */

import {
  Surface,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import { useSurfaceAnalytics } from "@repo/app/shared/observability/surface-analytics-context";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppSurfaceAnalyticsProvider } from "@/lib/analytics/surface-analytics-adapter";

const mockCapture = vi.hoisted(() => vi.fn());

vi.mock("@repo/analytics/client", () => ({
  useAnalytics: () => ({
    capture: mockCapture,
    identify: vi.fn(),
    reset: vi.fn(),
  }),
}));

function PortEmitter() {
  const { capture } = useSurfaceAnalytics();
  capture(SurfaceAnalyticsEvent.SharedComponentRendered, {
    component: "sessions_list_surface_v2",
  });
  return null;
}

describe("AppSurfaceAnalyticsProvider surface port", () => {
  it("forwards port events to PostHog with surface=web stamped", () => {
    render(
      <AppSurfaceAnalyticsProvider>
        <PortEmitter />
      </AppSurfaceAnalyticsProvider>
    );

    expect(mockCapture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.SharedComponentRendered,
      { component: "sessions_list_surface_v2", surface: Surface.Web }
    );
  });
});
