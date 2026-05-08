import type { VerifiedApiKeyContext } from "@repo/api/src/types/api-key";
import type { ApiKeySource } from "@repo/database";

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
