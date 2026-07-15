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
      trackUserInteractions: true,
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

  it.each([
    ["Next.js notFound() 404 control flow", "NEXT_HTTP_ERROR_FALLBACK;404"],
    [
      "Clerk UI mount watchdog timeout",
      "[Clerk UI] Component renderer did not mount within 10s. Check the Network tab.",
    ],
    [
      "React #418 hydration mismatch",
      "Minified React error #418; visit https://react.dev/errors/418 for the full message",
    ],
  ])("drops benign client error class: %s (FEA-2404)", async (_label, message) => {
    const { scrubDatadogRumEvent } = await loadConfig();
    const event = {
      type: "error",
      error: { message },
    };

    expect(scrubDatadogRumEvent(event as never)).toBe(false);
  });

  it("matches a benign signature found only in the error stack", async () => {
    const { scrubDatadogRumEvent } = await loadConfig();
    const event = {
      type: "error",
      error: {
        message: "Error",
        stack: "Error\n  at r (chunk.js:1)\n  NEXT_HTTP_ERROR_FALLBACK;404",
      },
    };

    expect(scrubDatadogRumEvent(event as never)).toBe(false);
  });

  it("preserves novel/unlisted error events so real regressions still reach RUM", async () => {
    const { scrubDatadogRumEvent } = await loadConfig();
    const event = {
      type: "error",
      error: {
        message: "TypeError: Cannot read properties of undefined (reading 'x')",
      },
    };

    expect(scrubDatadogRumEvent(event as never)).toBe(true);
  });

  it("drops action events for non-staff sessions", async () => {
    const { scrubDatadogRumEvent, isDatadogRumStaffCaptureEnabled } =
      await loadConfig();
    const event = {
      type: "action",
      action: { target: { name: "Confidential Document Title" } },
    };

    expect(isDatadogRumStaffCaptureEnabled()).toBe(false);
    expect(scrubDatadogRumEvent(event as never)).toBe(false);
  });

  it("forwards action events once staff capture is enabled", async () => {
    const {
      scrubDatadogRumEvent,
      setDatadogRumStaffCapture,
      isDatadogRumStaffCaptureEnabled,
    } = await loadConfig();
    const event = {
      type: "action",
      action: { target: { name: "Confidential Document Title" } },
    };

    setDatadogRumStaffCapture(true);
    expect(isDatadogRumStaffCaptureEnabled()).toBe(true);
    expect(scrubDatadogRumEvent(event as never)).toBe(true);

    setDatadogRumStaffCapture(false);
    expect(scrubDatadogRumEvent(event as never)).toBe(false);
  });

  it("keeps non-action events unaffected by the staff gate", async () => {
    const { scrubDatadogRumEvent } = await loadConfig();
    const errorEvent = { type: "error", error: { message: "boom" } };

    expect(scrubDatadogRumEvent(errorEvent as never)).toBe(true);
  });
});
