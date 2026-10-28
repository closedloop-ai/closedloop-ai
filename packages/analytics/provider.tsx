import { GoogleAnalytics } from "@next/third-parties/google";
import { PostHogProvider } from "@posthog/next";
import { Analytics as VercelAnalytics } from "@vercel/analytics/react";
import type { ReactNode } from "react";
import type { BrowserAnalyticsContext } from "./browser-context";
import { isValidGaMeasurementId, keys } from "./keys";
import { PostHogPageView } from "./page-view";
import { PostHogContextGuard } from "./posthog-context-guard";
import { PostHogPersistenceGuard } from "./posthog-persistence-guard";
import { PostHogSharedSessionGuard } from "./posthog-shared-session-guard";
import { PostHogUrlRedactionGuard } from "./posthog-url-redaction-guard";
import { SENSITIVE_QUERY_PARAMS } from "./sensitive-query-params";

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
 * until `./session-replay`'s `startWebSessionReplay` runs for a signed-in
 * product-app user or a marketing visitor (no sign-in required) assigned
 * the `web-frontend-capture` flag (ISS-12558). Inputs are always masked;
 * recorded page text stays visible, including in flagged customer replays, so
 * a replay is useful. Console logs are captured so a replay shows what the
 * browser was doing during a freeze.
 *
 * `mask_personal_data_properties` + `custom_personal_data_properties` are the
 * single redaction chokepoint for URL secrets (ISS-8295). posthog-js builds
 * `$current_url` from `window.location.href` as a DEFAULT property, so it rides
 * every event — autocapture, rageclicks, web vitals, heatmap payloads, and the
 * persisted `$initial_current_url` person property — and no call-site redaction
 * can reach any of them. Masking here reaches all of them at once, which is the
 * point: the failure mode being fixed is that a NEW event type inherits the
 * default and nobody remembers to redact it.
 *
 * Everything in THIS object has to be data. It is a prop handed from a Server
 * Component (`AnalyticsProvider`, via `@posthog/next`'s own server
 * `PostHogProvider`) down to the `"use client"` `ClientPostHogProvider` that
 * calls `posthog.init`, and a function cannot cross that boundary. These two
 * options are a boolean and a string array, so they can — and they apply INSIDE
 * posthog-js at property-construction time, upstream of everything the event
 * payload later carries.
 *
 * What this list CANNOT do is normalize a key spelling, reach a value posthog-js
 * restored from persistence, or reach session replay, because all three need a
 * function. Those are installed from `<PostHogUrlRedactionGuard />` below —
 * adding a name here does not close any of them.
 *
 * Turning `mask_personal_data_properties` on also masks posthog-js's own
 * `PERSONAL_DATA_CAMPAIGN_PARAMS` (`gclid`, `fbclid`, `msclkid`, ...). Nothing
 * in this repo reads an ad click-through id, and masking them is the behavior
 * PostHog documents the flag for.
 */
const POSTHOG_CLIENT_DEFAULTS: PostHogClientOptions = {
  disable_session_recording: true,
  enable_recording_console_log: true,
  session_recording: {
    maskAllInputs: true,
  },
  mask_personal_data_properties: true,
  custom_personal_data_properties: [...SENSITIVE_QUERY_PARAMS],
};

type AnalyticsProviderProps = {
  context?: BrowserAnalyticsContext;
  /**
   * The cl-api origin this surface's browser calls. posthog-js adds its
   * `X-POSTHOG-*` session headers to requests for this hostname and no other
   * (ISS-11929), so server-side events link to the browser's replay. Omitted,
   * no request carries them.
   */
  apiOrigin?: string | null;
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
  context,
  apiOrigin,
  bootstrapFeatureFlags,
  trackPageViews,
  nonce,
  children,
}: AnalyticsProviderProps) => {
  const vercelAnalyticsEnabled =
    NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED === "true";
  const gaEnabled = isValidGaMeasurementId(NEXT_PUBLIC_GA_MEASUREMENT_ID);

  return (
    <>
      {NEXT_PUBLIC_POSTHOG_KEY ? (
        <>
          {/* Before the provider: it must rewrite storage before `posthog.init`. */}
          <PostHogSharedSessionGuard token={NEXT_PUBLIC_POSTHOG_KEY} />
          <PostHogProvider
            bootstrapFlags={bootstrapFeatureFlags}
            clientOptions={postHogClientOptions(apiOrigin)}
          >
            {context && <PostHogContextGuard context={context} />}
            {/* Repair can emit events, so attribution must already be installed. */}
            <PostHogPersistenceGuard />
            <PostHogUrlRedactionGuard />
            {children}
            {trackPageViews && <PostHogPageView />}
          </PostHogProvider>
        </>
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

// `__add_tracing_headers`, not its newer `addTracingHeaders` alias: the
// posthog-js copy `@posthog/next` pins reads only this name.
function postHogClientOptions(
  apiOrigin: string | null | undefined
): PostHogClientOptions {
  if (!apiOrigin) {
    return POSTHOG_CLIENT_DEFAULTS;
  }
  return {
    ...POSTHOG_CLIENT_DEFAULTS,
    __add_tracing_headers: [new URL(apiOrigin).hostname],
  };
}
