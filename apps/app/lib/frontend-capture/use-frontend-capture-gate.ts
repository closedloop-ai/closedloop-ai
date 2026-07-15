"use client";

import { useAnalytics, useFeatureFlag } from "@repo/analytics/client";
import { useUser } from "@repo/auth/client";
import { useEffect } from "react";
import {
  disableDatadogRumStaffCapture,
  enableDatadogRumStaffCapture,
} from "@/lib/datadog-rum/staff-capture";
import { isStaffEmail, WEB_FRONTEND_CAPTURE_FLAG_KEY } from "./flag";

/**
 * Staff-gated frontend capture (FEA-2400).
 *
 * When the `web-frontend-capture` flag is enabled for an identified staff user
 * (PostHog targets it to the `@closedloop.ai` staff org), start masked PostHog
 * session replay + dead-click autocapture and Datadog RUM interaction/replay
 * capture. When the flag flips off, or the user signs out, or the component
 * unmounts, all added capture is stopped — keeping capture fully reversible.
 *
 * Nothing is enabled until identity resolves, the user is staff, and the flag
 * reads enabled — so non-staff/customer sessions never start any added capture.
 * The staff-email check is intentional defense-in-depth: `useFeatureFlag` fails
 * open when PostHog is unconfigured, so the flag alone is not fail-closed.
 */
export function useFrontendCaptureGate(): void {
  const posthog = useAnalytics();
  const { user, isLoaded } = useUser();
  const captureFlag = useFeatureFlag(WEB_FRONTEND_CAPTURE_FLAG_KEY);

  const userId = user?.id;
  const staff = isStaffEmail(user?.primaryEmailAddress?.emailAddress);
  const enabled =
    isLoaded && !!userId && staff && captureFlag?.enabled === true;

  useEffect(() => {
    if (!(enabled && userId)) {
      return;
    }

    // PostHog: masked replay + dead-click autocapture for this staff session.
    // Guard SDK calls so a PostHog failure can't take down the authenticated
    // layout — mirroring the Datadog staff-capture helpers' fail-safe posture.
    try {
      posthog.startSessionRecording();
      posthog.set_config({ capture_dead_clicks: true });
    } catch {
      // Telemetry must never affect app behavior.
    }
    // Datadog RUM: forward actions, attach the user, force replay.
    enableDatadogRumStaffCapture(userId);

    return () => {
      try {
        posthog.stopSessionRecording();
        posthog.set_config({ capture_dead_clicks: false });
      } catch {
        // Telemetry must never affect app behavior.
      }
      disableDatadogRumStaffCapture();
    };
  }, [enabled, userId, posthog]);
}
