export const API_KEY_SCOPES = ["read", "write", "delete", "admin"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

// API key types for API contract
// These are explicitly defined to keep packages/api independent of database

export type ApiKey = {
  id: string;
  organizationId: string;
  userId: string;
  name: string;
  keyPrefix: string;
  expiresAt: Date | null;
  scopes: ApiKeyScope[];
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
};

export type CreateApiKeyInput = {
  name: string;
  expiresAt?: Date;
};

export type CreateApiKeyResponse = ApiKey & {
  plaintext: string;
};

export type VerifiedApiKeyContext = {
  userId: string;
  organizationId: string;
  scopes: ApiKeyScope[];
};

/**
 * Internal verification context that carries API-key provenance metadata.
 * Route contracts must not expose key material, signatures, or public keys to clients.
 */
export type VerifiedApiKeyContextWithMetadata = VerifiedApiKeyContext & {
  apiKeyId: string;
  source: "USER_CREATED" | "DESKTOP_MANAGED";
  gatewayId: string | null;
  boundPublicKey: string | null;
};
