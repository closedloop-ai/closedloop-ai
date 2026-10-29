import { Surface } from "@repo/api/src/types/surface-analytics";
import posthog from "posthog-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserAnalyticsContext } from "./browser-context";
import { AppEnvironment } from "./environment";
import { installBrowserAnalyticsContext } from "./posthog-context";
import {
  captureEvent as captureHarnessEvent,
  IN_PROCESS_POSTHOG_OPTIONS,
} from "./posthog-test-harness";
import { installAnalyticsUrlRedaction } from "./posthog-url-redaction";

let sequence = 0;
const MARKETING: BrowserAnalyticsContext = {
  surface: Surface.Marketing,
  environment: AppEnvironment.Production,
};
const WEB: BrowserAnalyticsContext = {
  surface: Surface.Web,
  environment: AppEnvironment.Production,
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}")))
  );
});
afterEach(() => vi.unstubAllGlobals());

function createClient() {
  sequence += 1;
  const client = posthog.init(
    `phc_context_${sequence}`,
    {
      ...IN_PROCESS_POSTHOG_OPTIONS,
      disable_session_recording: true,
    },
    `context_${sequence}`
  );
  if (!client) {
    throw new Error("PostHog did not initialize");
  }
  // vitest.config.ts resolves posthog-js through @posthog/next; tsc sees the direct dependency.
  return client as unknown as Parameters<
    typeof installBrowserAnalyticsContext
  >[0];
}

describe("capture-time context against the shipped PostHog SDK", () => {
  it("overrides stale persisted and caller attribution on every event, including after identify/reset", () => {
    const client = createClient();
    client.register(WEB);
    installBrowserAnalyticsContext(client, MARKETING);
    for (const event of [
      "$pageview",
      "$autocapture",
      "button_clicked",
      "$feature_flag_called",
    ]) {
      const payload = captureEvent(client, event, { ...WEB, platform: "web" });
      expect(payload.properties).toMatchObject({
        ...MARKETING,
        platform: "web",
      });
    }
    client.identify("identified-visitor", { surface: Surface.Web });
    expect(captureEvent(client, "after_identify", {}).properties).toMatchObject(
      MARKETING
    );
    client.reset();
    expect(captureEvent(client, "after_reset", {}).properties).toMatchObject(
      MARKETING
    );
    expect(client.get_property("surface")).toBeUndefined();
    expect(client.get_property("environment")).toBeUndefined();
  });

  it("keeps separate clients isolated and leaves previously captured events unchanged", () => {
    const marketing = createClient();
    const web = createClient();
    installBrowserAnalyticsContext(marketing, MARKETING);
    installBrowserAnalyticsContext(web, WEB);
    const first = captureEvent(marketing, "$pageview", {});
    web.register(MARKETING);
    expect(captureEvent(web, "$pageview", {}).properties).toMatchObject(WEB);
    marketing.register(WEB);
    expect(captureEvent(marketing, "$pageview", {}).properties).toMatchObject(
      MARKETING
    );
    web.identify("same-visitor", { surface: Surface.Web });
    marketing.identify("same-visitor", { surface: Surface.Web });
    expect(first.properties).toMatchObject(MARKETING);
  });

  it("updates context without stacking hooks and composes with URL redaction", () => {
    const client = createClient();
    installBrowserAnalyticsContext(client, MARKETING);
    const firstHook = client.config.before_send;
    installBrowserAnalyticsContext(client, MARKETING);
    expect(client.config.before_send).toBe(firstHook);
    installAnalyticsUrlRedaction(client);
    const chain = client.config.before_send;
    installBrowserAnalyticsContext(client, {
      ...MARKETING,
      environment: AppEnvironment.Preview,
    });
    expect(client.config.before_send).toBe(chain);
    const payload = captureEvent(client, "$pageview", {
      $current_url: "https://www.closedloop.ai/?code=secret-value",
    });
    expect(payload.properties).toMatchObject({
      surface: Surface.Marketing,
      environment: AppEnvironment.Preview,
    });
    expect(JSON.stringify(payload)).not.toContain("secret-value");
    expect(client.config.disable_session_recording).toBe(true);
  });

  it("preserves existing before_send filtering", () => {
    const client = createClient();
    const sink = vi.fn();
    client.set_config({ before_send: () => null });
    installBrowserAnalyticsContext(client, MARKETING);
    const remove = client._addCaptureHook(sink);
    client.capture("filtered");
    expect(sink).not.toHaveBeenCalled();
    remove();
  });
});

function captureEvent(
  client: Parameters<typeof installBrowserAnalyticsContext>[0],
  event: string,
  properties: Record<string, unknown>
) {
  // The harness is typed against the direct dependency; both resolve to the shipped SDK in Vitest.
  return captureHarnessEvent(
    client as unknown as Parameters<typeof captureHarnessEvent>[0],
    event,
    properties
  );
}
