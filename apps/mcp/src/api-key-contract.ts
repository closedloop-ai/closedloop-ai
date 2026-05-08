export const API_KEY_SCOPES = ["read", "write", "delete", "admin"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type VerifiedApiKeyContext = {
  userId: string;
  organizationId: string;
  scopes: ApiKeyScope[];
};
