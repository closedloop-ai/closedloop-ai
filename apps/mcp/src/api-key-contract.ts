export const API_KEY_SCOPES = ["read", "write", "delete", "admin"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type VerifiedApiKeyContext = {
  userId: string;
  organizationId: string;
  scopes: ApiKeyScope[];
  // Clerk user id returned by the verify endpoint. PostHog identifies users by
  // their Clerk id, so feature-flag evaluation must prefer this over the
  // internal DB `userId`. Optional/nullable because fallback verification paths
  // (local DB verify, OAuth token decode) don't resolve it.
  clerkUserId?: string | null;
};
