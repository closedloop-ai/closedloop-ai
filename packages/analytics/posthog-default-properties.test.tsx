/**
 * ISS-8295: the property bag posthog-js builds for itself.
 *
 * The `$pageview` this package captures by hand is NOT the exposure. posthog-js
 * attaches `$current_url` — read verbatim from `window.location.href` — as a
 * DEFAULT property on every event it sends, so an autocapture click on the
 * desktop authorize route carried `state`, `code_challenge`, `redirect_uri`,
 * `device_name` and `email_hint` to PostHog with nothing in our code involved.
 *
 * So these cases capture a NON-`$pageview` event and assert on the payload
 * posthog-js actually hands to its transport. A `$pageview`-only test would
 * re-prove ISS-8173's call-site redaction and prove nothing about this one.
 *
 * The options fed to `posthog.init` are the ones `AnalyticsProvider` really
 * renders — read off the `clientOptions` prop it passes — not a copy. Deleting
 * the masking config from the provider turns these red.
 */
import { render } from "@testing-library/react";
// Resolved to the copy `@posthog/next` initializes in production, by the
// exact-match alias in this package's `vitest.config.ts` (whitlockk review) — the
// version assertion at the end of the suite is what proves it took effect.
import posthog, { type PostHog } from "posthog-js";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  captureAutocaptureClick,
  IN_PROCESS_POSTHOG_OPTIONS,
  navigateTo,
  readCurrentUrl,
  shippedPostHogVersion,
} from "./posthog-test-harness";

const AUTHORIZE_PATH = "/connect/github";
const ORDINARY_PATH = "/acme/sessions";

const SECRETS = {
  state: "9f3c-csrf-token",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  redirectUri: "http://127.0.0.1:51234/callback",
  gatewayId: "gw_01JQ8Z2K",
  gatewayPublicKey: "TUlJQklqQU5CZ2txaGtpRzl3MEJBUUVGQUFP",
  deviceName: "Marisol's MacBook Pro",
  emailHint: "bWlrZUBleGFtcGxlLmNvbQ",
  code: "pair_ABCD-1234",
} as const;

const { providerConfig, mockPostHogProvider, pageViewRoute } = vi.hoisted(
  () => ({
    pageViewRoute: {
      pathname: "/",
      searchParams: new URLSearchParams(),
    },
    providerConfig: {
      NEXT_PUBLIC_GA_MEASUREMENT_ID: undefined as string | undefined,
      NEXT_PUBLIC_POSTHOG_KEY: "phc_test" as string | undefined,
      NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED: undefined as string | undefined,
    },
    mockPostHogProvider: vi.fn(
      ({
        children,
      }: {
        children: React.ReactNode;
        clientOptions?: Record<string, unknown>;
      }) => children
    ),
  })
);

vi.mock("@next/third-parties/google", () => ({ GoogleAnalytics: () => null }));
vi.mock("@vercel/analytics/react", () => ({ Analytics: () => null }));
vi.mock("@posthog/next", () => ({
  // The provider renders this package's OWN `PostHogPageView` (ISS-8173), and
  // it is left real here rather than mocked away — it is the surface these
  // cases sit beside. It reads its client from `usePostHog`, so returning null
  // makes it a no-op and keeps `$pageview` out of this file: the explicit
  // `$current_url` it captures is redacted at the call site and asserted in
  // `page-view.test.tsx`, while these cases own the half posthog-js builds for
  // itself on every OTHER event.
  usePostHog: () => null,
  PostHogProvider: mockPostHogProvider,
}));
// The real `PostHogPageView` above reads the route from `next/navigation`,
// which has no App Router to read from under vitest. Stable instances, because
// both values are effect dependencies.
vi.mock("next/navigation", () => ({
  usePathname: () => pageViewRoute.pathname,
  useSearchParams: () => pageViewRoute.searchParams,
}));
vi.mock("./keys", () => ({
  isValidGaMeasurementId: () => false,
  keys: () => providerConfig,
}));

let instanceCounter = 0;

