/**
 * Scope resolution for the MCP server's API-key and OAuth 2.1 surfaces.
 *
 * Extracted from `index.ts` (ISS-4905) so the authorization default lives in one
 * small, directly testable module instead of being buried in the HTTP handlers.
 * The rule the module enforces is that a stored scope set that is empty, absent,
 * or entirely unrecognized is missing data, not a grant: it resolves to `null`
 * and the caller must refuse the credential. Nothing here ever widens privilege.
 */

import {
  API_KEY_SCOPES,
  type ApiKeyScope,
} from "@repo/api/src/types/api-key.js";
import {
  API_KEY_SCOPES_UNRESOLVABLE_EVENT,
  ApiKeyScopeResolutionStatus,
  resolveApiKeyScopes,
} from "@repo/api/src/utils/api-key-scope-resolution.js";
import { log } from "@repo/observability/log";
import type { VerifiedApiKeyContext } from "./api-key-contract.js";

const SCOPE_SPLIT_REGEX = /\s+/;

export const READ_SCOPE = "read" satisfies ApiKeyScope;
export const WRITE_SCOPE = "write" satisfies ApiKeyScope;
export const DELETE_SCOPE = "delete" satisfies ApiKeyScope;

/** Scope strings this server recognizes on an OAuth access-token payload. */
export const API_KEY_SCOPE_SET = new Set<string>(API_KEY_SCOPES);

/**
 * OAuth `error_description` used everywhere a credential is refused because its
 * stored scope set could not be resolved (ISS-4905). One constant so the OAuth
 * endpoints cannot drift apart on the same refusal.
 */
export const UNRESOLVABLE_KEY_SCOPES_DESCRIPTION =
  "API key has no resolvable scopes; the key must be reissued";

/**
 * OAuth `error_description` for a refresh grant whose scopes no longer overlap
 * the API key's — the key was narrowed after the token was issued, so a
 * rotation would carry nothing. The remedy is reauthorization, not a narrower
 * scope request, so it is worded separately from the over-scope refusal.
 */
export const NO_OVERLAP_REFRESH_GRANT_DESCRIPTION =
  "The refresh token grant no longer overlaps the API key scopes; reauthorize";

export function parseScopeParam(scopeParam?: string): string[] {
  if (!scopeParam?.trim()) {
    return [];
  }
  return scopeParam.trim().split(SCOPE_SPLIT_REGEX);
}

export function hasWriteScope(scopes: string[]): boolean {
  return scopes.includes(WRITE_SCOPE);
}

/**
 * Whether a self-issued OAuth access-token payload carries a usable `scopes`
 * claim: a non-empty array of scope strings this server recognizes.
 *
 * ISS-4905 — the length check is load-bearing. `.every()` is vacuously true on
 * an empty array, so without it a zero-scope payload would validate. No issuing
 * path can mint one today (`resolveGrantedScopes` never returns an empty
 * grant), but this validator must not depend on every caller upholding an
 * invariant it does not enforce itself.
 */
export function isValidTokenScopeClaim(scopes: unknown): scopes is string[] {
  return (
    Array.isArray(scopes) &&
    scopes.length > 0 &&
    scopes.every(
      (scope) => typeof scope === "string" && API_KEY_SCOPE_SET.has(scope)
    )
  );
}

/** Whether an already-granted scope set covers a tool's required scopes. */
export function hasRequiredScopes(
  grantedScopes: string[],
  requiredScopes: ApiKeyScope[]
): boolean {
  return requiredScopes.every((scope) => grantedScopes.includes(scope));
}

/**
 * Resolve the privilege set a verified API key actually carries.
 *
 * ISS-4905 — fail closed. This used to return the FULL scope set when the
 * stored array was empty, so the least-specified credential received the most
 * privilege. An empty, absent, or all-unrecognized scope array is missing or
 * indeterminate data, not a grant, so it now resolves to `null` and the caller
 * must reject the credential. The `null` return is deliberate: it makes every
 * call site handle the case at the type level instead of silently inheriting a
 * default. The unresolvable case is reported on the shared
 * `api_key_scopes_unresolvable` monitor so a corrupt credential row surfaces
 * rather than degrading quietly.
 */
