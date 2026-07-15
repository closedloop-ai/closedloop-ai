import { HARNESS_SELECTION_FEATURE_FLAG_KEY } from "@repo/api/src/types/compute-target";
import {
  type FeatureFlagIdentity,
  isFeatureFlagEnabledForAnyIdentity,
} from "@/lib/feature-flag-identity";

export type HarnessSelectionIdentity = FeatureFlagIdentity;

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
export function isHarnessSelectionEnabled(
  identity: HarnessSelectionIdentity
): Promise<boolean> {
  return isFeatureFlagEnabledForAnyIdentity(
    HARNESS_SELECTION_FEATURE_FLAG_KEY,
    identity,
    "harness_selection_feature_flag_unavailable"
  );
}
