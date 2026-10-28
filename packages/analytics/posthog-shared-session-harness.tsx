import { render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import type { BrowserAnalyticsContext } from "./browser-context";
import {
  postHogPersistenceName,
  type StoredSession,
} from "./posthog-shared-session";

/**
 * Shared harness for the ISS-12559 suites that drive the REAL
 * `ClientPostHogProvider` and posthog-js on a `closedloop.ai` host.
 *
 * Not `*.test.*`, so vitest leaves it uncollected. Each suite is its own file
 * because `ClientPostHogProvider` initializes only the first time the posthog-js
 * singleton is unloaded, and posthog-js is externalized, so `vi.resetModules`
 * does not hand a second case a fresh one.
 */

export const SHARED_SESSION_TOKEN = "phc_iss12559_shared_session";
export const SHARED_SESSION_NAME = postHogPersistenceName(SHARED_SESSION_TOKEN);
export const SHARED_COOKIE_DOMAIN = ".closedloop.ai";

/** Pinned with `vi.setSystemTime`; every fixture timestamp is relative to it. */
export const NOW = 1_760_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** This origin's own record, from a visit two hours ago — idle past 30 minutes. */
export const STALE_LOCAL_SESSION: StoredSession = [
  NOW - 2 * HOUR,
  "0199a000-0000-7000-8000-00000000057a",
  NOW - 3 * HOUR,
];

/** Written to the shared cookie by the other site a minute ago. */
export const SHARED_COOKIE_SESSION: StoredSession = [
  NOW - MINUTE,
  "0199a000-0000-7000-8000-0000000005ed",
  NOW - 20 * MINUTE,
];

/** `@posthog/next`'s host-only first-visit seed, frozen since a month ago. */
export const MIDDLEWARE_SEED_SESSION: StoredSession = [
  NOW - 30 * 24 * HOUR,
  "0199a000-0000-7000-8000-00000000005d",
  NOW - 30 * 24 * HOUR,
];

export type ProbeEvent = {
  event: string;
  sessionId: unknown;
  distinctId: unknown;
};

/** Every event posthog-js finished building, in order. */
export const probeEvents: ProbeEvent[] = [];

/**
 * Transport only, plus the `localStorage+cookie` persistence `@posthog/next`
 * sets in production. Cookie scope is left to posthog-js's default, which is
 * the behavior under test.
 */
export const SHARED_SESSION_TRANSPORT = {
  before_send: <
    TEvent extends {
      event: string;
      properties: Record<string, unknown>;
    } | null,
  >(
    event: TEvent
  ) => {
    if (event) {
      probeEvents.push({
        event: event.event,
        sessionId: event.properties.$session_id,
        distinctId: event.properties.distinct_id,
      });
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

/** The `@posthog/next` module, with only its server-rendered half stood in for. */
export async function shippedPostHogNext(): Promise<Record<string, unknown>> {
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
      children: ReactNode;
    }) =>
      createElement(shipped.ClientPostHogProvider, {
        apiKey: SHARED_SESSION_TOKEN,
        options: { ...clientOptions, ...SHARED_SESSION_TRANSPORT },
        children,
      }),
  };
}

export const providerDependencyMocks = {
  keys: () => ({
    isValidGaMeasurementId: () => false,
    keys: () => ({
      NEXT_PUBLIC_GA_MEASUREMENT_ID: undefined,
      NEXT_PUBLIC_POSTHOG_KEY: SHARED_SESSION_TOKEN,
      NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED: undefined,
    }),
  }),
  navigation: () => ({
    usePathname: () => "/",
    useSearchParams: () => new URLSearchParams(),
  }),
};

/** A cookie as the browser stores it; omit `domain` for a host-only one. */
export function setPostHogCookie(
  record: Record<string, unknown>,
  domain?: string
): void {
  const scope = domain ? `; domain=${domain}` : "";
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API, and posthog-js reads `document.cookie`.
  globalThis.document.cookie = `${SHARED_SESSION_NAME}=${encodeURIComponent(
    JSON.stringify(record)
  )}; path=/${scope}`;
}

export function setLocalRecord(record: Record<string, unknown>): void {
  globalThis.localStorage.setItem(SHARED_SESSION_NAME, JSON.stringify(record));
}

/** This origin's persisted record, as posthog-js last saved it. */
export function readLocalRecord(): Record<string, unknown> {
  return JSON.parse(
    globalThis.localStorage.getItem(SHARED_SESSION_NAME) ?? "{}"
  );
}

/** Every value of the PostHog cookie the page can read, in browser order. */
export function readPostHogCookies(): Record<string, unknown>[] {
  const prefix = `${SHARED_SESSION_NAME}=`;
  return globalThis.document.cookie
    .split("; ")
    .filter((pair) => pair.startsWith(prefix))
    .map((pair) => JSON.parse(decodeURIComponent(pair.slice(prefix.length))));
}

/** Renders the production provider tree and captures one event through it. */
export async function captureThroughProvider(
  context: BrowserAnalyticsContext,
  eventName: string
): Promise<ProbeEvent> {
  const { AnalyticsProvider } = await import("./provider");
  const { default: posthog } = await import("posthog-js");
  render(
    <AnalyticsProvider context={context}>
      <div>Page</div>
    </AnalyticsProvider>
  );
  posthog.capture(eventName);
  const probe = probeEvents.find((event) => event.event === eventName);
  if (!probe) {
    throw new Error(`posthog-js captured no ${eventName} event`);
  }
  return probe;
}

/** The marketing site's own identity, from its earlier anonymous visit. */
export const MARKETING_LOCAL_IDENTITY = {
  distinct_id: "anon-marketing",
  $device_id: "anon-marketing",
  $user_state: "anonymous",
} as const;

/** The web app's identity after sign-in. */
export const APP_LOCAL_IDENTITY = {
  distinct_id: "user-12559",
  $device_id: "anon-app",
  $user_state: "identified",
} as const;

/**
 * On `www.closedloop.ai`, arriving from the app: this origin's localStorage is
 * from an earlier visit, and the app wrote the shared cookie a minute ago.
 */
export function arrangeAppToMarketingHop(): void {
  setLocalRecord({ ...MARKETING_LOCAL_IDENTITY, $sesid: STALE_LOCAL_SESSION });
  setPostHogCookie(
    { ...APP_LOCAL_IDENTITY, $sesid: SHARED_COOKIE_SESSION },
    SHARED_COOKIE_DOMAIN
  );
}

/** `@posthog/next`'s middleware seed: an anonymous id that is also the device id. */
export const MIDDLEWARE_SEED_IDENTITY = {
  distinct_id: "anon-app-seed",
  $device_id: "anon-app-seed",
  $user_state: "anonymous",
} as const;

/**
 * On `app.closedloop.ai`, arriving from marketing, with this origin's
 * localStorage cleared: the middleware's host-only seed predates the domain
 * cookie marketing wrote a minute ago, so the browser lists it first and it is
 * the cookie posthog-js reads. This isolates the shadowing cookie from the
 * stale-localStorage cause the marketing suites cover.
 */
export function arrangeMarketingToAppHop(): void {
  // This tab loaded the app before, so its sessionStorage holds a window id.
  globalThis.sessionStorage.setItem(
    `ph_${SHARED_SESSION_TOKEN}_window_id`,
    JSON.stringify("0199a000-0000-7000-8000-0000000000aa")
  );
  setPostHogCookie({
    ...MIDDLEWARE_SEED_IDENTITY,
    $sesid: MIDDLEWARE_SEED_SESSION,
  });
  setPostHogCookie(
    { ...MARKETING_LOCAL_IDENTITY, $sesid: SHARED_COOKIE_SESSION },
    SHARED_COOKIE_DOMAIN
  );
}
