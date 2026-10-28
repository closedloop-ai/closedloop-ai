// @vitest-environment-options {"url":"https://www.closedloop.ai/pricing"}
/**
 * ISS-12559, app → marketing, against the REAL `ClientPostHogProvider` and the
 * posthog-js copy it initializes. The counterfactual — the same browser state
 * with the guard removed — is the sibling `.counterfactual` suite.
 */
import { Surface } from "@repo/api/src/types/surface-analytics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEnvironment } from "./environment";
import {
  arrangeAppToMarketingHop,
  captureThroughProvider,
  MARKETING_LOCAL_IDENTITY,
  NOW,
  readLocalRecord,
  readPostHogCookies,
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

describe("arriving on marketing from the app", () => {
  it("captures into the app's session and keeps marketing's own identity", async () => {
    arrangeAppToMarketingHop();

    const probe = await captureThroughProvider(
      { surface: Surface.Marketing, environment: AppEnvironment.Production },
      "iss12559_marketing_probe"
    );

    expect(probe.sessionId).toBe(SHARED_COOKIE_SESSION[1]);
    // Identity is what posthog-js loads on its own: this origin's record.
    expect(probe.distinctId).toBe(MARKETING_LOCAL_IDENTITY.distinct_id);
    // No window id for this origin in the tab yet: posthog-js mints one, fires
    // its session callback, and records THIS landing page as the entry.
    expect(readLocalRecord().$client_session_props).toMatchObject({
      sessionId: SHARED_COOKIE_SESSION[1],
      props: { u: "https://www.closedloop.ai/pricing" },
    });
    // The shared cookie carries the same session on to the next hop.
    expect(readPostHogCookies().map((cookie) => cookie.$sesid)).toEqual([
      [NOW, SHARED_COOKIE_SESSION[1], SHARED_COOKIE_SESSION[2]],
    ]);
  });
});
