import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  proxyConfig,
  mockNextResponseNext,
  mockPostHogMiddleware,
  middlewareResult,
} = vi.hoisted(() => ({
  proxyConfig: {
    NEXT_PUBLIC_POSTHOG_KEY: undefined as string | undefined,
  },
  mockNextResponseNext: vi.fn(() => ({ kind: "next-response" })),
  mockPostHogMiddleware: vi.fn(() => ({ kind: "posthog-middleware" })),
  middlewareResult: { kind: "posthog-middleware" },
}));

vi.mock("server-only", () => ({}));

vi.mock("@posthog/next", () => ({
  postHogMiddleware: mockPostHogMiddleware,
}));

vi.mock("next/server", () => ({
  NextResponse: { next: mockNextResponseNext },
}));

vi.mock("./keys", () => ({
  keys: () => proxyConfig,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  proxyConfig.NEXT_PUBLIC_POSTHOG_KEY = undefined;
  mockPostHogMiddleware.mockReturnValue(middlewareResult);
});

describe("analyticsMiddleware", () => {
  it("delegates to PostHog with proxy mode and the supplied response", async () => {
    proxyConfig.NEXT_PUBLIC_POSTHOG_KEY = "phc_proxy_test";
    const { analyticsMiddleware } = await import("./proxy");
    const response = { kind: "supplied-response" };

    expect(analyticsMiddleware(response as never)).toBe(middlewareResult);
    expect(mockPostHogMiddleware).toHaveBeenCalledWith({
      proxy: true,
      response,
    });
  });

  it("returns a supplied response unchanged when PostHog is disabled", async () => {
    const { analyticsMiddleware } = await import("./proxy");
    const response = { kind: "supplied-response" };

    await expect(
      analyticsMiddleware(response as never)({} as never)
    ).resolves.toBe(response);
    expect(mockNextResponseNext).not.toHaveBeenCalled();
  });

  it("creates a Next response when disabled and no response was supplied", async () => {
    const { analyticsMiddleware } = await import("./proxy");

    await expect(analyticsMiddleware()({} as never)).resolves.toEqual({
      kind: "next-response",
    });
    expect(mockNextResponseNext).toHaveBeenCalledOnce();
  });
});
