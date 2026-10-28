import type { AuthContext } from "@/lib/auth/with-auth";
import { isFeatureFlagEnabledForAnyIdentity } from "@/lib/feature-flag-identity";
import { MANUAL_ARTIFACT_ORDERING_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";

const FLAG_UNAVAILABLE_LOG_KEY =
  "manual_artifact_ordering_feature_flag_unavailable";

/** Fail closed unless the authenticated viewer is explicitly in the rollout. */
export function isManualArtifactOrderingEnabled(
  auth: AuthContext
): Promise<boolean> {
  return isFeatureFlagEnabledForAnyIdentity(
    MANUAL_ARTIFACT_ORDERING_SERVER_FLAG,
    { userId: auth.user.id, clerkUserId: auth.clerkUserId },
    FLAG_UNAVAILABLE_LOG_KEY
  );
}

/** Execute placement only for viewers admitted to manual artifact ordering. */
export async function withProjectArtifactPlacementGate<T>(
  auth: AuthContext,
  onEnabled: () => Promise<T> | T,
  onDisabled: () => Promise<T> | T
): Promise<T> {
  if (await isManualArtifactOrderingEnabled(auth)) {
    return onEnabled();
  }
  return onDisabled();
}
