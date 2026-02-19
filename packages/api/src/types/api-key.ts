// API key types for API contract
// These are explicitly defined to keep packages/api independent of database

export type ApiKey = {
  id: string;
  organizationId: string;
  userId: string;
  name: string;
  keyPrefix: string;
  expiresAt: Date | null;
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
};
