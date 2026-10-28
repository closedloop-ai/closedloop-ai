import { beforeEach, describe, expect, it, vi } from "vitest";

const { nodeConfig, mockPostHog } = vi.hoisted(() => ({
  nodeConfig: {
    NEXT_PUBLIC_POSTHOG_HOST: "https://analytics.test" as string | undefined,
    NEXT_PUBLIC_POSTHOG_KEY: undefined as string | undefined,
  },
  mockPostHog: vi.fn(function (this: Record<string, unknown>, key, options) {
    this.key = key;
    this.options = options;
  }),
}));

vi.mock("posthog-node", () => ({
  PostHog: mockPostHog,
}));

vi.mock("./keys", () => ({
  keys: () => nodeConfig,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  nodeConfig.NEXT_PUBLIC_POSTHOG_HOST = "https://analytics.test";
  nodeConfig.NEXT_PUBLIC_POSTHOG_KEY = undefined;
});

describe("nodeAnalytics", () => {
  it("provides a complete no-op client when PostHog is disabled", async () => {
    const { nodeAnalytics } = await import("./node");

    expect(nodeAnalytics.capture({ distinctId: "user", event: "event" })).toBe(
      undefined
    );
    // ISS-10503: the alias sink must no-op too, or an unconfigured deployment
    // crashes on the pre-auth alias handshake instead of skipping it.
    expect(
      nodeAnalytics.alias({ distinctId: "user", alias: "onboarding" })
    ).toBe(undefined);
    expect(nodeAnalytics.identify({ distinctId: "user" })).toBe(undefined);
    expect(
      nodeAnalytics.groupIdentify({ groupKey: "org", groupType: "org" })
    ).toBe(undefined);
    await expect(nodeAnalytics.shutdown()).resolves.toBeUndefined();
    expect(mockPostHog).not.toHaveBeenCalled();
  });

  it("runs a request's work when PostHog is disabled and the browser sent a session id", async () => {
    // ISS-11929: every signed-in browser request reaches this with a valid
    // header, so the stub must still run the handler rather than crash on it.
    const { withPostHogRequestContext } = await import("./node");

    const result = withPostHogRequestContext(
      new Headers({
        "X-POSTHOG-SESSION-ID": "019a0f3e-8c2b-7a4d-9e1f-0123456789ab",
      }),
      () => "handled"
    );

    expect(result).toBe("handled");
  });

  it("constructs the real Node client with immediate flushing when enabled", async () => {
    nodeConfig.NEXT_PUBLIC_POSTHOG_KEY = "phc_node_test";
    const { nodeAnalytics } = await import("./node");

    expect(mockPostHog).toHaveBeenCalledWith("phc_node_test", {
      host: "https://analytics.test",
      flushAt: 1,
      flushInterval: 0,
    });
    expect(nodeAnalytics).toMatchObject({
      key: "phc_node_test",
      options: { host: "https://analytics.test" },
    });
  });
});
