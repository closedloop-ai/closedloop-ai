import type { VerifiedApiKeyContext } from "@repo/api/src/types/api-key";
import { ApiKeySource } from "@repo/database";

/**
 * Backend-only API key verification context that carries provenance metadata
 * needed by auth policy checks. This type must stay out of shared API contracts
 * because it includes internal database state and public-key binding metadata.
 */
export type VerifiedApiKeyContextWithMetadata = VerifiedApiKeyContext & {
  apiKeyId: string;
  source: ApiKeySource;
  gatewayId: string | null;
  boundPublicKey: string | null;
};

/**
 * A verified key eligible to prove device possession: a DESKTOP_MANAGED key that
 * carries both a server-stored bound public key and a gateway id.
 * `authenticateDesktopManagedPopRequest` requires exactly this, so the predicate
 * is the single source of truth for the eligibility shape.
 */
export type DesktopManagedPopEligibleContext =
  VerifiedApiKeyContextWithMetadata & {
    source: typeof ApiKeySource.DESKTOP_MANAGED;
    gatewayId: string;
    boundPublicKey: string;
  };

/**
 * Narrow a verified key context to a bound DESKTOP_MANAGED key. Returns `false`
 * for a USER_CREATED bearer key or a managed key missing its bound public key /
 * gateway — neither can bind a PoP-scoped session. Does NOT check API scopes;
 * callers that require a scope (e.g. `write`) assert it separately.
 */
export function isDesktopManagedPopEligible(
  context: VerifiedApiKeyContextWithMetadata
): context is DesktopManagedPopEligibleContext {
  return (
    context.source === ApiKeySource.DESKTOP_MANAGED &&
    Boolean(context.boundPublicKey) &&
    Boolean(context.gatewayId)
  );
}
