/**
 * ISS-8660: the ordering claim, against the REAL `@posthog/next`.
 *
 * The sibling suite substitutes its own provider, so it proves the repair given
 * a client that already exists. The fix also rests on a claim no substitute can
 * test: that `ClientPostHogProvider` calls `posthog.init` DURING its own render,
 * so `usePostHog()` hands the guard a live client on its FIRST render. If that
 * is wrong the guard silently no-ops on mount — the same invisible failure
 * ISS-8660 is about. Hence the real component, from the resolved package.
 *
 * One case, deliberately: `ClientPostHogProvider` guards on the posthog-js
 * singleton's `__loaded`, so only the first render here initializes anything.
 */
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_PERSISTENCE_REPAIRED_EVENT,
  PersistedPersonInfoKey,
} from "./posthog-persistence-repair";

const TOKEN = "phc_iss8660_integration";
const STORAGE_KEY = `ph_${TOKEN}_posthog`;
const SESSION_ID = "0198c0de-0000-7000-8000-0000000000ff";
const HEALTHY_REFERRER = "https://www.google.com/search?q=closedloop";

vi.mock("@next/third-parties/google", () => ({ GoogleAnalytics: () => null }));
vi.mock("@vercel/analytics/react", () => ({ Analytics: () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/sessions",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("./keys", () => ({
  isValidGaMeasurementId: () => false,
  keys: () => ({
    NEXT_PUBLIC_GA_MEASUREMENT_ID: undefined,
    NEXT_PUBLIC_POSTHOG_KEY: TOKEN,
    NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED: undefined,
  }),
}));

/**
 * Only the SERVER half is stood in for — an async RSC reading `next/headers`,
 * which no client renderer can run. Everything this file is about is downstream
 * of it and comes from the installed package unmodified.
 */
vi.mock("@posthog/next", async () => {
  const { createElement } = await import("react");
  // Reached through the workspace symlink because `@posthog/next`'s exports map
  // does not publish this module: its browser entry deliberately omits it, and
  // the server entry that renders it is an async RSC no client renderer can run.
  const shipped = await import(
    "./node_modules/@posthog/next/dist/client/ClientPostHogProvider.js"
  );
  const { usePostHog } = await import("posthog-js/react");
  type ShippedOptions = Parameters<
    typeof shipped.ClientPostHogProvider
  >[0]["options"];

  return {
    usePostHog,
    PostHogProvider: ({
      clientOptions,
      children,
    }: {
      clientOptions?: ShippedOptions;
      children: React.ReactNode;
    }) =>
      createElement(shipped.ClientPostHogProvider, {
        apiKey: TOKEN,
        options: { ...clientOptions, ...TRANSPORT_PLUMBING },
        children,
      }),
  };
});

/**
 * Every event posthog-js finished building.
 *
 * Through `before_send`, not a capture hook: a hook needs a client that already
 * exists, and this file is about the moment one comes into being. `before_send`
 * is installed AT init and runs after property construction, so an event that
 * throws while its properties are built never reaches it.
 */
const capturedEvents: string[] = [];

/**
 * Transport only — no batching, no remote config, no external chunks, and the
 * `capture_pageview: false` / `localStorage+cookie` that `@posthog/next`'s own
 * `NEXTJS_CLIENT_DEFAULTS` sets in production. None of it touches property
 * construction, which is where this bug lives.
 */
const TRANSPORT_PLUMBING = {
  before_send: <TEvent extends { event: string } | null>(event: TEvent) => {
    if (event) {
      capturedEvents.push(event.event);
    }
    return event;
  },
  capture_pageview: false,
  persistence: "localStorage+cookie",
  request_batching: false,
  disable_compression: true,
  disable_surveys: true,
  disable_external_dependency_loading: true,
  advanced_disable_flags: true,
  advanced_disable_decide: true,
  autocapture: false,
  capture_pageleave: false,
  capture_performance: false,
} as const;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the guard against the @posthog/next that ships", () => {
  it("sweeps before the first capture the real provider tree produces", async () => {
    const now = Date.now();
    globalThis.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        distinct_id: "user-1",
        $user_state: "identified",
        $sesid: [now, SESSION_ID, now],
        [PersistedPersonInfoKey.ClientSessionProps]: {
          sessionId: SESSION_ID,
          props: { r: HEALTHY_REFERRER, u: 12_345 },
        },
      })
    );
    const { AnalyticsProvider } = await import("./provider");
    render(
      <AnalyticsProvider trackPageViews>
        <div>Application</div>
      </AnalyticsProvider>
    );

    // `$pageview` is `PostHogPageView`'s passive effect, one commit after the
    // guard's render-phase sweep. It arriving is the ordering claim holding: a
    // client handed over late, or a sweep that ran after it, both leave it
    // absent because posthog-js throws while building its properties. The
    // tighter race — a descendant capturing during ITS render, before any effect
    // — is the sibling `.render-phase` suite, which needs its own module
    // registry to get a second uninitialized posthog-js singleton.
    expect(capturedEvents).toContain("$pageview");
    expect(capturedEvents).toContain(ANALYTICS_PERSISTENCE_REPAIRED_EVENT);
    expect(
      JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "{}")[
        PersistedPersonInfoKey.ClientSessionProps
      ]
    ).toEqual({ sessionId: SESSION_ID, props: { r: HEALTHY_REFERRER } });
  });
});
