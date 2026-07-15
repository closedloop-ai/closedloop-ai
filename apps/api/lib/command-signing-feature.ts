import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import { COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY } from "@repo/api/src/types/compute-target";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  type FeatureFlagIdentity,
  resolveDistinctIdsForIdentity,
} from "@/lib/feature-flag-identity";

export type ComputeTargetSigningIdentity = FeatureFlagIdentity;

// NB: unlike the boolean fail-closed helpers, this check surfaces a third
// `unknown` state so signing callers can distinguish a provider outage from a
// disabled flag — so it shares only the distinct-id resolution, not the loop.
export type ComputeTargetSigningFeatureSupportResult =
  | { status: "supported" }
  | { status: "unsupported" }
  | { status: "unknown"; error: unknown };

/**
 * Server-side rollout check that preserves feature-provider failures for
 * callers whose mutation gates must fail closed instead of downgrading to
 * unsigned command dispatch.
 */
export async function getComputeTargetSigningFeatureSupport(
  identity: ComputeTargetSigningIdentity
): Promise<ComputeTargetSigningFeatureSupportResult> {
  try {
    for (const distinctId of resolveDistinctIdsForIdentity(identity)) {
      if (
        (await isFeatureFlagEnabledForDistinctId(
          COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY,
          distinctId
        )) === true
      ) {
        return { status: "supported" };
      }
    }
    return { status: "unsupported" };
  } catch (error) {
    log.warn("compute_target_signing_feature_flag_unavailable", {
      error: parseError(error),
    });
    return { status: "unknown", error };
  }
}
