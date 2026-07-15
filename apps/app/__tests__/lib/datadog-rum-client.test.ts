import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRumEnv, restoreEnv } from "../helpers/env";

const init = vi.fn();
const nextjsPlugin = vi.fn(() => ({ name: "nextjs" }));

vi.mock("@datadog/browser-rum", () => ({
  datadogRum: {
    init,
    startSessionReplayRecording: vi.fn(),
  },
}));

vi.mock("@datadog/browser-rum-nextjs", () => ({
  nextjsPlugin,
}));

afterEach(() => {
  restoreEnv();
  init.mockClear();
  nextjsPlugin.mockClear();
  vi.resetModules();
});

function loadClient() {
  return import("@/lib/datadog-rum/client");
}

describe("initDatadogRum", () => {
  it("does nothing on the server", async () => {
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "window"
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: undefined,
    });

    const { initDatadogRum } = await loadClient();

    expect(initDatadogRum()).toBe(false);
    expect(init).not.toHaveBeenCalled();

    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("does nothing when required config is absent", async () => {
    clearRumEnv();

    const { initDatadogRum } = await loadClient();

    expect(initDatadogRum()).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it("initializes once with the Next.js plugin and replay disabled", async () => {
    process.env.NEXT_PUBLIC_DATADOG_RUM_APPLICATION_ID = "rum-app-id";
    process.env.NEXT_PUBLIC_DATADOG_RUM_CLIENT_TOKEN = "rum-client-token";
    process.env.NEXT_PUBLIC_DATADOG_RUM_SITE = "datadoghq.com";
    process.env.NEXT_PUBLIC_DATADOG_RUM_SESSION_SAMPLE_RATE = "100";

    const { initDatadogRum } = await loadClient();

    expect(initDatadogRum()).toBe(true);
    expect(initDatadogRum()).toBe(false);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: [{ name: "nextjs" }],
        sessionReplaySampleRate: 0,
        trackUserInteractions: true,
      })
    );
  });

  it("does not throw when the Datadog SDK fails to initialize", async () => {
    process.env.NEXT_PUBLIC_DATADOG_RUM_APPLICATION_ID = "rum-app-id";
    process.env.NEXT_PUBLIC_DATADOG_RUM_CLIENT_TOKEN = "rum-client-token";
    process.env.NEXT_PUBLIC_DATADOG_RUM_SITE = "datadoghq.com";
    init.mockImplementationOnce(() => {
      throw new Error("sdk init failed");
    });

    const { initDatadogRum } = await loadClient();

    expect(initDatadogRum()).toBe(false);
  });
});
