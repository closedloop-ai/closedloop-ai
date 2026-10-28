import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  providerConfig,
  mockGoogleAnalytics,
  mockIsValidGaMeasurementId,
  mockPostHogPageView,
  mockPostHogPersistenceGuard,
  mockPostHogProvider,
  mockSharedSessionGuard,
  mockUrlRedactionGuard,
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
  mockPostHogPersistenceGuard: vi.fn(() => null),
  mockPostHogProvider: vi.fn(
    ({ children }: { children: React.ReactNode }) => children
  ),
  mockSharedSessionGuard: vi.fn((_props: { token: string }) => null),
  mockUrlRedactionGuard: vi.fn(() => null),
  mockVercelAnalytics: vi.fn(() => null),
}));

vi.mock("@next/third-parties/google", () => ({
  GoogleAnalytics: mockGoogleAnalytics,
}));

vi.mock("@posthog/next", () => ({
  PostHogProvider: mockPostHogProvider,
  // The persistence guard reads its client from this hook; null is the shape a
  // surface with no PostHog has, and the branch it must survive.
  usePostHog: () => null,
}));

// Stood in for so this file can assert the WIRING — that the provider mounts it,
// and only where a PostHog client exists to configure. What it installs is
// covered against a real posthog-js in `posthog-url-redaction.test.tsx`.
vi.mock("./posthog-url-redaction-guard", () => ({
  PostHogUrlRedactionGuard: mockUrlRedactionGuard,
}));

vi.mock("./page-view", () => ({
  PostHogPageView: mockPostHogPageView,
}));

vi.mock("./posthog-persistence-guard", () => ({
  PostHogPersistenceGuard: mockPostHogPersistenceGuard,
}));

// What it rewrites is covered against the real provider in the
// `posthog-shared-session.*.integration` suites; this file pins the wiring.
vi.mock("./posthog-shared-session-guard", () => ({
  PostHogSharedSessionGuard: mockSharedSessionGuard,
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
      <AnalyticsProvider trackPageViews>
        <div>Application</div>
      </AnalyticsProvider>
    );

    expect(screen.getByText("Application")).toBeTruthy();
    expect(mockPostHogProvider).not.toHaveBeenCalled();
    expect(mockUrlRedactionGuard).not.toHaveBeenCalled();
    expect(mockPostHogPageView).not.toHaveBeenCalled();
    // Inside the PostHog subtree, never beside it: the guard calls `usePostHog`
    // unconditionally, so mounting it on a surface with no provider would throw
    // on every render of a build that simply has no PostHog key.
    expect(mockPostHogPersistenceGuard).not.toHaveBeenCalled();
    expect(mockSharedSessionGuard).not.toHaveBeenCalled();
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
    // The masking `clientOptions` above cannot carry a function, so the three
    // sinks that need one are closed by this component instead — a `PostHogProvider`
    // rendered without it is a client nothing ever configures.
    expect(mockUrlRedactionGuard).toHaveBeenCalledOnce();
    expect(mockPostHogPageView).toHaveBeenCalledOnce();
    expect(mockVercelAnalytics).toHaveBeenCalledOnce();
    expect(mockGoogleAnalytics.mock.calls[0]?.[0]).toMatchObject({
      gaId: "G-ABC123",
      nonce: "test-nonce",
    });
  });

  it("forwards a suppressed bootstrap, so the server pre-resolves nothing", async () => {
    // ISS-9244: the whole of direction 2 lands on this prop. A provider that
    // defaulted it back to `true` — or dropped it — would leave the deployed E2E
    // lane rendering the signed-in persona's real assignment for its first
    // frames, which is the race the suppression exists to remove.
    providerConfig.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    const { AnalyticsProvider } = await importProvider();

    render(
      <AnalyticsProvider bootstrapFeatureFlags={false}>
        <div>Application</div>
      </AnalyticsProvider>
    );

    expect(mockPostHogProvider.mock.calls[0]?.[0]).toMatchObject({
      bootstrapFlags: false,
    });
  });

  it("ignores a bootstrap request with no PostHog key, keeping the containerized lane on the fixture alone", async () => {
    // ISS-9244 AC3. `merge_group` is the authoritative gate and runs
    // containerized with no PostHog key, so nothing is ever resolved
    // server-side and the localStorage fixture is the whole flag source. This
    // pins that the bootstrap prop is inert on that lane, so a change made for
    // the deployed lane cannot reach it.
    const { AnalyticsProvider } = await importProvider();

    render(
      <AnalyticsProvider bootstrapFeatureFlags trackPageViews>
        <div>Application</div>
      </AnalyticsProvider>
    );

    expect(screen.getByText("Application")).toBeTruthy();
    expect(mockPostHogProvider).not.toHaveBeenCalled();
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
    // Redaction is not a page-view concern: turning tracking off must not take
    // the masking with it.
    expect(mockUrlRedactionGuard).toHaveBeenCalledOnce();
    expect(mockPostHogPageView).not.toHaveBeenCalled();
    // Page-view tracking is opt-in; the persistence sweep is not, because a
    // poisoned record kills autocapture and every other event too.
    expect(mockPostHogPersistenceGuard).toHaveBeenCalledOnce();
  });
});

describe("AnalyticsProvider shared-session wiring (ISS-12559)", () => {
  it("renders the session guard with the project token before the PostHog provider", async () => {
    providerConfig.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    const { AnalyticsProvider } = await importProvider();

    render(
      <AnalyticsProvider>
        <div>Application</div>
      </AnalyticsProvider>
    );

    expect(mockSharedSessionGuard).toHaveBeenCalledOnce();
    expect(mockSharedSessionGuard.mock.calls[0]?.[0]).toEqual({
      token: "phc_test",
    });
    // `ClientPostHogProvider` calls `posthog.init` during its render, so the
    // guard has to have rendered first or the stale record is already loaded.
    expect(mockSharedSessionGuard.mock.invocationCallOrder[0]).toBeLessThan(
      mockPostHogProvider.mock.invocationCallOrder[0] ?? 0
    );
  });
});

function importProvider() {
  vi.resetModules();
  return import("./provider");
}
