import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import { COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY } from "@repo/api/src/types/compute-target";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";

export type ComputeTargetSigningIdentity = {
  userId: string;
  clerkUserId?: string | null;
};

function resolveDistinctIds(identity: ComputeTargetSigningIdentity): string[] {
  return [
    ...new Set(
      [identity.clerkUserId, identity.userId].filter((value): value is string =>
        Boolean(value)
      )
    ),
  ];
}

/**
 * Server-side rollout check for browser command signing. Only an explicit true
 * enables server support; missing PostHog configuration, false, null, or
 * thrown flag evaluation all keep legacy unsigned command behavior.
 */
export async function isComputeTargetSigningSupportedForUser(
  identity: ComputeTargetSigningIdentity
): Promise<boolean> {
  try {
    for (const distinctId of resolveDistinctIds(identity)) {
      if (
        (await isFeatureFlagEnabledForDistinctId(
          COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY,
          distinctId
        )) === true
      ) {
        return true;
      }
    }
    return false;
  } catch (error) {
    log.warn("compute_target_signing_feature_flag_unavailable", {
      error: parseError(error),
    });
    return false;
  }
}
