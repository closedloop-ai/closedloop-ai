import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  providerConfig,
  mockGoogleAnalytics,
  mockIsValidGaMeasurementId,
  mockPostHogPageView,
  mockPostHogProvider,
  mockVercelAnalytics,
} = vi.hoisted(() => ({
  providerConfig: {
    NEXT_PUBLIC_GA_MEASUREMENT_ID: undefined as string | undefined,
    NEXT_PUBLIC_POSTHOG_KEY: undefined as string | undefined,
    NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED: undefined as string | undefined,
  },
  mockGoogleAnalytics: vi.fn(
    (_props: { gaId: string; nonce?: string }) => null
  ),
  mockIsValidGaMeasurementId: vi.fn(
    (value: string | undefined) => value === "G-ABC123"
  ),
  mockPostHogPageView: vi.fn(() => null),
  mockPostHogProvider: vi.fn(
    ({ children }: { children: React.ReactNode }) => children
  ),
  mockVercelAnalytics: vi.fn(() => null),
}));

vi.mock("@next/third-parties/google", () => ({
  GoogleAnalytics: mockGoogleAnalytics,
}));

vi.mock("@posthog/next", () => ({
  PostHogPageView: mockPostHogPageView,
  PostHogProvider: mockPostHogProvider,
}));

vi.mock("@vercel/analytics/react", () => ({
  Analytics: mockVercelAnalytics,
}));

vi.mock("./keys", () => ({
  isValidGaMeasurementId: mockIsValidGaMeasurementId,
  keys: () => providerConfig,
}));

beforeEach(() => {
  vi.clearAllMocks();
  providerConfig.NEXT_PUBLIC_GA_MEASUREMENT_ID = undefined;
  providerConfig.NEXT_PUBLIC_POSTHOG_KEY = undefined;
  providerConfig.NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED = undefined;
});

afterEach(() => {
  cleanup();
});

describe("AnalyticsProvider", () => {
  it("renders children directly when every analytics integration is disabled", async () => {
    providerConfig.NEXT_PUBLIC_GA_MEASUREMENT_ID = "G-placeholder-GAID";
    const { AnalyticsProvider } = await importProvider();

    render(
      <AnalyticsProvider>
        <div>Application</div>
      </AnalyticsProvider>
    );

    expect(screen.getByText("Application")).toBeTruthy();
    expect(mockPostHogProvider).not.toHaveBeenCalled();
    expect(mockPostHogPageView).not.toHaveBeenCalled();
    expect(mockVercelAnalytics).not.toHaveBeenCalled();
    expect(mockGoogleAnalytics).not.toHaveBeenCalled();
  });

  it("configures PostHog defaults, page views, Vercel, and Google Analytics", async () => {
    providerConfig.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    providerConfig.NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED = "true";
    providerConfig.NEXT_PUBLIC_GA_MEASUREMENT_ID = "G-ABC123";
    const { AnalyticsProvider } = await importProvider();

    render(
      <AnalyticsProvider
        bootstrapFeatureFlags
        nonce="test-nonce"
        trackPageViews
      >
        <div>Application</div>
      </AnalyticsProvider>
    );

    expect(screen.getByText("Application")).toBeTruthy();
    expect(mockPostHogProvider.mock.calls[0]?.[0]).toMatchObject({
      bootstrapFlags: true,
      clientOptions: {
        disable_session_recording: true,
        enable_recording_console_log: true,
        session_recording: { maskAllInputs: true },
      },
    });
    expect(mockPostHogPageView).toHaveBeenCalledOnce();
    expect(mockVercelAnalytics).toHaveBeenCalledOnce();
    expect(mockGoogleAnalytics.mock.calls[0]?.[0]).toMatchObject({
      gaId: "G-ABC123",
      nonce: "test-nonce",
    });
  });

  it("keeps PostHog mounted without rendering page-view tracking when disabled by props", async () => {
    providerConfig.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    const { AnalyticsProvider } = await importProvider();

    render(
      <AnalyticsProvider trackPageViews={false}>
        <div>Application</div>
      </AnalyticsProvider>
    );

    expect(mockPostHogProvider).toHaveBeenCalledOnce();
    expect(mockPostHogPageView).not.toHaveBeenCalled();
  });
});

function importProvider() {
  vi.resetModules();
  return import("./provider");
}
