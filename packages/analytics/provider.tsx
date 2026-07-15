import { GoogleAnalytics } from "@next/third-parties/google";
import { PostHogPageView, PostHogProvider } from "@posthog/next";
import { Analytics as VercelAnalytics } from "@vercel/analytics/react";
import type { ReactNode } from "react";
import { isValidGaMeasurementId, keys } from "./keys";

// Derive the posthog-js options type from the provider's own prop so it always
// tracks whatever posthog-js version `@posthog/next` resolves (two versions can
// coexist in the store), avoiding a cross-version `PostHogConfig` mismatch.
type PostHogClientOptions = NonNullable<
  Parameters<typeof PostHogProvider>[0]["clientOptions"]
>;

/**
 * posthog-js init defaults shared by every surface (FEA-2400).
 *
 * Session replay is code-controlled and OFF by default — no session records
 * until `posthog.startSessionRecording()` is called for an opted-in staff user.
 * Inputs are always masked; recorded page text (our own dogfood data) stays
 * visible so a staff replay is actually useful. Console logs are captured so a
 * replay shows what the browser was doing during a freeze. Non-staff/customer
 * sessions therefore record nothing.
 */
const POSTHOG_CLIENT_DEFAULTS: PostHogClientOptions = {
  disable_session_recording: true,
  enable_recording_console_log: true,
  session_recording: {
    maskAllInputs: true,
  },
};

type AnalyticsProviderProps = {
  bootstrapFeatureFlags?: boolean;
  trackPageViews?: boolean;
  nonce?: string;
  readonly children: ReactNode;
};

const {
  NEXT_PUBLIC_GA_MEASUREMENT_ID,
  NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED,
} = keys();

export const AnalyticsProvider = ({
  bootstrapFeatureFlags,
  trackPageViews,
  nonce,
  children,
}: AnalyticsProviderProps) => {
  const posthogEnabled = !!NEXT_PUBLIC_POSTHOG_KEY;
  const vercelAnalyticsEnabled =
    NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED === "true";
  const gaEnabled = isValidGaMeasurementId(NEXT_PUBLIC_GA_MEASUREMENT_ID);

  return (
    <>
      {posthogEnabled ? (
        <PostHogProvider
          bootstrapFlags={bootstrapFeatureFlags}
          clientOptions={POSTHOG_CLIENT_DEFAULTS}
        >
          {children}
          {trackPageViews && <PostHogPageView />}
        </PostHogProvider>
      ) : (
        children
      )}
      {vercelAnalyticsEnabled && <VercelAnalytics />}
      {gaEnabled && NEXT_PUBLIC_GA_MEASUREMENT_ID && (
        <GoogleAnalytics gaId={NEXT_PUBLIC_GA_MEASUREMENT_ID} nonce={nonce} />
      )}
    </>
  );
};
