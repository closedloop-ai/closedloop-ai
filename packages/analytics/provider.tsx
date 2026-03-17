import { GoogleAnalytics } from "@next/third-parties/google";
import { PostHogPageView, PostHogProvider } from "@posthog/next";
import { Analytics as VercelAnalytics } from "@vercel/analytics/react";
import type { ReactNode } from "react";
import { keys } from "./keys";

type AnalyticsProviderProps = {
  bootstrapFeatureFlags?: boolean;
  trackPageViews?: boolean;
  readonly children: ReactNode;
};

const { NEXT_PUBLIC_GA_MEASUREMENT_ID, NEXT_PUBLIC_POSTHOG_KEY } = keys();

export const AnalyticsProvider = ({
  bootstrapFeatureFlags,
  trackPageViews,
  children,
}: AnalyticsProviderProps) => {
  const posthogEnabled = !!NEXT_PUBLIC_POSTHOG_KEY;

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
      <VercelAnalytics />
      {!!NEXT_PUBLIC_GA_MEASUREMENT_ID && (
        <GoogleAnalytics gaId={NEXT_PUBLIC_GA_MEASUREMENT_ID} />
      )}
    </>
  );
};
