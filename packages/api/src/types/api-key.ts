/**
 * The capability scopes an API key can carry, ordered least- to
 * most-privileged. This const object is the single source of truth for the
 * scope vocabulary; consumers compare against these members rather than
 * repeating bare string literals.
 */
export const ApiKeyScope = {
  /** Read platform data. */
  Read: "read",
  /** Create and update platform data. */
  Write: "write",
  /** Delete platform data. */
  Delete: "delete",
  /** Administer the organization. Not issued by any current key-creation path. */
  Admin: "admin",
} as const;
export type ApiKeyScope = (typeof ApiKeyScope)[keyof typeof ApiKeyScope];

/**
 * Every scope, least- to most-privileged. Order is part of the contract: it is
 * served verbatim as the OAuth `scopes_supported` list.
 */
export const API_KEY_SCOPES = [
  ApiKeyScope.Read,
  ApiKeyScope.Write,
  ApiKeyScope.Delete,
  ApiKeyScope.Admin,
] as const satisfies readonly ApiKeyScope[];

/** Resolves only when `T` is `never`; anything else is a typecheck error. */
type AssertNever<T extends never> = T;

/**
 * Compile-time completeness guard for `API_KEY_SCOPES`. The `satisfies` clause
 * above only checks that every listed entry IS a scope, not that every scope is
 * listed, so a member added to `ApiKeyScope` and forgotten here would otherwise
 * compile clean and then be silently stripped by the API's scope sanitizer,
 * dropped from the full-access fallback, and rendered as an unknown ceiling by
 * the settings badge. This alias fails `tsc` instead.
 */
type _EveryApiKeyScopeIsListed = AssertNever<
  Exclude<ApiKeyScope, (typeof API_KEY_SCOPES)[number]>
>;

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