export function effectiveKeyScopes(
  context: VerifiedApiKeyContext
): string[] | null {
  const resolution = resolveApiKeyScopes(context.scopes);
  if (resolution.status === ApiKeyScopeResolutionStatus.Unresolvable) {
    log.error(API_KEY_SCOPES_UNRESOLVABLE_EVENT, {
      surface: "mcp_oauth",
      reason: resolution.reason,
      rawScopeCount: resolution.rawScopeCount,
      userId: context.userId,
      organizationId: context.organizationId,
    });
    return null;
  }
  return resolution.scopes;
}

/**
 * Narrow an already-issued OAuth access-token grant to the scopes its API key
 * still carries, and refuse the request outright when nothing survives.
 *
 * ISS-4905 — the empty result is the whole point. A token minted while a key
 * held `write` keeps presenting `["write"]` after the key is narrowed to
 * `["read"]`; intersecting yields `[]`, and an empty array is truthy, so a bare
 * `if (!grantedScopes)` check would authenticate a request that holds no
 * privilege at all. The MCP server would then register every tool that carries
 * no explicit scope requirement, letting a stale token read through the
 * underlying key. Returning `null` here makes the caller answer 401 instead.
 */
export function narrowTokenGrantToKeyScopes(
  tokenScopes: string[],
  keyScopes: string[]
): string[] | null {
  const granted = tokenScopes.filter((scope) => keyScopes.includes(scope));
  return granted.length > 0 ? granted : null;
}

/**
 * OAuth 2.1: resolve the effective scope set by intersecting the requested
 * scopes with the scopes available on the API key.  Returns `null` when no
 * overlap exists (the caller should reject with `invalid_scope`).
 */
export function resolveGrantedScopes(
  requestedScopes: string[],
  keyScopes: string[]
): string[] | null {
  if (requestedScopes.length === 0) {
    return keyScopes;
  }
  const intersection = requestedScopes.filter((s) => keyScopes.includes(s));
  return intersection.length > 0 ? intersection : null;
}

export const RefreshScopeResolutionKind = {
  Ok: "ok",
  /** The key's own stored scope set could not be resolved (ISS-4905). */
  UnresolvableKey: "unresolvable_key",
  /** The request asked for more than the refresh grant covers. */
  OverScope: "over_scope",
  /**
   * The refresh token's own grant no longer overlaps the key's scopes, so a
   * rotation would carry nothing (ISS-4905).
   */
  NoOverlap: "no_overlap",
} as const;
export type RefreshScopeResolutionKind =
  (typeof RefreshScopeResolutionKind)[keyof typeof RefreshScopeResolutionKind];

export type RefreshScopeResolution =
  | { kind: typeof RefreshScopeResolutionKind.Ok; scopes: string[] }
  | { kind: typeof RefreshScopeResolutionKind.UnresolvableKey }
  | { kind: typeof RefreshScopeResolutionKind.OverScope }
  | { kind: typeof RefreshScopeResolutionKind.NoOverlap };

/**
 * Scopes a refresh-token rotation may grant.
 *
 * The refusal causes are kept distinct rather than collapsed into a bare
 * `null`: "your key has no resolvable scopes, reissue it", "this refresh token
 * no longer overlaps your key, reauthorize", and "you asked for more than this
 * refresh token covers" have different remedies, and telling a caller to narrow
 * their scope request when the real problem is a corrupt credential row sends
 * them down the wrong path.
 *
 * ISS-4905 — `NoOverlap` is load-bearing, not cosmetic. When the key is
 * narrowed after the refresh token was issued, `grantScopes` filters to `[]`;
 * with no request of its own, `scopes` is then `[]` and `.some()` is vacuously
 * false, so this returned `Ok` with an empty grant. The handler rotated the
 * family and answered 200 with an access token whose `scopes: []` claim
 * `isValidTokenScopeClaim` rejects on first use — a client that traded a
 * working refresh token for a dead access token.
 */
export function resolveRefreshGrantScopes(
  context: VerifiedApiKeyContext,
  refreshScopes: string[],
  requestedScope: string | undefined
): RefreshScopeResolution {
  const keyScopes = effectiveKeyScopes(context);
  if (!keyScopes) {
    return { kind: RefreshScopeResolutionKind.UnresolvableKey };
  }
  const grantScopes = refreshScopes.filter((scope) =>
    keyScopes.includes(scope)
  );
  if (grantScopes.length === 0) {
    return { kind: RefreshScopeResolutionKind.NoOverlap };
  }
  const requestedScopes = parseScopeParam(requestedScope);
  const scopes = requestedScopes.length > 0 ? requestedScopes : grantScopes;
  if (scopes.some((scope) => !grantScopes.includes(scope))) {
    return { kind: RefreshScopeResolutionKind.OverScope };
  }
  return { kind: RefreshScopeResolutionKind.Ok, scopes };
}

