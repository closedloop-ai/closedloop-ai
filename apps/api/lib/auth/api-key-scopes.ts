import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  API_KEY_SCOPES_UNRESOLVABLE_EVENT,
  ApiKeyScopeResolutionStatus,
  apiKeyScopesInclude,
  resolveApiKeyScopes,
} from "@repo/api/src/utils/api-key-scope-resolution";
import { log } from "@repo/observability/log";
import type { AuthContext } from "./with-auth";

/**
 * Scope evaluation:
 * - Session auth has full access.
 * - API-key scopes are explicitly provided by verifyKey().
 * - An empty, absent, or all-unrecognized API-key scope set is missing data,
 *   not a grant: it fails closed and is reported on the shared
 *   `api_key_scopes_unresolvable` monitor (ISS-4905). It must never fall back
 *   to full access.
 */
export function hasApiKeyScopes(
  context: AuthContext,
  required: ApiKeyScope[]
): boolean {
  if (context.authMethod !== "api_key") {
    return true;
  }

  return apiKeyScopesAllow(context.apiKeyScopes, required, "with_api_key_auth");
}

/**
 * Fail-closed scope check for callers that hold a raw scope list rather than a
 * full `AuthContext` (for example the branch-view comment permission table).
 * Shares one authorization default with `hasApiKeyScopes` so a second resolver
 * cannot drift back to fail-open.
 */
export function apiKeyScopesAllow(
  scopes: ApiKeyScope[] | undefined,
  required: ApiKeyScope[],
  surface: string
): boolean {
  const resolution = resolveApiKeyScopes(scopes);
  if (resolution.status === ApiKeyScopeResolutionStatus.Unresolvable) {
    log.error(API_KEY_SCOPES_UNRESOLVABLE_EVENT, {
      surface,
      reason: resolution.reason,
      rawScopeCount: resolution.rawScopeCount,
      requiredScopes: required,
    });
    return false;
  }

  return apiKeyScopesInclude(resolution.scopes, required);
}
