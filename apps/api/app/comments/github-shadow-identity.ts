/** Clerk ID namespace reserved for inactive GitHub identity placeholders. */
export const GITHUB_SHADOW_CLERK_PREFIX = "github-shadow:" as const;

/** Source-object fallback namespace; these IDs identify comments, not GitHub people. */
export const GITHUB_GHOST_AUTHOR_PREFIX = "ghost:" as const;

/** Stable Clerk ID namespace for GitHub identities without a verified user. */
export function githubShadowClerkId(
  organizationId: string,
  providerUserId: string
): string {
  return `${GITHUB_SHADOW_CLERK_PREFIX}${organizationId}:${providerUserId}`;
}

/** Shadow users are not independent human actors in native evidence. */
export function isGitHubShadowClerkId(clerkId: string): boolean {
  return clerkId.startsWith(GITHUB_SHADOW_CLERK_PREFIX);
}
