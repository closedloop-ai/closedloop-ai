import type { VerifiedApiKeyContextWithMetadata } from "./api-key-context";

/**
 * Why a key verification succeeded or was refused (ISS-4905).
 *
 * `Invalid` and `UnresolvableScopes` are kept apart because their remedies
 * differ: one means the presented credential is wrong, the other means the
 * stored row is and the key must be reissued. Collapsing them made the MCP
 * server answer a corrupt row with a generic `invalid_client` and revoke the
 * caller's whole refresh-token family.
 *
 * These live outside `app/api-keys/service.ts` deliberately: consumers that
 * mock the service still need the real discriminant values, and a mock factory
 * that has to restate them is a mock that can drift from the contract.
 */
export const ApiKeyVerificationStatus = {
  Ok: "ok",
  Invalid: "invalid",
  UnresolvableScopes: "unresolvable_scopes",
} as const;
export type ApiKeyVerificationStatus =
  (typeof ApiKeyVerificationStatus)[keyof typeof ApiKeyVerificationStatus];

export type ApiKeyVerificationOutcome =
  | {
      status: typeof ApiKeyVerificationStatus.Ok;
      context: VerifiedApiKeyContextWithMetadata;
    }
  | { status: typeof ApiKeyVerificationStatus.Invalid }
  | { status: typeof ApiKeyVerificationStatus.UnresolvableScopes };
