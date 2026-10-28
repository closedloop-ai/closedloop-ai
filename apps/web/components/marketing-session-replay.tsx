"use client";

import {
  postHogFeatureFlagsEnabled,
  useAnalytics,
  useFeatureFlagFreshValue,
} from "@repo/analytics/client";
import {
  startWebSessionReplay,
  stopWebSessionReplay,
} from "@repo/analytics/session-replay";
import { WEB_FRONTEND_CAPTURE_FLAG_KEY } from "@repo/api/src/types/web-frontend-capture-flag";
import { useEffect } from "react";

/**
 * Marketing-site PostHog session replay (ISS-12558, PRD-790 requirement 3).
 *
 * PRD-790 Q-003 extends the existing web-app replay policy to marketing rather
 * than designing a new one, and Q-002 gives marketing the same settings as
 * web-app production replay. So this reads the SAME `web-frontend-capture` key
 * and starts replay through the SAME package-owned start/stop pair; sample
 * rate, minimum duration, retention and volume are project settings shared by
 * both surfaces, and masking/redaction come from the shared `AnalyticsProvider`.
 *
 * No sign-in is required: PostHog's answer for the visitor's current distinct
 * id is the eligibility decision. The flag is read with
 * `useFeatureFlagFreshValue`, so only a `/flags` answer this page load received
 * can start a replay — never a value persisted on an earlier visit, nor the QA
 * fail-open, E2E fixture or Dev Mode override `useFeatureFlag` layers on top.
 * This is stricter than the web-app gate, which reads `useFeatureFlag` and so
 * honours a Dev Mode override once flags settle for the identified user. An
 * unconfigured PostHog fails closed. Renders nothing; mounted once inside
 * `AnalyticsProvider`.
 */
export function MarketingSessionReplay() {
  const posthog = useAnalytics();
  const captureFlagEnabled =
    useFeatureFlagFreshValue(WEB_FRONTEND_CAPTURE_FLAG_KEY) === true;
  const enabled = postHogFeatureFlagsEnabled && captureFlagEnabled;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    startWebSessionReplay(posthog);
    return () => {
      stopWebSessionReplay(posthog);
    };
  }, [enabled, posthog]);

  return null;
}
