import {
  OnboardingAnalyticsEvent as Event,
  OnboardingAnalyticsPageName as Page,
  OnboardingAnalyticsProperty as Property,
  SessionVolumeBucket,
} from "@repo/api/src/types/onboarding-analytics";
import { Surface } from "@repo/api/src/types/surface-analytics";
import { usePageViewedEvent } from "@repo/app/shared/observability/use-page-viewed-event";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSurfaceAnalyticsProvider } from "./surface-analytics-adapter";

const state = vi.hoisted(() => ({
  pathname: "/acme",
  analytics: { capture: vi.fn(), setPersonProperties: vi.fn() },
}));
vi.mock("@repo/analytics/client", () => ({
  useAnalytics: () => state.analytics,
}));
vi.mock("@/lib/navigation/next-adapter", () => ({
  usePathValue: () => state.pathname,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Dashboard() {
  usePageViewedEvent(Page.Dashboard, {
    properties: {
      [Property.OwnAnalyzedSessionsVolume]: SessionVolumeBucket.OneToNine,
    },
  });
  return (
    <button
      data-analytics-visible-source={JSON.stringify(["Save"])}
      type="button"
    >
      Save
    </button>
  );
}

describe("web button click adapter", () => {
  it("forwards page context to PostHog and clears it across route visits", () => {
    state.pathname = "/acme";
    const view = render(
      <AppSurfaceAnalyticsProvider>
        <Dashboard />
      </AppSurfaceAnalyticsProvider>
    );
    fireEvent.click(view.getByRole("button"));
    expect(state.analytics.capture).toHaveBeenLastCalledWith(
      Event.ButtonClicked,
      {
        [Property.PageName]: Page.Dashboard,
        [Property.ButtonName]: "Save",
        [Property.Surface]: Surface.Web,
        [Property.OwnAnalyzedSessionsVolume]: SessionVolumeBucket.OneToNine,
      }
    );
    state.pathname = "/acme/settings";
    view.rerender(
      <AppSurfaceAnalyticsProvider>
        <button
          data-analytics-visible-source={JSON.stringify(["Cancel"])}
          type="button"
        >
          Cancel
        </button>
      </AppSurfaceAnalyticsProvider>
    );
    fireEvent.click(view.getByRole("button"));
    expect(state.analytics.capture).toHaveBeenLastCalledWith(
      Event.ButtonClicked,
      {
        [Property.PageName]: Page.Settings,
        [Property.ButtonName]: "Cancel",
        [Property.Surface]: Surface.Web,
      }
    );
    state.pathname = "/acme";
    view.rerender(
      <AppSurfaceAnalyticsProvider>
        <button
          data-analytics-visible-source={JSON.stringify(["Save"])}
          type="button"
        >
          Save
        </button>
      </AppSurfaceAnalyticsProvider>
    );
    fireEvent.click(view.getByRole("button"));
    expect(state.analytics.capture).toHaveBeenLastCalledWith(
      Event.ButtonClicked,
      {
        [Property.PageName]: Page.Dashboard,
        [Property.ButtonName]: "Save",
        [Property.Surface]: Surface.Web,
      }
    );
  });
});
