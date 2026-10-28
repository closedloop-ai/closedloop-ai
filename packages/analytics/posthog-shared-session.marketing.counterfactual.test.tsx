// @vitest-environment-options {"url":"https://www.closedloop.ai/pricing"}
/**
 * ISS-12559 counterfactual: the browser state of the sibling
 * `.marketing.integration` suite with the guard removed. posthog-js loads this
 * origin's stale localStorage `$sesid` over the shared cookie, rotates it as
 * idle, and saves the new session over the cookie the app wrote — the split
 * PostHog project 341818 measured on app → www hops.
 */
import { Surface } from "@repo/api/src/types/surface-analytics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEnvironment } from "./environment";
import {
  arrangeAppToMarketingHop,
  captureThroughProvider,
  NOW,
  readPostHogCookies,
  SHARED_COOKIE_SESSION,
  STALE_LOCAL_SESSION,
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

describe("arriving on marketing from the app, without the guard", () => {
  it("splits into a new session and overwrites the app's", async () => {
    arrangeAppToMarketingHop();

    const probe = await captureThroughProvider(
      { surface: Surface.Marketing, environment: AppEnvironment.Production },
      "iss12559_marketing_counterfactual"
    );

    expect(probe.sessionId).not.toBe(SHARED_COOKIE_SESSION[1]);
    expect(probe.sessionId).not.toBe(STALE_LOCAL_SESSION[1]);
    const [cookie] = readPostHogCookies();
    expect(cookie?.$sesid).toEqual([NOW, probe.sessionId, NOW]);
  });
});