// Warm the dynamic import once. Otherwise whichever case runs first pays the
// posthog-js module load inside its own timeout budget, which on a loaded
// machine is the difference between a pass and a spurious 5s timeout.
beforeAll(async () => {
  await import("./provider");
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        Promise.resolve(
          new Response("{}", { status: 200 })
        ) as Promise<Response>
    )
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("posthog-js default properties on a non-$pageview event", () => {
  it("masks every sensitive value out of $current_url on an autocapture event", async () => {
    navigateTo(`${AUTHORIZE_PATH}?${authorizeQueryString()}`);
    const client = await initPostHogAsTheProviderConfiguresIt();

    const payload = captureAutocaptureClick(client);

    const currentUrl = readCurrentUrl(payload);
    for (const secret of Object.values(SECRETS)) {
      expect(currentUrl).not.toContain(secret);
    }
  });

  it("leaks no sensitive value anywhere in the event posthog-js sends", async () => {
    navigateTo(`${AUTHORIZE_PATH}?${authorizeQueryString()}`);
    const client = await initPostHogAsTheProviderConfiguresIt();

    const payload = captureAutocaptureClick(client);

    // `$current_url` is not the only href-derived property: `$initial_current_url`
    // (a person property, also persisted) is built from the same location, and a
    // future posthog-js release can add more. Asserting over the WHOLE serialized
    // event is what makes this hold for the ones nobody enumerated.
    const serialized = JSON.stringify(payload);
    for (const secret of Object.values(SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps the path and the non-identifying params so path analytics still works", async () => {
    navigateTo(`${AUTHORIZE_PATH}?${authorizeQueryString()}`);
    const client = await initPostHogAsTheProviderConfiguresIt();

    const payload = captureAutocaptureClick(client);

    // Redact, do not drop: the url has to remain a url, or ISS-8173's heatmaps
    // and path analytics go with it.
    const parsed = new URL(readCurrentUrl(payload));
    expect(parsed.pathname).toBe(AUTHORIZE_PATH);
    expect(parsed.searchParams.get("platform")).toBe("darwin");
    expect(parsed.searchParams.get("provider")).toBe("github");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    // The key survives the masking — it is what says a handoff happened.
    expect(parsed.searchParams.has("state")).toBe(true);
    expect(parsed.searchParams.get("state")).not.toBe(SECRETS.state);
  });

  it("leaves an ordinary route's url untouched when there is nothing to mask", async () => {
    const href = `${ORDINARY_PATH}?status=active&page=2`;
    navigateTo(href);
    const client = await initPostHogAsTheProviderConfiguresIt();

    const payload = captureAutocaptureClick(client);

    // The no-op path: no marker is emitted where no sensitive value matched, so
    // an unrelated route's analytics is byte-identical to what it was before.
    expect(readCurrentUrl(payload)).toBe(`${window.location.origin}${href}`);
    expect(readCurrentUrl(payload)).not.toContain("masked");
  });

  it("masks the desktop pairing authorization code", async () => {
    navigateTo(
      `/acme/settings/integrations/desktop/connect?code=${SECRETS.code}`
    );
    const client = await initPostHogAsTheProviderConfiguresIt();

    const payload = captureAutocaptureClick(client);

    expect(readCurrentUrl(payload)).not.toContain(SECRETS.code);
  });

  it("masks the signed-out detour's nested authorize URL", async () => {
    // The URL a signed-out desktop-authorize request is actually redirected to
    // by `apps/app/proxy.ts`. The secrets are not top-level params here — they
    // are characters inside `redirect_url`'s value, and posthog-js's
    // `maskQueryParams` splits on `&`/`=` and compares the top-level key only,
    // so a list that does not name this key leaves all of them readable on the
    // one route the flow really sends people to.
    navigateTo(
      `${AUTHORIZE_PATH}?${new URLSearchParams({
        redirect_url: `/settings/integrations/desktop/authorize?${authorizeQueryString()}`,
      }).toString()}`
    );
    const client = await initPostHogAsTheProviderConfiguresIt();

    const payload = captureAutocaptureClick(client);

    const serialized = JSON.stringify(payload);
    for (const secret of Object.values(SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("captures a non-$pageview event, so the guard above cannot be a $pageview result", async () => {
    navigateTo(ORDINARY_PATH);
    const client = await initPostHogAsTheProviderConfiguresIt();

    const payload = captureAutocaptureClick(client);

    expect(payload.event).toBe("$autocapture");
  });

  it("runs against the posthog-js version @posthog/next initializes in production", async () => {
    navigateTo(ORDINARY_PATH);
    const client = await initPostHogAsTheProviderConfiguresIt();

    const payload = captureAutocaptureClick(client);

    // Without this the suite could go green on a workspace copy whose masking
    // behaviour production never runs. `$lib_version` is posthog-js reporting
    // its own identity on the payload, so it cannot be satisfied by a resolution
    // this file arranged and then asserted about itself.
    expect(payload.properties.$lib_version).toBe(shippedPostHogVersion());
  });
});

function authorizeQueryString(): string {
  return new URLSearchParams({
    state: SECRETS.state,
    code_challenge: SECRETS.codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: SECRETS.redirectUri,
    gateway_id: SECRETS.gatewayId,
    gateway_public_key: SECRETS.gatewayPublicKey,
    device_name: SECRETS.deviceName,
    email_hint: SECRETS.emailHint,
    platform: "darwin",
    provider: "github",
  }).toString();
}

/**
 * Render the real `AnalyticsProvider`, take the `clientOptions` it hands to
 * `@posthog/next` — the object that reaches `posthog.init` in production — and
 * initialize a real posthog-js with it.
 *
 * The extra options are transport plumbing only (a named instance so cases do
 * not share the module singleton, memory persistence, no batching, no remote
 * config fetch). None of them touches property construction.
 */
async function initPostHogAsTheProviderConfiguresIt(): Promise<PostHog> {
  const { AnalyticsProvider } = await import("./provider");
  render(
    <AnalyticsProvider trackPageViews>
      <div>Application</div>
    </AnalyticsProvider>
  );

  const clientOptions =
    mockPostHogProvider.mock.calls.at(-1)?.[0]?.clientOptions;
  if (!clientOptions) {
    throw new Error("AnalyticsProvider rendered no clientOptions");
  }

  instanceCounter += 1;
  const client = posthog.init(
    "phc_test",
    {
      ...clientOptions,
      ...IN_PROCESS_POSTHOG_OPTIONS,
    },
    `iss8295-${instanceCounter}`
  );
  if (!client) {
    throw new Error("posthog-js did not initialize");
  }
  return client;
}
