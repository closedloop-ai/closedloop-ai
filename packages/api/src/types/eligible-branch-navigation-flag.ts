/**
 * Shared closed-by-default rollout key for eligible Branch navigation.
 *
 * Web resolves this key through PostHog. Desktop registers the same literal in
 * its feature-flag store so a shared consumer cannot fall through to a
 * development default while the web surface remains dark.
 */
export const ELIGIBLE_BRANCH_NAVIGATION_FLAG_KEY =
  "eligible-branch-navigation" as const;
