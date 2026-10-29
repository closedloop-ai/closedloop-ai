// @vitest-environment-options {"url":"https://app.closedloop.ai/acme/sessions"}
/**
 * ISS-12559, marketing → app, against the REAL `ClientPostHogProvider` and the
 * posthog-js copy it initializes: the middleware's host-only seed cookie must
 * not shadow the session marketing wrote to the shared cookie. Sign-in and
 * sign-out then behave exactly as they did. Counterfactual: the sibling
 * `.app.counterfactual` suite.
 */
import { Surface } from "@repo/api/src/types/surface-analytics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEnvironment } from "./environment";
import {
  APP_LOCAL_IDENTITY,
  arrangeMarketingToAppHop,
  captureThroughProvider,
  MIDDLEWARE_SEED_IDENTITY,
  NOW,
  probeEvents,
  readLocalRecord,
  SHARED_COOKIE_SESSION,
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

describe("arriving on the app from marketing", () => {
  it("resumes marketing's session through sign-in, and sign-out still starts a new one", async () => {
    arrangeMarketingToAppHop();

    const arrival = await captureThroughProvider(
      { surface: Surface.Web, environment: AppEnvironment.Production },
      "iss12559_app_arrival"
    );

    expect(arrival.sessionId).toBe(SHARED_COOKIE_SESSION[1]);
    // The identity posthog-js loads without the guard: the first cookie match.
    expect(arrival.distinctId).toBe(MIDDLEWARE_SEED_IDENTITY.distinct_id);
    // The tab already holds a window id for this origin, so posthog-js's
    // session callback never fires and no entry props are recorded here.
    expect(readLocalRecord().$client_session_props).toBeUndefined();

    const { default: posthog } = await import("posthog-js");
    posthog.identify(APP_LOCAL_IDENTITY.distinct_id);
    posthog.capture("iss12559_app_signed_in");
    const signedIn = lastProbe("iss12559_app_signed_in");
    expect(signedIn.distinctId).toBe(APP_LOCAL_IDENTITY.distinct_id);
    expect(signedIn.sessionId).toBe(SHARED_COOKIE_SESSION[1]);

    posthog.reset();
    posthog.capture("iss12559_app_signed_out");
    const signedOut = lastProbe("iss12559_app_signed_out");
    expect(signedOut.distinctId).not.toBe(APP_LOCAL_IDENTITY.distinct_id);
    expect(signedOut.distinctId).not.toBe(MIDDLEWARE_SEED_IDENTITY.distinct_id);
    expect(signedOut.sessionId).not.toBe(SHARED_COOKIE_SESSION[1]);
  });
});

function lastProbe(eventName: string) {
  const probe = probeEvents.filter((event) => event.event === eventName).pop();
  if (!probe) {
    throw new Error(`posthog-js captured no ${eventName} event`);
  }
  return probe;
}
