import { GoogleAnalytics } from "@next/third-parties/google";
import { PostHogPageView, PostHogProvider } from "@posthog/next";
import { Analytics as VercelAnalytics } from "@vercel/analytics/react";
import type { ReactNode } from "react";
import { isValidGaMeasurementId, keys } from "./keys";

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
        <PostHogProvider bootstrapFlags={bootstrapFeatureFlags}>
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
