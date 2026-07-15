import "server-only";

import { PUBLIC_GITHUB_REPOS_FEATURE_FLAG_KEY } from "@repo/api/src/types/github";
import {
  type FeatureFlagIdentity,
  isFeatureFlagEnabledForAnyIdentity,
} from "@/lib/feature-flag-identity";

export type PublicGithubReposFeatureIdentity = FeatureFlagIdentity;

/**
 * Evaluates the public-GitHub-repositories rollout for a request principal. Only
 * an explicit true from the exact PostHog key admits the mutation or merge;
 * unavailable, false, null, or thrown flag evaluation all fail closed so the
 * dark-launched feature stays unreachable outside the flag.
 */
export function isPublicGithubReposEnabled(
  identity: PublicGithubReposFeatureIdentity
): Promise<boolean> {
  return isFeatureFlagEnabledForAnyIdentity(
    PUBLIC_GITHUB_REPOS_FEATURE_FLAG_KEY,
    identity,
    "public_github_repos_feature_flag_unavailable"
  );
}
