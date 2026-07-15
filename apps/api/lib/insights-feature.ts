import "server-only";

import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import {
  type FeatureFlagIdentity,
  isFeatureFlagEnabledForAnyIdentity,
} from "@/lib/feature-flag-identity";

export type InsightsFeatureIdentity = FeatureFlagIdentity;

/**
 * PostHog flag keys that admit access to the `/insights/*` API routes. Two
 * distinct client surfaces legitimately consume these routes:
 *
 * - the dark-launched standalone Insights page, gated behind `insights`; and
 * - the org Dashboard (`apps/app/.../dashboard/page.tsx`), gated behind
 *   `desktop-agent-session-sync`, whose `WebInsightsDataSourceProvider` fetches
 *   the same `/insights/*` metrics.
 *
 * Gating the routes on the Insights flag alone would 403 every dashboard metric
 * fetch for users who have the sync flag but not the (separate) Insights flag,
 * leaving the dashboard shell rendered but empty. Admitting either flag keeps
 * both surfaces working while the routes stay unreachable outside both.
 */
const INSIGHTS_ROUTE_FLAG_KEYS = [
  INSIGHTS_FEATURE_FLAG_KEY,
  DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY,
] as const;

/**
 * Evaluates whether a request principal may reach the `/insights/*` API routes.
 * The routes back both the dark-launched Insights page (`insights` flag) and
 * the org Dashboard (`desktop-agent-session-sync` flag), so access is admitted
 * when an explicit true comes back from either flag. Unavailable, false, null,
 * or thrown flag evaluation all fail closed, keeping the routes unreachable when
 * neither surface is enabled.
 */
export async function isInsightsEnabledForUser(
  identity: InsightsFeatureIdentity
): Promise<boolean> {
  for (const flagKey of INSIGHTS_ROUTE_FLAG_KEYS) {
    if (
      await isFeatureFlagEnabledForAnyIdentity(
        flagKey,
        identity,
        "insights_feature_flag_unavailable"
      )
    ) {
      return true;
    }
  }
  return false;
}
