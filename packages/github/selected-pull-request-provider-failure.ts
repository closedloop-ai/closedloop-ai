import {
  SelectedPullRequestEvidenceAvailability,
  type SelectedPullRequestEvidenceResult,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { z } from "zod";
import {
  classifyGitHubProviderError,
  type GitHubProviderErrorClassification,
} from "./provider-error-classification";
import { GitHubProviderResultStatus } from "./provider-result";

const providerErrorSchema = z.object({
  status: z.number().int().optional(),
  response: z.object({ status: z.number().int().optional() }).optional(),
});

/** Provider operation whose resource identity controls 404 classification. */
export const SelectedPullRequestProviderOperation = {
  PullRequest: "pull_request",
  SelectedRevision: "selected_revision",
} as const;
export type SelectedPullRequestProviderOperation =
  (typeof SelectedPullRequestProviderOperation)[keyof typeof SelectedPullRequestProviderOperation];

/** Typed selected-PR provider failure without an evidence result wrapper. */
export type SelectedPullRequestProviderFailure = {
  reason: SelectedPullRequestEvidenceUnavailableReason;
  retryAfterSeconds?: number | null;
};

/** Classify a selected-PR provider failure without exposing provider text. */
export function classifySelectedPullRequestProviderFailure(
  error: unknown
): Exclude<
  SelectedPullRequestEvidenceResult,
  { status: typeof SelectedPullRequestEvidenceAvailability.Available }
> {
  return unavailableFromFailure(
    classifySelectedPullRequestProviderError(
      error,
      SelectedPullRequestProviderOperation.PullRequest
    )
  );
}

/** Classify a provider error using the resource read that actually failed. */
export function classifySelectedPullRequestProviderError(
  error: unknown,
  operation: SelectedPullRequestProviderOperation
): SelectedPullRequestProviderFailure {
  if (error instanceof Error && error.name === "AbortError") {
    return failure(
      SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut
    );
  }
  const parsed = providerErrorSchema.safeParse(error);
  const status = parsed.success
    ? (parsed.data.status ?? parsed.data.response?.status)
    : undefined;
  // A 401 is the provider's authoritative verdict on the credential, while
  // rate-limit detection is a heuristic over provider message text. Classifying
  // the heuristic first told consumers to back off a credential that will never
  // succeed again instead of prompting reauthentication. 403 is deliberately
  // left below: GitHub really does report secondary rate limits as 403, so
  // there the heuristic must keep outranking the insufficient-scope reading.
  if (status === 401) {
    return failure(
      SelectedPullRequestEvidenceUnavailableReason.CredentialUnauthorized
    );
  }
  const rateLimited = rateLimitedFailure(classifyGitHubProviderError(error));
  if (rateLimited) {
    return rateLimited;
  }
  if (status === 403) {
    return failure(
      SelectedPullRequestEvidenceUnavailableReason.CredentialInsufficientScope
    );
  }
  if (status === 404) {
    return failure(
      operation === SelectedPullRequestProviderOperation.PullRequest
        ? SelectedPullRequestEvidenceUnavailableReason.PullRequestMissingOrInaccessible
        : SelectedPullRequestEvidenceUnavailableReason.SelectedRevisionMissingOrInaccessible
    );
  }
  if (status !== undefined && status >= 500) {
    return failure(
      SelectedPullRequestEvidenceUnavailableReason.ProviderUnavailable
    );
  }
  return failure(SelectedPullRequestEvidenceUnavailableReason.ProviderFailure);
}

function unavailableFromFailure(
  providerFailure: SelectedPullRequestProviderFailure
): Exclude<
  SelectedPullRequestEvidenceResult,
  { status: typeof SelectedPullRequestEvidenceAvailability.Available }
> {
  return {
    status: SelectedPullRequestEvidenceAvailability.Unavailable,
    ...providerFailure,
  };
}

/**
 * Rate-limit failure for a generic classification, or null when that
 * classification carries no rate-limit meaning and status-based handling below
 * should decide. Exhaustive so a newly added classification member fails
 * typecheck here rather than silently falling through to `ProviderFailure`.
 */
function rateLimitedFailure(
  classification: GitHubProviderErrorClassification
): SelectedPullRequestProviderFailure | null {
  switch (classification.status) {
    case GitHubProviderResultStatus.ProviderRateLimit:
      return failure(
        SelectedPullRequestEvidenceUnavailableReason.ProviderRateLimited,
        classification.retryAfterSeconds
      );
    case GitHubProviderResultStatus.ProviderPermissionFiltered:
    case GitHubProviderResultStatus.ProviderUnavailable:
      return null;
    default:
      return assertNeverClassification(classification);
  }
}

function assertNeverClassification(value: never): never {
  throw new Error(
    `Unhandled GitHub provider error classification: ${String(value)}`
  );
}

function failure(
  reason: SelectedPullRequestEvidenceUnavailableReason,
  retryAfterSeconds?: number | null
): SelectedPullRequestProviderFailure {
  return {
    reason,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}
