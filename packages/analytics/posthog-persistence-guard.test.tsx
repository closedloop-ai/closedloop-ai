/**
 * ISS-8660: a non-string in a persisted posthog-js person-info record kills
 * capture entirely and silently.
 *
 * Every case here drives a REAL posthog-js — the copy `@posthog/next`
 * initializes in production, via this package's vitest alias — against a
 * `localStorage+cookie` store seeded the way a browser would already hold it,
 * and then asserts an event WAS captured. "Nothing threw" is not the assertion:
 * a client that never initialized satisfies that, and so does the bug itself,
 * whose whole symptom is that capture stops without an error anyone sees.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { render } from "@testing-library/react";
import posthog, { type PostHog } from "posthog-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_PERSISTENCE_REPAIRED_EVENT,
  PersistedPersonInfoKey,
} from "./posthog-persistence-repair";

const HEALTHY_URL = "http://localhost:3000/acme/sessions";
const HEALTHY_REFERRER = "https://www.google.com/search?q=closedloop";
const SESSION_ID = "0198c0de-0000-7000-8000-000000000001";

const { mockPostHogProvider, activeClient, pageViewRoute } = vi.hoisted(() => ({
  pageViewRoute: {
    pathname: "/acme/sessions",
    searchParams: new URLSearchParams(),
  },
  activeClient: { current: null as PostHog | null },
  mockPostHogProvider: vi.fn(
    ({
      children,
    }: {
      children: React.ReactNode;
      clientOptions?: Record<string, unknown>;
    }) => children
  ),
}));

vi.mock("@next/third-parties/google", () => ({ GoogleAnalytics: () => null }));
vi.mock("@vercel/analytics/react", () => ({ Analytics: () => null }));
// `PostHogProvider` renders children directly and `usePostHog` hands back the
// real client this file initialized, so the tree under test — the guard, then
// `PostHogPageView` — is the one `AnalyticsProvider` really renders.
vi.mock("@posthog/next", () => ({
  usePostHog: () => activeClient.current,
  PostHogProvider: mockPostHogProvider,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => pageViewRoute.pathname,
  useSearchParams: () => pageViewRoute.searchParams,
}));
vi.mock("./keys", () => ({
  isValidGaMeasurementId: () => false,
  keys: () => ({
    NEXT_PUBLIC_GA_MEASUREMENT_ID: undefined,
    NEXT_PUBLIC_POSTHOG_KEY: "phc_test",
    NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED: undefined,
  }),
}));

let tokenCounter = 0;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })))
  );
});

afterEach(() => {
  activeClient.current = null;
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("persisted person-info records posthog-js reads on every capture", () => {
  it("still captures a $pageview when $client_session_props.props.u is a number", async () => {
    const store = seedPersistence({
      ...liveSession(),
      [PersistedPersonInfoKey.ClientSessionProps]: {
        sessionId: SESSION_ID,
        props: { r: HEALTHY_REFERRER, u: 12_345 },
      },
    });

    const captured = await renderAnalyticsProvider(store);

    // Emitted by the app itself from a `useEffect`, so this is the guard's
    // render-phase sweep beating the app's first capture, not a synthetic call.
    expect(eventNames(captured)).toContain("$pageview");
  });

  it("still captures when $client_session_props.props.r is a number", async () => {
    const store = seedPersistence({
      ...liveSession(),
      [PersistedPersonInfoKey.ClientSessionProps]: {
        sessionId: SESSION_ID,
        props: { r: 7, u: HEALTHY_URL },
      },
    });

    const captured = await renderAnalyticsProvider(store);

    expect(eventNames(captured)).toContain("$pageview");
  });

  it("still captures when $initial_person_info holds a number for an identified person", async () => {
    // The second store, and the worse one: written with `register_once`, so
    // posthog-js never overwrites it. Read once the person is identified.
    const store = seedPersistence({
      $user_state: "identified",
      [PersistedPersonInfoKey.InitialPersonInfo]: {
        r: HEALTHY_REFERRER,
        u: 999,
      },
    });

    const captured = await renderAnalyticsProvider(store);

    expect(eventNames(captured)).toContain("$pageview");
  });

  it("reports the repair through PostHog so the outage is countable", async () => {
    const store = seedPersistence({
      ...liveSession(),
      [PersistedPersonInfoKey.ClientSessionProps]: {
        sessionId: SESSION_ID,
        props: { r: HEALTHY_REFERRER, u: 12_345 },
      },
    });

    const captured = await renderAnalyticsProvider(store);

    const report = captured.find(
      (event) => event.event === ANALYTICS_PERSISTENCE_REPAIRED_EVENT
    );
    expect(report).toBeDefined();
    expect(report?.properties.repairedKeys).toEqual([
      PersistedPersonInfoKey.ClientSessionProps,
    ]);
    expect(report?.properties.droppedFields).toEqual([
      `${PersistedPersonInfoKey.ClientSessionProps}.u:number`,
    ]);
  });

  it("carries the rejected value's type but never the value itself", async () => {
    const secret = "http://localhost:3000/connect/github?state=9f3c-csrf-token";
    const store = seedPersistence({
      ...liveSession(),
      [PersistedPersonInfoKey.ClientSessionProps]: {
        sessionId: SESSION_ID,
        // An object where a string belongs — the shape whose contents must
        // never be forwarded.
        props: { r: HEALTHY_REFERRER, u: { href: secret } },
      },
    });

    const captured = await renderAnalyticsProvider(store);

    const report = captured.find(
      (event) => event.event === ANALYTICS_PERSISTENCE_REPAIRED_EVENT
    );
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report?.properties.droppedFields).toEqual([
      `${PersistedPersonInfoKey.ClientSessionProps}.u:object`,
    ]);
  });

  it("reports nothing when both records are healthy", async () => {
    const store = seedPersistence({
      ...liveSession(),
      $user_state: "identified",
      [PersistedPersonInfoKey.ClientSessionProps]: {
        sessionId: SESSION_ID,
        props: { r: HEALTHY_REFERRER, u: HEALTHY_URL },
      },
      [PersistedPersonInfoKey.InitialPersonInfo]: {
        r: HEALTHY_REFERRER,
        u: HEALTHY_URL,
      },
    });

    const captured = await renderAnalyticsProvider(store);

    // Capture is alive here too, so "no report" cannot be a dead client.
    expect(eventNames(captured)).toContain("$pageview");
    expect(eventNames(captured)).not.toContain(
      ANALYTICS_PERSISTENCE_REPAIRED_EVENT
    );
  });

  it("leaves a healthy record byte-identical", async () => {
    const healthy = {
      sessionId: SESSION_ID,
      props: { r: HEALTHY_REFERRER, u: HEALTHY_URL },
    };
    const store = seedPersistence({
      ...liveSession(),
      [PersistedPersonInfoKey.ClientSessionProps]: healthy,
    });

    await renderAnalyticsProvider(store);

    expect(
      readPersisted(store)[PersistedPersonInfoKey.ClientSessionProps]
    ).toEqual(healthy);
  });

  it("leaves a shape it does not recognize untouched rather than guessing", async () => {
    // posthog-js's own legacy shape, carrying no `r`/`u`, and a scalar a future
    // release could store. Neither throws, so neither is this guard's business.
    const legacy = {
      sessionId: SESSION_ID,
      props: { initialPathName: "/acme", referringDomain: "google.com" },
    };
    const store = seedPersistence({
      ...liveSession(),
      [PersistedPersonInfoKey.ClientSessionProps]: legacy,
      [PersistedPersonInfoKey.InitialPersonInfo]: 42,
    });

    const captured = await renderAnalyticsProvider(store);

    const persisted = readPersisted(store);
    expect(persisted[PersistedPersonInfoKey.ClientSessionProps]).toEqual(
      legacy
    );
    expect(persisted[PersistedPersonInfoKey.InitialPersonInfo]).toBe(42);
    expect(eventNames(captured)).not.toContain(
      ANALYTICS_PERSISTENCE_REPAIRED_EVENT
    );
  });

  it("repairs the stored record, so a browser poisoned before this shipped recovers on the next load", async () => {
    const store = seedPersistence({
      ...liveSession(),
      $user_state: "identified",
      // Both records, and both fields of one of them: the aggregation across
      // sites and across fields is only pinned where more than one of each
      // exists. With a single bad field everywhere, reporting element zero and
      // reporting all of them are the same string.
      [PersistedPersonInfoKey.ClientSessionProps]: {
        sessionId: SESSION_ID,
        props: { r: true, u: 12_345 },
      },
      [PersistedPersonInfoKey.InitialPersonInfo]: {
        r: HEALTHY_REFERRER,
        u: 999,
      },
    });

    const captured = await renderAnalyticsProvider(store);

    const persisted = readPersisted(store);
    expect(persisted[PersistedPersonInfoKey.ClientSessionProps]).toEqual({
      sessionId: SESSION_ID,
      props: {},
    });
    expect(persisted[PersistedPersonInfoKey.InitialPersonInfo]).toEqual({
      r: HEALTHY_REFERRER,
    });

    // `$initial_person_info` never self-heals, so a report naming only the
    // first repair would undercount the failure mode that actually persists.
    const report = captured.find(
      (event) => event.event === ANALYTICS_PERSISTENCE_REPAIRED_EVENT
    );
    expect(report?.properties.repairedKeys).toEqual([
      PersistedPersonInfoKey.ClientSessionProps,
      PersistedPersonInfoKey.InitialPersonInfo,
    ]);
    expect(report?.properties.droppedFields).toEqual([
      `${PersistedPersonInfoKey.ClientSessionProps}.r:boolean`,
      `${PersistedPersonInfoKey.ClientSessionProps}.u:number`,
      `${PersistedPersonInfoKey.InitialPersonInfo}.u:number`,
    ]);

    // The permanent-outage case: a SECOND client, reading the same store with
    // no guard in the tree at all, the way the browser would on the next load.
    // Before the repair this instance is dead on arrival, forever.
    const reloaded = initPostHog(
      store,
      "reload",
      await harvestProviderClientOptions()
    );
    const afterReload = recordCaptures(reloaded);
    reloaded.capture("$autocapture", { $event_type: "click" });
    expect(eventNames(afterReload)).toContain("$autocapture");
  });

  it("sweeps on a surface that does not track page views, the way apps/web mounts it", async () => {
    // `apps/web/app/[locale]/layout.tsx:45` omits `trackPageViews`, so the
    // `$pageview` every other case leans on does not exist there.
    const store = seedPersistence({
      ...liveSession(),
      [PersistedPersonInfoKey.ClientSessionProps]: {
        sessionId: SESSION_ID,
        props: { r: HEALTHY_REFERRER, u: 12_345 },
      },
    });

    const captured = await renderAnalyticsProvider(store, {
      trackPageViews: false,
    });

    expect(eventNames(captured)).toContain(
      ANALYTICS_PERSISTENCE_REPAIRED_EVENT
    );
    expect(eventNames(captured)).not.toContain("$pageview");
  });

  it("does not leak the current route's secrets through the report it emits", async () => {
    // The report is an ordinary event, so posthog-js attaches its own
    // `$current_url` from `window.location.href`.
    const state = "9f3c-csrf-token";
    navigateTo(`/connect/github?state=${state}&provider=github`);
    const store = seedPersistence({
      ...liveSession(),
      [PersistedPersonInfoKey.ClientSessionProps]: {
        sessionId: SESSION_ID,
        props: { r: HEALTHY_REFERRER, u: 12_345 },
      },
    });

    const captured = await renderAnalyticsProvider(store);

    const report = captured.find(
      (event) => event.event === ANALYTICS_PERSISTENCE_REPAIRED_EVENT
    );
    expect(report).toBeDefined();
    expect(JSON.stringify(report)).not.toContain(state);
    // The positive half: the route IS on the event, just without the secret.
    expect(report?.properties.$current_url).toContain("/connect/github");
  });

  it("does nothing and does not throw when there is no client in context", async () => {
    const store = seedPersistence({
      ...liveSession(),
      [PersistedPersonInfoKey.ClientSessionProps]: {
        sessionId: SESSION_ID,
        props: { r: HEALTHY_REFERRER, u: 12_345 },
      },
    });
    const seeded = readPersisted(store);

    // What a mount outside a `<PostHogProvider>` hands the hook — the shape
    // `posthog-default-properties.test.tsx` already renders this tree in.
    activeClient.current = null;
    const { AnalyticsProvider } = await import("./provider");
    const { container } = render(
      <AnalyticsProvider trackPageViews>
        <div>Application</div>
      </AnalyticsProvider>
    );

    expect(container.textContent).toBe("Application");
    // Untouched, rather than rewritten from a client that does not exist.
    expect(readPersisted(store)).toEqual(seeded);
  });

  it("renders nothing of its own", async () => {
    const store = seedPersistence({});

    const { container } = await renderProviderTree(store);

    expect(container.textContent).toBe("Application");
  });
});

describe("the persistence keys this guard sweeps", () => {
  it("are the keys posthog-js itself writes", async () => {
    // Pinned against posthog-js's own persisted output rather than against this
    // module's constants: a renamed key would otherwise leave the sweep reading
    // nothing and reporting nothing, which is indistinguishable from healthy.
    const store = nextStore();
    const client = initPostHog(
      store,
      "key-pin",
      await harvestProviderClientOptions()
    );
    client.capture("$autocapture", { $event_type: "click" });

    const persisted = readPersisted(store);
    expect(Object.keys(persisted)).toEqual(
      expect.arrayContaining([
        PersistedPersonInfoKey.ClientSessionProps,
        PersistedPersonInfoKey.InitialPersonInfo,
      ])
    );
    // And the INNER field names: a release that renamed `r`/`u` would leave
    // `dropNonStringFields` matching nothing, an outage that looks like health.
    for (const record of [
      (
        persisted[PersistedPersonInfoKey.ClientSessionProps] as {
          props: Record<string, unknown>;
        }
      ).props,
      persisted[PersistedPersonInfoKey.InitialPersonInfo] as Record<
        string,
        unknown
      >,
    ]) {
      expect(Object.keys(record)).toEqual(expect.arrayContaining(["r", "u"]));
    }
  });

  it("are read by the posthog-js version @posthog/next initializes in production", async () => {
    const store = nextStore();
    const client = initPostHog(
      store,
      "version-pin",
      await harvestProviderClientOptions()
    );
    const captured = recordCaptures(client);

    client.capture("$autocapture", { $event_type: "click" });

    expect(captured.at(0)?.properties.$lib_version).toBe(
      shippedPostHogVersion()
    );
  });
});

type CapturedEvent = { event: string; properties: Record<string, unknown> };
type PostHogStore = { token: string; storageKey: string };

/** The posthog-js version `@posthog/next` resolves, read off its manifest. */
function shippedPostHogVersion(): string {
  const fromHere = createRequire(import.meta.url);
  const fromPostHogNext = createRequire(fromHere.resolve("@posthog/next"));
  let dir = path.dirname(fromPostHogNext.resolve("posthog-js"));
  while (dir !== path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === "posthog-js" && parsed.version) {
        return parsed.version;
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    "could not locate the posthog-js manifest @posthog/next uses"
  );
}

