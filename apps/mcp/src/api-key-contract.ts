import type { ApiKeyScope } from "@repo/api/src/types/api-key.js";

/**
 * The MCP-local shape of a verified API key.
 *
 * The scope vocabulary itself is deliberately NOT redeclared here. It is owned
 * by `@repo/api/src/types/api-key`, which this app's runtime image already
 * carries (`apps/mcp/Dockerfile` copies `packages/api/src/` into both the
 * builder and the runtime stage, and MCP already deep-imports other
 * `@repo/api/src/...` modules). A second copy could drift from what the API
 * accepts while still satisfying that module's own completeness guard, leaving
 * MCP to advertise a `scopes_supported` list, or accept a sanitized scope set,
 * that the API does not agree with.
 */
export type VerifiedApiKeyContext = {
  userId: string;
  organizationId: string;
  scopes: ApiKeyScope[];
};

/**
 * Why the internal verification endpoint accepted or refused a key.
 *
 * ISS-4905 - `UnresolvableScopes` exists because the two refusals have
 * different remedies. A key the API refuses because its stored scope set is
 * empty, absent, or all-unrecognized needs reissuing; treating it as a plain
 * invalid credential makes this server answer `invalid_client` and revoke the
 * caller's whole refresh-token family, neither of which fixes the row.
 *
 * It lives here rather than in `api-client.ts` because it is contract, not
 * transport: `api-client.ts` reads required env at module load, so a consumer
 * mocking the client would otherwise have to restate these values.
 */
export const ApiKeyVerificationStatus = {
  Ok: "ok",
  Invalid: "invalid",
  UnresolvableScopes: "unresolvable_scopes",
} as const;
export type ApiKeyVerificationStatus =
  (typeof ApiKeyVerificationStatus)[keyof typeof ApiKeyVerificationStatus];

export type ApiKeyVerification =
  | {
      status: typeof ApiKeyVerificationStatus.Ok;
      context: VerifiedApiKeyContext;
    }
  | { status: typeof ApiKeyVerificationStatus.Invalid }
  | { status: typeof ApiKeyVerificationStatus.UnresolvableScopes };
