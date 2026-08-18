/**
 * ISS-5868 review follow-up — the client event sink's ONLY production caller.
 *
 * `AppSurfaceAnalyticsProvider` is the one place in the app that ever calls
 * `setClientEventSink`, and nothing rendered it. Deleting that registration left
 * the whole suite green while `captureClientEvent` became a permanent no-op in
 * production ("drop the event when none is installed") — and because client code
 * is barred from `console.*`, analytics is the ONLY reporting channel on this
 * path, so the LocalElectron health check would go back to dropping
 * `enableOutcome` / `updateOutcome` / `repair.action` in exactly the silence
 * ISS-5868 exists to break.
 *
 * The field-loss suite installs its own sink in `beforeEach`, so it proves the
 * detector, never the wiring. This drives the real provider instead.
 */

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureClientEvent,
  setClientEventSink,
} from "@/lib/analytics/client-event-sink";
import { AppSurfaceAnalyticsProvider } from "@/lib/analytics/surface-analytics-adapter";

const mockCapture = vi.hoisted(() => vi.fn());

vi.mock("@repo/analytics/client", () => ({
  useAnalytics: () => ({
    capture: mockCapture,
    identify: vi.fn(),
    reset: vi.fn(),
  }),
}));

const EVENT = "health_check_fields_dropped_client";
const PROPERTIES = {
  droppedFieldCount: 1,
  droppedFieldSample: ["plugin-code.enableOutcome"],
};

describe("AppSurfaceAnalyticsProvider installs the client event sink", () => {
  beforeEach(() => {
    mockCapture.mockClear();
    // The sink is module state. Clearing it here is what makes the assertions
    // below prove the PROVIDER installed it, rather than a leftover from an
    // earlier render or suite.
    setClientEventSink(undefined);
  });

  it("routes a non-React module's event to PostHog once mounted", () => {
    render(
      <AppSurfaceAnalyticsProvider>
        <span>child</span>
      </AppSurfaceAnalyticsProvider>
    );

    captureClientEvent(EVENT, PROPERTIES);

    expect(mockCapture).toHaveBeenCalledWith(EVENT, PROPERTIES);
  });

  it("uninstalls the sink on unmount, so a stale capture cannot fire", () => {
    const { unmount } = render(
      <AppSurfaceAnalyticsProvider>
        <span>child</span>
      </AppSurfaceAnalyticsProvider>
    );
    // Prove the sink was live first — otherwise the post-unmount assertion below
    // would pass just as well against a provider that never installed anything.
    captureClientEvent(EVENT, PROPERTIES);
    expect(mockCapture).toHaveBeenCalledTimes(1);

    unmount();
    captureClientEvent(EVENT, PROPERTIES);

    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});
