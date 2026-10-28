import "server-only";

import {
  type FeatureFlagIdentity,
  isFeatureFlagEnabledForAnyIdentity,
} from "@/lib/feature-flag-identity";
import { PENSERO_INTEGRATION_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";

/**
 * The server half of the Pensero rollout gate (ISS-8007, #6030 davetho).
 *
 * The card is hidden behind `pensero-integration` on the client, but the route
 * is a separate reachable entry point: any org admin could `PUT
 * /settings/pensero` directly while the rollout was off and leave a stored
 * credential nobody's screen shows. Today that row is inert — nothing reads it
 * — but `resolvePenseroCredential` makes an org row WIN over the deployment-wide
 * env token, so the moment layer 3 wires the read in, a row written outside the
 * rollout silently takes over that org's attribution. Closed-by-default has to
 * mean the mutation too, not just the button.
 *
 * Same PostHog key and same distinct-id namespace the card's `useFeatureFlag`
 * reads, so the two halves cannot disagree about who is in the rollout.
 *
 * FAIL CLOSED, which `isFeatureFlagEnabledForAnyIdentity` already guarantees:
 * only an explicit `true` admits the write, and unavailable / false / null / a
 * thrown evaluation all resolve to false. A PostHog outage therefore refuses the
 * write rather than opening it.
 *
 * This is a ROLLOUT control, never an authorization boundary. The admin gate
 * (`getOrgAdminStatus` → 403 for a denial, 503 `role_unresolved` when the role
 * could not be read at all) is unchanged and runs first; removing this flag at
 * GA must not change who may write.
 */
export function isPenseroIntegrationRolloutEnabled(
  identity: FeatureFlagIdentity
): Promise<boolean> {
  return isFeatureFlagEnabledForAnyIdentity(
    PENSERO_INTEGRATION_SERVER_FLAG,
    identity,
    "pensero_integration_feature_flag_unavailable"
  );
}
