// @vitest-environment-options {"url":"https://www.closedloop.ai/pricing"}
/**
 * ISS-12559, against the REAL `ClientPostHogProvider` and posthog-js: marketing
 * sat in a background tab until `SessionIdManager._resetIdleTimer` cleared its
 * `$sesid` to `[null, null, null]`, while the app tab stayed active. Reloading
 * marketing must continue the app's session, not start a new one.
 */
import { Surface } from "@repo/api/src/types/surface-analytics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEnvironment } from "./environment";
import {
  APP_LOCAL_IDENTITY,
  captureThroughProvider,
  MARKETING_LOCAL_IDENTITY,
  NOW,
  SHARED_COOKIE_DOMAIN,
  SHARED_COOKIE_SESSION,
  setLocalRecord,
  setPostHogCookie,
} from "./posthog-shared-session-harness";

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

describe("reloading a marketing tab whose session the idle timer cleared", () => {
  it("continues the session the app kept active", async () => {
    setLocalRecord({ ...MARKETING_LOCAL_IDENTITY, $sesid: [null, null, null] });
    setPostHogCookie(
      { ...APP_LOCAL_IDENTITY, $sesid: SHARED_COOKIE_SESSION },
      SHARED_COOKIE_DOMAIN
    );

    const probe = await captureThroughProvider(
      { surface: Surface.Marketing, environment: AppEnvironment.Production },
      "iss12559_idle_cleared_probe"
    );

    expect(probe.sessionId).toBe(SHARED_COOKIE_SESSION[1]);
    expect(probe.distinctId).toBe(MARKETING_LOCAL_IDENTITY.distinct_id);
  });
});
