// @vitest-environment-options {"url":"https://app.closedloop.ai/acme/sessions"}
/**
 * ISS-12559 counterfactual: the browser state of the sibling
 * `.app.integration` suite with the guard removed. posthog-js's
 * `cookieStore._get` returns the first `ph_<token>_posthog` in
 * `document.cookie`, which is the middleware's older host-only seed, so the
 * session marketing wrote to the shared cookie is never seen.
 */
import { Surface } from "@repo/api/src/types/surface-analytics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEnvironment } from "./environment";
import {
  arrangeMarketingToAppHop,
  captureThroughProvider,
  MIDDLEWARE_SEED_IDENTITY,
  MIDDLEWARE_SEED_SESSION,
  NOW,
  SHARED_COOKIE_SESSION,
} from "./posthog-shared-session-harness";

vi.mock("./posthog-shared-session-guard", () => ({
  PostHogSharedSessionGuard: () => null,
}));
vi.mock("@next/third-parties/google", () => ({ GoogleAnalytics: () => null }));
vi.mock("@vercel/analytics/react", () => ({ Analytics: () => null }));
vi.mock("next/navigation", async () =>
  (
    await import("./posthog-shared-session-harness")
  ).providerDependencyMocks.navigation()
);
vi.mock("./keys", async () =>
  (
    await import("./posthog-shared-session-harness")
  ).providerDependencyMocks.keys()
);
vi.mock("@posthog/next", async () =>
  (await import("./posthog-shared-session-harness")).shippedPostHogNext()
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })))
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("arriving on the app from marketing, without the guard", () => {
  it("loads the host-only seed and splits into a new session", async () => {
    arrangeMarketingToAppHop();

    const arrival = await captureThroughProvider(
      { surface: Surface.Web, environment: AppEnvironment.Production },
      "iss12559_app_counterfactual"
    );

    expect(arrival.distinctId).toBe(MIDDLEWARE_SEED_IDENTITY.distinct_id);
    expect(arrival.sessionId).not.toBe(SHARED_COOKIE_SESSION[1]);
    expect(arrival.sessionId).not.toBe(MIDDLEWARE_SEED_SESSION[1]);
  });
});
