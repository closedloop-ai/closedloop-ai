import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import type { AuthContext } from "./with-auth";

const FULL_SCOPES: ApiKeyScope[] = ["read", "write", "delete", "admin"];

/**
 * Backward-compatible scope evaluation:
 * - Session auth has full access.
 * - Legacy keys with empty scopes are treated as full-access.
 */
export function hasApiKeyScopes(
  context: AuthContext,
  required: ApiKeyScope[]
): boolean {
  if (context.authMethod !== "api_key") {
    return true;
  }

  const scopes =
    context.apiKeyScopes && context.apiKeyScopes.length > 0
      ? context.apiKeyScopes
      : FULL_SCOPES;

  return required.every((scope) => scopes.includes(scope));
}