/** A store nobody else in this file shares, so cases cannot poison each other. */
function nextStore(): PostHogStore {
  tokenCounter += 1;
  const token = `phc_iss8660_${tokenCounter}`;
  return { token, storageKey: `ph_${token}_posthog` };
}

/** Write the persisted record a browser would already be holding. */
function seedPersistence(props: Record<string, unknown>): PostHogStore {
  const store = nextStore();
  globalThis.localStorage.setItem(
    store.storageKey,
    JSON.stringify({ distinct_id: "user-1", ...props })
  );
  return store;
}

/**
 * What makes a seeded `$client_session_props` SURVIVE init, and load-bearing in
 * every case that seeds one: `SessionPropsManager` rewrites the record whenever
 * the stored `sessionId` differs from the live one, so a case omitting this
 * gets a freshly-derived healthy record and passes with the guard deleted.
 */
function liveSession(): Record<string, unknown> {
  const now = Date.now();
  return { $sesid: [now, SESSION_ID, now] };
}

function readPersisted(store: PostHogStore): Record<string, unknown> {
  const raw = globalThis.localStorage.getItem(store.storageKey);
  if (!raw) {
    throw new Error(`posthog-js persisted nothing under ${store.storageKey}`);
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * `posthog.init` with the two options `@posthog/next`'s own
 * `NEXTJS_CLIENT_DEFAULTS` sets that this bug depends on — pageviews left to
 * `PostHogPageView`, and the `localStorage+cookie` persistence that makes a bad
 * value outlive the tab. The rest is transport plumbing (no batching, no remote
 * config, no external chunks); none of it touches property construction.
 */
function initPostHog(
  store: PostHogStore,
  instanceLabel: string,
  clientOptions: Record<string, unknown>
): PostHog {
  const client = posthog.init(
    store.token,
    {
      // The options `AnalyticsProvider` really renders, so the masking it
      // configures (ISS-8295) is in force on the report this guard emits — not
      // a hand-written set that would let a leak through unnoticed.
      ...clientOptions,
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
    },
    // Distinct per call: posthog-js treats a repeat `init` under the same
    // instance name as a no-op, which would hand a "reload" case back the very
    // client it was meant to replace — repaired in memory and proving nothing.
    `iss8660-${store.token}-${instanceLabel}`
  );
  if (!client) {
    throw new Error("posthog-js did not initialize");
  }
  return client;
}

function recordCaptures(client: PostHog): CapturedEvent[] {
  const captured: CapturedEvent[] = [];
  client._addCaptureHook((event, payload) => {
    if (payload) {
      captured.push({ event, properties: payload.properties });
    }
  });
  return captured;
}

function eventNames(captured: readonly CapturedEvent[]): string[] {
  return captured.map((entry) => entry.event);
}

/**
 * The `clientOptions` `AnalyticsProvider` hands to `@posthog/next`, taken off
 * the provider itself rather than copied, so a case cannot pass against a
 * configuration production does not run.
 *
 * Rendered with no client in context, which is the shape a mount outside a
 * `<PostHogProvider>` produces — the guard must survive it, and the render
 * below throwing is what says it did not.
 */
async function harvestProviderClientOptions(): Promise<
  Record<string, unknown>
> {
  activeClient.current = null;
  const { AnalyticsProvider } = await import("./provider");
  const view = render(
    <AnalyticsProvider trackPageViews>
      <div>Application</div>
    </AnalyticsProvider>
  );
  const clientOptions =
    mockPostHogProvider.mock.calls.at(-1)?.[0]?.clientOptions;
  view.unmount();
  if (!clientOptions) {
    throw new Error("AnalyticsProvider rendered no clientOptions");
  }
  return clientOptions;
}

async function renderProviderTree(
  store: PostHogStore,
  { trackPageViews = true }: { trackPageViews?: boolean } = {}
) {
  const clientOptions = await harvestProviderClientOptions();
  const client = initPostHog(store, "load", clientOptions);
  const captured = recordCaptures(client);
  activeClient.current = client;

  const { AnalyticsProvider } = await import("./provider");
  const view = render(
    <AnalyticsProvider trackPageViews={trackPageViews}>
      <div>Application</div>
    </AnalyticsProvider>
  );
  return { ...view, captured };
}

/** Render the real `AnalyticsProvider` and hand back everything it captured. */
async function renderAnalyticsProvider(
  store: PostHogStore,
  options?: { trackPageViews?: boolean }
): Promise<CapturedEvent[]> {
  const { captured } = await renderProviderTree(store, options);
  return captured;
}

function navigateTo(pathWithQuery: string): void {
  window.history.replaceState({}, "", pathWithQuery);
}
