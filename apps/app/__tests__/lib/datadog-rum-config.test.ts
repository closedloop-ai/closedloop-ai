import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRumEnv, restoreEnv } from "../helpers/env";

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

function loadConfig() {
  return import("@/lib/datadog-rum/config");
}

describe("getDatadogRumConfig", () => {
  it("returns null when required public RUM config is absent", async () => {
    clearRumEnv();

    const { getDatadogRumConfig } = await loadConfig();

    expect(getDatadogRumConfig()).toBeNull();
  });

  it("builds the Datadog RUM config from public env vars and app environment", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.closedloop-stage.ai";
    process.env.NEXT_PUBLIC_DATADOG_RUM_APPLICATION_ID = "rum-app-id";
    process.env.NEXT_PUBLIC_DATADOG_RUM_CLIENT_TOKEN = "rum-client-token";
    process.env.NEXT_PUBLIC_DATADOG_RUM_SITE = "datadoghq.com";
    process.env.NEXT_PUBLIC_DATADOG_RUM_SESSION_SAMPLE_RATE = "45";
    process.env.NEXT_PUBLIC_DATADOG_RUM_VERSION = "abcdef123456";

    const { getDatadogRumConfig } = await loadConfig();

    expect(getDatadogRumConfig()).toMatchObject({
      applicationId: "rum-app-id",
      clientToken: "rum-client-token",
      defaultPrivacyLevel: "mask-user-input",
      env: "stage",
      service: "cl-app",
      sessionReplaySampleRate: 0,
      sessionSampleRate: 45,
      site: "datadoghq.com",
      trackLongTasks: true,
      trackResources: true,
      trackUserInteractions: false,
      version: "abcdef123456",
    });
  });

  it("uses explicit local/test RUM version before Vercel git metadata", async () => {
    process.env.NEXT_PUBLIC_DATADOG_RUM_VERSION = "rum-e2e-version-20260522";
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef123456";

    const { getDatadogRumVersion } = await loadConfig();

    expect(getDatadogRumVersion()).toBe("rum-e2e-version-20260522");
  });

  it("uses the generated build version before stale public RUM env", async () => {
    process.env.NEXT_PUBLIC_DATADOG_RUM_BUILD_VERSION = "preview-head-sha";
    process.env.NEXT_PUBLIC_DATADOG_RUM_VERSION = "stale-explicit-version";

    const { getDatadogRumVersion } = await loadConfig();

    expect(getDatadogRumVersion()).toBe("preview-head-sha");
  });

  it("falls back to unknown only when no version source is present", async () => {
    clearRumEnv();

    const { getDatadogRumVersion } = await loadConfig();

    expect(getDatadogRumVersion()).toBe("unknown");
  });

  it("bounds invalid sample rates and keeps replay disabled", async () => {
    process.env.NEXT_PUBLIC_DATADOG_RUM_APPLICATION_ID = "rum-app-id";
    process.env.NEXT_PUBLIC_DATADOG_RUM_CLIENT_TOKEN = "rum-client-token";
    process.env.NEXT_PUBLIC_DATADOG_RUM_SITE = "datadoghq.com";
    process.env.NEXT_PUBLIC_DATADOG_RUM_SESSION_SAMPLE_RATE = "not-a-number";

    const { getDatadogRumConfig } = await loadConfig();

    expect(getDatadogRumConfig()).toMatchObject({
      sessionReplaySampleRate: 0,
      sessionSampleRate: 100,
    });
  });

  it("preserves Datadog SDK view URLs before sending events", async () => {
    const { scrubDatadogRumEvent } = await loadConfig();
    const event = {
      type: "view",
      view: {
        id: "view-id",
        name: "/rum-validation/sensitive-route-param",
        referrer: "https://app.closedloop-stage.ai/from?sensitiveQuery=value",
        url: "https://app.closedloop-stage.ai/rum-validation/sensitive-route-param?sensitiveQuery=sensitive-query-value#hash",
      },
    };

    expect(scrubDatadogRumEvent(event as never)).toBe(true);
    expect(event.view).toMatchObject({
      name: "/rum-validation/sensitive-route-param",
      referrer: "https://app.closedloop-stage.ai/from?sensitiveQuery=value",
      url: "https://app.closedloop-stage.ai/rum-validation/sensitive-route-param?sensitiveQuery=sensitive-query-value#hash",
    });
  });

  it("preserves non-localhost resource URLs before sending events", async () => {
    const { scrubDatadogRumEvent } = await loadConfig();
    const event = {
      type: "resource",
      resource: {
        url: "https://app.closedloop-stage.ai/api/resource?sensitiveQuery=value#hash",
      },
    };

    expect(scrubDatadogRumEvent(event as never)).toBe(true);
    expect(event.resource.url).toBe(
      "https://app.closedloop-stage.ai/api/resource?sensitiveQuery=value#hash"
    );
  });

  it("drops localhost resource events before sending to Datadog", async () => {
    const { scrubDatadogRumEvent } = await loadConfig();
    const event = {
      type: "resource",
      resource: {
        url: "http://localhost:3000/api/gateway/run?command=sensitive",
      },
    };

    expect(scrubDatadogRumEvent(event as never)).toBe(false);
  });
});
