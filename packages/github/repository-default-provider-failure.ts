import { GitHubFetchCredentialType } from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  type RepositoryDefaultEvidence,
  type RepositoryDefaultProvenance,
  RepositoryDefaultReason,
  type RepositoryDefaultUnavailableObservation,
  repositoryDefaultUnavailableObservationValidator,
} from "@repo/api/src/types/repository-default-identity";
import {
  GitHubProviderResultStatus,
  type GitHubUserTokenProviderResult,
  GitHubUserTokenProviderResultStatus,
} from "./provider-result";

/** Producer reasons allowed at a live GitHub acquisition boundary. */
export type GitHubRepositoryDefaultProducerFailureReason = Exclude<
  RepositoryDefaultReason,
  | typeof RepositoryDefaultReason.LegacyRecord
  | typeof RepositoryDefaultReason.Unknown
>;

/** Typed provider failure plus retry metadata kept outside persisted evidence. */
export type GitHubRepositoryDefaultProviderFailure = {
  observation: RepositoryDefaultUnavailableObservation;
  retryAfterSeconds?: number | null;
};

/**
 * Map an existing GitHub errors-as-values result into repository-default
 * evidence without issuing another request or changing credential selection.
 */
export function mapGitHubProviderResultToRepositoryDefaultFailure<T>(
  result: GitHubUserTokenProviderResult<T>,
  provenance: RepositoryDefaultProvenance
): GitHubRepositoryDefaultProviderFailure | undefined {
  switch (result.status) {
    case GitHubProviderResultStatus.Success:
      return undefined;
    case GitHubProviderResultStatus.ProviderRateLimit:
      return {
        observation: createGitHubRepositoryDefaultUnavailableObservation(
          RepositoryDefaultReason.RateLimited,
          provenance
        ),
        retryAfterSeconds: result.retryAfterSeconds,
      };
    case GitHubUserTokenProviderResultStatus.CredentialInsufficientScope:
      return {
        observation: createGitHubRepositoryDefaultUnavailableObservation(
          resolveInsufficientScopeReason(provenance),
          provenance
        ),
      };
    case GitHubUserTokenProviderResultStatus.CredentialUnauthorized:
      return {
        observation: createGitHubRepositoryDefaultUnavailableObservation(
          RepositoryDefaultReason.PermissionDenied,
          provenance
        ),
      };
    case GitHubProviderResultStatus.ProviderPermissionFiltered:
      return {
        observation: createGitHubRepositoryDefaultUnavailableObservation(
          RepositoryDefaultReason.PermissionFiltered,
          provenance
        ),
      };
    // ISS-5093: a repo the credential cannot reach yields no repository-default
    // evidence, exactly as a provider outage does. Repository-default identity
    // has no vocabulary for "unreachable" and does not need one — this keeps
    // the 404 mapping byte-identical to what it produced before the status was
    // split out of ProviderUnavailable.
    case GitHubProviderResultStatus.ProviderRepoNotFound:
    case GitHubProviderResultStatus.ProviderRepoForbidden:
    case GitHubProviderResultStatus.ProviderUnavailable:
      return {
        observation: createGitHubRepositoryDefaultUnavailableObservation(
          RepositoryDefaultReason.ProviderError,
          provenance
        ),
      };
    default:
      return assertNeverProviderResult(result);
  }
}

/**
 * Construct a validated explicit producer outcome such as capped,
 * permission-filtered, ambiguous, malformed, or not-reported evidence.
 */
export function createGitHubRepositoryDefaultUnavailableObservation(
  reason: GitHubRepositoryDefaultProducerFailureReason,
  provenance: RepositoryDefaultProvenance
): RepositoryDefaultUnavailableObservation {
  return repositoryDefaultUnavailableObservationValidator.parse({
    reason,
    provenance,
  });
}

/**
 * Build poorer evidence for a repository whose provider-qualified identity is
 * already known. A bounded page cap is partial; every other failure is absent.
 */
export function createGitHubRepositoryDefaultUnavailableEvidence(
  reason: GitHubRepositoryDefaultProducerFailureReason
): RepositoryDefaultEvidence {
  return {
    availability: RepositoryDefaultAvailability.Unavailable,
    completeness:
      reason === RepositoryDefaultReason.Capped
        ? RepositoryDefaultCompleteness.Partial
        : RepositoryDefaultCompleteness.Unavailable,
    reason,
  };
}

function assertNeverProviderResult(value: never): never {
  throw new Error(`Unhandled GitHub provider result: ${String(value)}`);
}

function resolveInsufficientScopeReason(
  provenance: RepositoryDefaultProvenance
): GitHubRepositoryDefaultProducerFailureReason {
  if (
    provenance.credentialType === GitHubFetchCredentialType.GitHubApp ||
    provenance.credentialType === GitHubFetchCredentialType.Unauthenticated
  ) {
    return RepositoryDefaultReason.PermissionFiltered;
  }
  return RepositoryDefaultReason.PermissionDenied;
}
