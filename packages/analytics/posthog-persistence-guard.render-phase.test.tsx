/**
 * ISS-8660: the race a layout effect cannot win, against the REAL posthog-js.
 *
 * The sibling `.integration` suite proves the guard beats posthog-js's own
 * lifecycle and `PostHogPageView`'s passive effect. This file proves the tighter
 * claim the guard's install point actually rests on (tamsinb review on the
 * duplicate of this ticket): that it also beats a DESCENDANT which captures
 * while that descendant renders.
 *
 * React renders the whole subtree before it commits and fires any layout effect,
 * so being the first child buys nothing against a render-phase capture — and
 * posthog-js ships one. `@posthog/next` re-exports `useFeatureFlagResult` as
 * `useFeatureFlag` (`dist/client/hooks.js`), this package's `client.ts` wraps
 * it, and the web feature-flag port adapter calls it unconditionally for every
 * port `<FeatureFlagged>` read; this file's descendant calls the
 * `@posthog/next` hook itself. The hook runs
 * `useState(() => client.getFeatureFlagResult(flag))` — render phase, no
 * `send_event: false` — and `getFeatureFlagResult` sends `$feature_flag_called`
 * by default (`options.send_event || !('send_event' in options)`). That capture
 * builds its properties through `getSetOnceProps`, which is the throw this guard
 * exists to prevent.
 *
 * Its own file rather than another case in the sibling: `ClientPostHogProvider`
 * guards on the posthog-js singleton's `__loaded`, so a second render in the
 * same module registry initializes nothing and would run against a store the
 * first case already repaired — green for the wrong reason. Vitest isolates
 * modules per file, which is what makes this a second uninitialized singleton.
 */
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_PERSISTENCE_REPAIRED_EVENT,
  PersistedPersonInfoKey,
} from "./posthog-persistence-repair";

const TOKEN = "phc_iss8660_render_phase";
const STORAGE_KEY = `ph_${TOKEN}_posthog`;
const SESSION_ID = "0198c0de-0000-7000-8000-0000000000fe";
const HEALTHY_REFERRER = "https://www.google.com/search?q=closedloop";

/**
 * Bootstrapped, the way `apps/app`'s root layout mounts the provider. Not
 * decoration: `getFeatureFlagResult` returns early unless `_hasLoadedFlags` is
 * set, and bootstrapping is what sets it synchronously inside `posthog.init`.
 * So this is the configuration in which the render-phase read reaches `capture`
 * on the very first render — the flag makes the hazard MORE reachable, not less.
 */
const BOOTSTRAPPED_FLAG = "iss-8660-render-phase-probe";

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
 * Only the SERVER half is stood in for, as in the sibling suite. Both hooks
 * below come from the resolved `posthog-js/react` unmodified — which is exactly
 * what `@posthog/next`'s browser entry re-exports, so these ARE the shipped
 * hooks and not stand-ins for them.
 */
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
        options: { ...clientOptions, ...TRANSPORT_PLUMBING },
        children,
      }),
  };
});

/** Every event posthog-js finished building — see the sibling suite. */
const capturedEvents: string[] = [];

const TRANSPORT_PLUMBING = {
  before_send: <TEvent extends { event: string } | null>(event: TEvent) => {
    if (event) {
      capturedEvents.push(event.event);
    }
    return event;
  },
  // Bootstrapped locally rather than fetched, so `_hasLoadedFlags` is set
  // without a network round trip and the flag read resolves in the first render.
  bootstrap: { featureFlags: { [BOOTSTRAPPED_FLAG]: true } },
  capture_pageview: false,
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
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a descendant that captures during its own render", () => {
  it("finds the persistence already repaired", async () => {
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

    render(
      <AnalyticsProvider bootstrapFeatureFlags>
        <FlagReadingDescendant />
      </AnalyticsProvider>
    );

    // `$feature_flag_called` existing at all is the whole assertion. Against a
    // poisoned store `calculateEventProperties` throws inside `getSetOnceProps`
    // before `before_send` can see the event — and because the call sits in a
    // `useState` initializer, that throw escapes the render itself.
    expect(capturedEvents).toContain("$feature_flag_called");
    expect(capturedEvents).toContain(ANALYTICS_PERSISTENCE_REPAIRED_EVENT);
    // The repair is the reason, not a coincidence of ordering.
    expect(
      JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "{}")[
        PersistedPersonInfoKey.ClientSessionProps
      ]
    ).toEqual({ sessionId: SESSION_ID, props: { r: HEALTHY_REFERRER } });
  });
});
