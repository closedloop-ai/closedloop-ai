"use client";

import {
  postHogFeatureFlagsEnabled,
  useAnalytics,
} from "@repo/analytics/client";
import {
  startWebSessionReplay,
  stopWebSessionReplay,
} from "@repo/analytics/session-replay";
import { isStaffEmail } from "@repo/api/src/types/staff-email";
import { WEB_FRONTEND_CAPTURE_FLAG_KEY } from "@repo/api/src/types/web-frontend-capture-flag";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useUser } from "@repo/auth/client";
import { useEffect } from "react";
import { useFeatureFlagsSettledForUser } from "@/components/feature-flags-settled";
import {
  disableDatadogRumStaffCapture,
  enableDatadogRumStaffCapture,
} from "@/lib/datadog-rum/staff-capture";

/**
 * Flag-gated frontend capture (FEA-2400, ISS-10650).
 *
 * When the `web-frontend-capture` flag is enabled for an identified product-app
 * user, start masked PostHog session replay + dead-click autocapture through
 * the package-owned `startWebSessionReplay`. Datadog
 * RUM interaction capture remains staff-only; Datadog replay is off
 * (ISS-12356(f)). When the flag flips off,
 * the user signs out, or the component unmounts, all added capture is stopped.
 *
 * PostHog recording is fail-closed when the SDK is unconfigured. This prevents
 * the explicit local/QA feature-flag fallback from starting a replay without a
 * real PostHog client while allowing PostHog targeting to be the only rollout
 * policy for signed-in customer sessions.
 */
export function useFrontendCaptureGate(): void {
  const posthog = useAnalytics();
  const { user, isLoaded } = useUser();
  const captureFlagEnabled = useFeatureFlagEnabled(
    WEB_FRONTEND_CAPTURE_FLAG_KEY
  );
  const flagsSettledForUser = useFeatureFlagsSettledForUser();

  const userId = user?.id;
  const staff = isStaffEmail(user?.primaryEmailAddress?.emailAddress);
  const enabled =
    postHogFeatureFlagsEnabled &&
    isLoaded &&
    flagsSettledForUser &&
    !!userId &&
    captureFlagEnabled;

  useEffect(() => {
    if (!(enabled && userId)) {
      return;
    }

    startWebSessionReplay(posthog);
    // Datadog's separate enhanced-capture path remains staff-scoped.
    if (staff) {
      enableDatadogRumStaffCapture(userId);
    }

    return () => {
      stopWebSessionReplay(posthog);
      if (staff) {
        disableDatadogRumStaffCapture();
      }
    };
  }, [enabled, userId, staff, posthog]);
}
