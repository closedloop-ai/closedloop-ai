import "server-only";

import { GITHUB_PROJECTION_READS_FEATURE_FLAG_KEY } from "@repo/api/src/types/github";
import {
  type FeatureFlagIdentity,
  isFeatureFlagEnabledForAnyIdentity,
} from "@/lib/feature-flag-identity";

export type GithubProjectionReadsFeatureIdentity = FeatureFlagIdentity;

/**
 * PLN-1535 M3.1: evaluate the projection-reads rollout for a request principal.
 * Only an explicit true from the exact PostHog key routes the repository branch/
 * PR read to the Postgres projection; unavailable, false, null, or a thrown
 * evaluation all fail closed to the live GitHub GraphQL path, so the cutover
 * stays off until deliberately enabled for an org.
 */
export function isGithubProjectionReadsEnabled(
  identity: GithubProjectionReadsFeatureIdentity
): Promise<boolean> {
  return isFeatureFlagEnabledForAnyIdentity(
    GITHUB_PROJECTION_READS_FEATURE_FLAG_KEY,
    identity,
    "github_projection_reads_feature_flag_unavailable"
  );
}
