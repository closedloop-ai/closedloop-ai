"use client";

import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useMemo } from "react";
import type { DashboardRowGates } from "./dashboard-tiles";

/**
 * ISS-5061 — resolve the closed-by-default row gates for the overview dashboard.
 *
 * ONE hook read by both shells (the web `InsightsOverviewDashboard` and the
 * desktop first-launch dashboard) so a row can never be gated off on one surface
 * and drawn on the other. Resolution goes through the injected feature-flag port:
 * PostHog on web, the desktop shell's Labs-backed adapter in the renderer.
 *
 * Uses the OPTIONAL adapter deliberately: the shared overview also mounts in
 * Storybook and in tests that do not wrap a `FeatureFlagAdapterProvider`, where
 * an absent provider must resolve CLOSED (the default posture) rather than throw.
 */
export function useDashboardRowGates(): DashboardRowGates {
  const agentCollaborationNetwork = useFeatureFlagEnabledOptional(
    AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY
  );
  return useMemo(
    () => ({ agentCollaborationNetwork }),
    [agentCollaborationNetwork]
  );
}
