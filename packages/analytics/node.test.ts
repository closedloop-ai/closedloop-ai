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
    expect(nodeAnalytics.identify({ distinctId: "user" })).toBe(undefined);
    expect(
      nodeAnalytics.groupIdentify({ groupKey: "org", groupType: "org" })
    ).toBe(undefined);
    await expect(nodeAnalytics.shutdown()).resolves.toBeUndefined();
    expect(mockPostHog).not.toHaveBeenCalled();
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
