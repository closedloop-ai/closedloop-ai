export const API_KEY_SCOPES = ["read", "write", "delete", "admin"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Desktop proof-of-possession header names shared by Electron, relay, and API
 * callers that forward or verify desktop-managed API key requests.
 */
export const DESKTOP_POP_GATEWAY_ID_HEADER = "X-Desktop-Gateway-Id";
export const DESKTOP_POP_TIMESTAMP_HEADER = "X-Desktop-Timestamp";
export const DESKTOP_POP_SIGNATURE_HEADER = "X-Desktop-Signature";
export const DESKTOP_POP_HEADER_NAMES = [
  DESKTOP_POP_GATEWAY_ID_HEADER,
  DESKTOP_POP_TIMESTAMP_HEADER,
  DESKTOP_POP_SIGNATURE_HEADER,
] as const;
export type DesktopPopHeaderName = (typeof DESKTOP_POP_HEADER_NAMES)[number];

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
