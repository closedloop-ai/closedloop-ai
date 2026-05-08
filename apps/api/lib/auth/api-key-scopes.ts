import { API_KEY_SCOPES, type ApiKeyScope } from "@repo/api/src/types/api-key";
import type { AuthContext } from "./with-auth";

/**
 * Scope evaluation:
 * - Session auth has full access.
 * - API-key scopes are explicitly provided by verifyKey().
 */
export function hasApiKeyScopes(
  context: AuthContext,
  required: ApiKeyScope[]
): boolean {
  if (context.authMethod !== "api_key") {
    return true;
  }

  const scopes = context.apiKeyScopes ?? [...API_KEY_SCOPES];

  return required.every((scope) => scopes.includes(scope));
}
