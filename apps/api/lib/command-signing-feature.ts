import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  type FeatureFlagIdentity,
  resolveDistinctIdsForIdentity,
} from "@/lib/feature-flag-identity";
import { evaluateServerFeatureFlagForDistinctId } from "@/lib/feature-flags/server-feature-flag-evaluation";
import { COMPUTE_TARGET_SIGNING_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";

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
        (await evaluateServerFeatureFlagForDistinctId(
          COMPUTE_TARGET_SIGNING_SERVER_FLAG,
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
