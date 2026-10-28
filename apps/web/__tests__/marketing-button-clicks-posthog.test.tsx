// @vitest-environment jsdom

import { AppEnvironment } from "@repo/analytics/environment";
import { installBrowserAnalyticsContext } from "@repo/analytics/posthog-context";
import {
  IN_PROCESS_POSTHOG_OPTIONS,
  shippedPostHogVersion,
} from "@repo/analytics/posthog-test-harness";
import {
  OnboardingAnalyticsEvent as Event,
  OnboardingAnalyticsPageName as Page,
  OnboardingAnalyticsProperty as Property,
} from "@repo/api/src/types/onboarding-analytics";
import { Surface } from "@repo/api/src/types/surface-analytics";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import posthog from "posthog-js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MarketingSurfaceAnalyticsProvider } from "@/components/marketing-surface-analytics-adapter";

// The posthog-js version the root provider initializes, so its own opt-out,
// replay, and capture-time context behavior is what gets exercised.
vi.mock("@repo/analytics/client", () => ({
  useAnalytics: () => posthog,
}));

const LABEL = "Start Building";
const sent: { event: string; properties: Record<string, unknown> }[] = [];

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })))
  );
  globalThis.history.replaceState({}, "", "/pricing");
  posthog.init("phc_iss12557_marketing_clicks", {
    ...IN_PROCESS_POSTHOG_OPTIONS,
    disable_session_recording: true,
  });
  installBrowserAnalyticsContext(posthog, {
    surface: Surface.Marketing,
    environment: AppEnvironment.Production,
  });
  posthog._addCaptureHook((event, payload) => {
    if (payload) {
      sent.push({ event, properties: payload.properties });
    }
  });
});

afterEach(() => {
  cleanup();
  posthog.opt_in_capturing();
  sent.length = 0;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("marketing clicks through the real PostHog client", () => {
  it("drives the posthog-js copy production ships", () => {
    expect(posthog.version).toBe(shippedPostHogVersion());
  });

  it("sends button_clicked with marketing surface and environment while replay is off", () => {
    mount();

    fireEvent.click(screen.getByRole("button"));

    const clicks = sent.filter((entry) => entry.event === Event.ButtonClicked);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.properties).toMatchObject({
      [Property.PageName]: Page.Pricing,
      [Property.ButtonName]: LABEL,
      surface: Surface.Marketing,
      environment: AppEnvironment.Production,
      distinct_id: posthog.get_distinct_id(),
      $session_id: posthog.get_session_id(),
    });
    expect(posthog.sessionRecordingStarted()).toBe(false);
  });

  it("sends nothing after the visitor opts out", () => {
    posthog.opt_out_capturing();
    mount();

    fireEvent.click(screen.getByRole("button"));

    expect(sent.filter((entry) => entry.event === Event.ButtonClicked)).toEqual(
      []
    );
  });
});

function mount() {
  return render(
    <MarketingSurfaceAnalyticsProvider>
      <button
        data-analytics-visible-source={JSON.stringify([LABEL])}
        type="button"
      >
        {LABEL}
      </button>
    </MarketingSurfaceAnalyticsProvider>
  );
}
