import { Surface } from "@repo/api/src/types/surface-analytics";
import { cleanup, render } from "@testing-library/react";
import posthog from "posthog-js";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEnvironment } from "./environment";
import { NEXTJS_CLIENT_DEFAULTS } from "./node_modules/@posthog/next/dist/shared/config.js";
import {
  ANALYTICS_PERSISTENCE_REPAIRED_EVENT,
  PersistedPersonInfoKey,
} from "./posthog-persistence-repair";

const originalUrl = globalThis.location.href;
const originalReferrer = Object.getOwnPropertyDescriptor(document, "referrer");

const navigation = {
  pathname: "/",
  search: "utm_source=newsletter&code=secret",
};

const TOKEN = "phc_iss12555_first_capture";
const STORAGE_KEY = `ph_${TOKEN}_posthog`;
const SESSION_ID = "0198c0de-0000-7000-8000-0000000000fe";
const HEALTHY_REFERRER = "https://www.google.com/search?q=closedloop";

const BOOTSTRAPPED_FLAG = "iss-12555-render-phase-probe";

vi.mock("@next/third-parties/google", () => ({ GoogleAnalytics: () => null }));
vi.mock("@vercel/analytics/react", () => ({ Analytics: () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock("./keys", () => ({
  isValidGaMeasurementId: () => false,
  keys: () => ({
    NEXT_PUBLIC_GA_MEASUREMENT_ID: undefined,
    NEXT_PUBLIC_POSTHOG_KEY: TOKEN,
    NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED: undefined,
  }),
}));

vi.mock("@posthog/next", async () => {
  const { createElement } = await import("react");
  const shipped = await import(
    "./node_modules/@posthog/next/dist/client/ClientPostHogProvider.js"
  );
  const { usePostHog, useFeatureFlagResult } = await import("posthog-js/react");
  type ShippedOptions = Parameters<
    typeof shipped.ClientPostHogProvider
  >[0]["options"];

  return {
    usePostHog,
    useFeatureFlag: useFeatureFlagResult,
    PostHogProvider: ({
      clientOptions,
      children,
    }: {
      clientOptions?: ShippedOptions;
      children: React.ReactNode;
    }) =>
      createElement(shipped.ClientPostHogProvider, {
        apiKey: TOKEN,
        options: {
          ...NEXTJS_CLIENT_DEFAULTS,
          ...clientOptions,
          ...TRANSPORT_PLUMBING,
        },
        children,
      }),
  };
});

const capturedEvents: { event: string; properties: Record<string, unknown> }[] =
  [];

const TRANSPORT_PLUMBING = {
  loaded: () => {
    posthog._addCaptureHook((event, payload) => {
      if (payload) {
        capturedEvents.push({ event, properties: payload.properties });
      }
    });
  },
  bootstrap: { featureFlags: { [BOOTSTRAPPED_FLAG]: true } },
  persistence: "localStorage+cookie",
  request_batching: false,
  disable_compression: true,
  disable_surveys: true,
  disable_external_dependency_loading: true,
  advanced_disable_decide: true,
  autocapture: false,
  capture_pageleave: false,
  capture_performance: false,
} as const;

beforeEach(() => {
  globalThis.history.replaceState(null, "", `/?${navigation.search}`);
  Object.defineProperty(document, "referrer", {
    configurable: true,
    value: HEALTHY_REFERRER,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })))
  );
});

afterEach(() => {
  cleanup();
  if (originalReferrer) {
    Object.defineProperty(document, "referrer", originalReferrer);
  } else {
    Reflect.deleteProperty(document, "referrer");
  }
  globalThis.history.replaceState(null, "", originalUrl);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a descendant that captures during its own render", () => {
  it("attributes repair, render-time feature reads, and the first pageview", async () => {
    const now = Date.now();
    globalThis.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        distinct_id: "user-render-phase",
        $user_state: "identified",
        $sesid: [now, SESSION_ID, now],
        [PersistedPersonInfoKey.ClientSessionProps]: {
          sessionId: SESSION_ID,
          props: { r: HEALTHY_REFERRER, u: 12_345 },
        },
      })
    );
    const { AnalyticsProvider } = await import("./provider");
    const { useFeatureFlag } = await import("@posthog/next");
    const FlagReadingDescendant = () => {
      useFeatureFlag(BOOTSTRAPPED_FLAG);
      return <div>Application</div>;
    };

    const tree = () => (
      <StrictMode>
        <AnalyticsProvider
          bootstrapFeatureFlags
          context={{
            surface: Surface.Marketing,
            environment: AppEnvironment.Production,
          }}
          trackPageViews
        >
          <FlagReadingDescendant />
        </AnalyticsProvider>
      </StrictMode>
    );
    const { rerender, getByText } = render(tree());

    expect(capturedEvents.map((event) => event.event)).toContain(
      "$feature_flag_called"
    );
    expect(capturedEvents.map((event) => event.event)).toContain("$pageview");
    const pageviews = () =>
      capturedEvents.filter((event) => event.event === "$pageview");
    expect(pageviews()).toHaveLength(1);
    expect(pageviews()[0]?.properties).toMatchObject({
      $current_url: `${globalThis.location.origin}/?utm_source=newsletter&code=[redacted]`,
      $host: globalThis.location.host,
      $pathname: "/",
      $referrer: HEALTHY_REFERRER,
      utm_source: "newsletter",
    });
    expect(posthog.config.capture_pageview).toBe(false);
    expect(posthog.config.disable_session_recording).toBe(true);

    // Recreate the tree to model router updates. The same SDK/provider stays mounted.
    for (const pathname of ["/docs", "/docs/quickstart", "/docs", "/de/docs"]) {
      navigation.pathname = pathname;
      globalThis.history.replaceState(null, "", pathname);
      rerender(tree());
    }
    expect(pageviews()).toHaveLength(5);

    for (const event of capturedEvents) {
      expect(event.properties).toMatchObject({
        surface: Surface.Marketing,
        environment: AppEnvironment.Production,
      });
    }
    expect(capturedEvents.map((event) => event.event)).toContain(
      ANALYTICS_PERSISTENCE_REPAIRED_EVENT
    );
    expect(
      JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "{}")[
        PersistedPersonInfoKey.ClientSessionProps
      ]
    ).toEqual({ sessionId: SESSION_ID, props: { r: HEALTHY_REFERRER } });
    const captureSpy = vi.spyOn(posthog, "capture");
    posthog.opt_out_capturing();
    navigation.pathname = "/contact";
    globalThis.history.replaceState(null, "", "/contact");
    rerender(tree());
    expect(captureSpy).toHaveBeenCalledWith(
      "$pageview",
      expect.objectContaining({
        $current_url: expect.stringContaining(
          `${globalThis.location.origin}/contact?`
        ),
      })
    );
    expect(pageviews()).toHaveLength(5);
    expect(getByText("Application")).toBeTruthy();
  });
});