/**
 * The `invalid_scope` description matching a refresh-grant refusal cause, so the
 * caller answers each with the remedy that actually applies.
 */
export function refreshScopeRefusalDescription(
  kind: Exclude<
    RefreshScopeResolutionKind,
    typeof RefreshScopeResolutionKind.Ok
  >
): string {
  if (kind === RefreshScopeResolutionKind.UnresolvableKey) {
    return UNRESOLVABLE_KEY_SCOPES_DESCRIPTION;
  }
  if (kind === RefreshScopeResolutionKind.NoOverlap) {
    return NO_OVERLAP_REFRESH_GRANT_DESCRIPTION;
  }
  return "Requested scope exceeds the refresh token grant";
}
/**
 * Fail-closed scope resolution for the local-DB verification fallback.
 *
 * Resolves the RAW stored column before any sanitization so the monitor sees
 * the real reason and raw entry count: sanitizing first would collapse a null
 * column and an all-unrecognized set into a bare "empty" with rawScopeCount 0,
 * losing exactly the diagnostic that tells an operator whether a row is missing
 * data or a version-skew artifact (ISS-4905). Reported with the record identity
 * the anonymous resolver cannot see.
 */
export function resolveLocalKeyScopes(record: {
  id: string;
  userId: string;
  organizationId: string;
  scopes: unknown;
}): ApiKeyScope[] | null {
  const resolution = resolveApiKeyScopes(record.scopes);
  if (resolution.status === ApiKeyScopeResolutionStatus.Unresolvable) {
    log.error(API_KEY_SCOPES_UNRESOLVABLE_EVENT, {
      surface: "mcp_local_key_verification",
      reason: resolution.reason,
      rawScopeCount: resolution.rawScopeCount,
      apiKeyId: record.id,
      userId: record.userId,
      organizationId: record.organizationId,
    });
    return null;
  }
  return resolution.scopes;
}

/**
 * The scopes a tool registration requires when it does not name its own.
 *
 * ISS-4905 — default DENY. Most read tools carried no `requiredScopes` at all,
 * so registration depended entirely on the grant never being empty. That is an
 * invariant enforced somewhere else; this default makes the requirement local to
 * the registration loop, so a tool added tomorrow without a scope annotation is
 * gated rather than silently public.
 */
export const DEFAULT_TOOL_REQUIRED_SCOPES: ApiKeyScope[] = [READ_SCOPE];

/**
 * Scopes a grant must carry before a tool is registered on the session's server.
 *
 * An explicit `requiredScopes` — including an explicit empty array, for a tool
 * that touches no platform data — always wins. A write tool is gated by the
 * separate write check its registration already declares, so it is not also
 * forced to hold `read`. Everything else falls back to the read default above.
 */
export function toolRequiredScopes(registration: {
  requiredScopes?: ApiKeyScope[];
  requiresWrite?: boolean;
}): ApiKeyScope[] {
  if (registration.requiredScopes) {
    return registration.requiredScopes;
  }
  if (registration.requiresWrite) {
    return [WRITE_SCOPE];
  }
  return DEFAULT_TOOL_REQUIRED_SCOPES;
}

/**
 * Re-derive the grant for a session restored from the shared auth cache.
 *
 * ISS-4905 — the cache survives a deploy, so it can outlive the fail-open
 * default this change removed. During a split deploy an old instance writes an
 * entry whose `context.scopes` is empty but whose `grantedScopes` is the full
 * set it inferred from that emptiness, and every subsequent request refreshes
 * the entry's TTL — so deployment order alone could keep a fail-open grant
 * alive indefinitely. Running the resolver again over the cached context, and
 * narrowing the cached grant to what it yields, means a restored session can
 * never hold more privilege than a freshly authenticated one. `null` means the
 * caller must evict the entry and fall back to full verification.
 */
export function revalidateCachedGrant(
  context: VerifiedApiKeyContext,
  cachedGrantedScopes: string[]
): string[] | null {
  const keyScopes = effectiveKeyScopes(context);
  if (!keyScopes) {
    return null;
  }
  return narrowTokenGrantToKeyScopes(cachedGrantedScopes, keyScopes);
}
