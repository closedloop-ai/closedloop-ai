import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import { HARNESS_SELECTION_FEATURE_FLAG_KEY } from "@repo/api/src/types/compute-target";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";

export type HarnessSelectionIdentity = {
  userId: string;
  clerkUserId?: string | null;
};

function resolveDistinctIds({
  clerkUserId,
  userId,
}: HarnessSelectionIdentity): string[] {
  return [
    ...new Set(
      [clerkUserId, userId].filter((value): value is string => Boolean(value))
    ),
  ];
}

/**
 * Evaluates the harness-selection rollout for server-side admission at the
 * loop-launch consumer boundary. The client UI is gated by the same flag, but
 * the persisted `selectedHarness` on a ComputeTarget row outlives a flag-off
 * rollback, so the launch path must re-check the flag before honoring it.
 *
 * Missing PostHog configuration, false, null, or thrown evaluation all fail
 * closed by returning false — a disabled or unavailable flag must never let a
 * previously-persisted non-default harness keep launching.
 */
export async function isHarnessSelectionEnabled(
  identity: HarnessSelectionIdentity
): Promise<boolean> {
  try {
    for (const distinctId of resolveDistinctIds(identity)) {
      if (
        (await isFeatureFlagEnabledForDistinctId(
          HARNESS_SELECTION_FEATURE_FLAG_KEY,
          distinctId
        )) === true
      ) {
        return true;
      }
    }
    return false;
  } catch (error) {
    log.warn("harness_selection_feature_flag_unavailable", {
      error: parseError(error),
    });
    return false;
  }
}
