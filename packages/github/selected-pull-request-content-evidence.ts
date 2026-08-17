import "server-only";

import type { Octokit } from "@octokit/rest";
import {
  SelectedPullRequestContentAvailability,
  SelectedPullRequestContentClassification,
  type SelectedPullRequestContentReference,
  SelectedPullRequestContentReferenceAvailability,
  type SelectedPullRequestContentResult,
  SelectedPullRequestContentUnavailableReason,
  type SelectedPullRequestEvidence,
  SelectedPullRequestEvidenceUnavailableReason,
  SelectedPullRequestFileCompleteness,
  SelectedPullRequestFileContentEvidenceAvailability,
  type SelectedPullRequestFileContentEvidenceResult,
  type SelectedPullRequestOrdinaryContentUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { z } from "zod";
import {
  type ClassifiedBoundedFileContentAtRefResult,
  getClassifiedBoundedFileContentAtRef,
} from "./file-content";
import { classifySelectedPullRequestProviderFailure } from "./selected-pull-request-provider-failure";

const selectedFileContentInputSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive(),
});

/**
 * Read both applicable sides of one selected PR file at the immutable refs in
 * its evidence. The requested path must belong to that evidence collection;
 * no Branch-current cache or fallback path participates. When supplied, the
 * caller signal cancels both applicable sides and rejects instead of being
 * projected as independent provider failures.
 */
export async function getSelectedPullRequestFileContentEvidence(
  octokit: Octokit,
  evidence: SelectedPullRequestEvidence,
  path: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<SelectedPullRequestFileContentEvidenceResult> {
  signal?.throwIfAborted();
  const input = selectedFileContentInputSchema.safeParse({ path, maxBytes });
  if (!input.success) {
    return fileContentUnavailable(
      SelectedPullRequestContentUnavailableReason.MalformedRequest
    );
  }
  const file = evidence.files.find(
    (candidate) => candidate.path === input.data.path
  );
  if (!file) {
    return fileContentUnavailable(
      evidence.coverage.completeness ===
        SelectedPullRequestFileCompleteness.Complete
        ? SelectedPullRequestContentUnavailableReason.FileNotInPullRequest
        : SelectedPullRequestContentUnavailableReason.FileMembershipIncomplete
    );
  }
  signal?.throwIfAborted();

  const [base, head] = await Promise.all([
    readContentReference(
      octokit,
      evidence,
      file.baseContent,
      input.data.maxBytes,
      signal
    ),
    readContentReference(
      octokit,
      evidence,
      file.headContent,
      input.data.maxBytes,
      signal
    ),
  ]);
  return {
    status: SelectedPullRequestFileContentEvidenceAvailability.Available,
    value: { file, base, head },
  };
}

async function readContentReference(
  octokit: Octokit,
  evidence: SelectedPullRequestEvidence,
  reference: SelectedPullRequestContentReference,
  maxBytes: number,
  signal?: AbortSignal
): Promise<SelectedPullRequestContentResult> {
  signal?.throwIfAborted();
  if (
    reference.availability ===
    SelectedPullRequestContentReferenceAvailability.NotApplicable
  ) {
    return {
      availability: SelectedPullRequestContentAvailability.NotApplicable,
      reason: reference.reason,
    };
  }
  const [owner, repo] = evidence.identity.repositoryFullName.split("/");
  if (!(owner && repo)) {
    return contentUnavailable(
      SelectedPullRequestContentUnavailableReason.MalformedRequest
    );
  }
  try {
    const result = signal
      ? await getClassifiedBoundedFileContentAtRef(
          octokit,
          owner,
          repo,
          reference.path,
          reference.ref,
          maxBytes,
          signal
        )
      : await getClassifiedBoundedFileContentAtRef(
          octokit,
          owner,
          repo,
          reference.path,
          reference.ref,
          maxBytes
        );
    signal?.throwIfAborted();
    return mapBoundedContentResult(result);
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    return classifyContentProviderFailure(error);
  }
}

function mapBoundedContentResult(
  result: ClassifiedBoundedFileContentAtRefResult
): SelectedPullRequestContentResult {
  switch (result.status) {
    case "found":
      if (
        result.classification ===
        SelectedPullRequestContentClassification.Binary
      ) {
        return {
          availability: SelectedPullRequestContentAvailability.Unavailable,
          classification: SelectedPullRequestContentClassification.Binary,
          reason: SelectedPullRequestContentUnavailableReason.BinaryContent,
        };
      }
      if (
        result.classification ===
        SelectedPullRequestContentClassification.Unknown
      ) {
        return {
          availability: SelectedPullRequestContentAvailability.Unavailable,
          classification: SelectedPullRequestContentClassification.Unknown,
          reason:
            SelectedPullRequestContentUnavailableReason.ContentClassificationUnknown,
        };
      }
      return {
        availability: SelectedPullRequestContentAvailability.Available,
        classification: SelectedPullRequestContentClassification.Text,
        content: result.content,
      };
    case "missing":
      return contentUnavailable(
        SelectedPullRequestContentUnavailableReason.MissingContent
      );
    case "not_file":
      return contentUnavailable(
        SelectedPullRequestContentUnavailableReason.NotAFile
      );
    case "too_large":
      return contentUnavailable(
        SelectedPullRequestContentUnavailableReason.ContentTooLarge
      );
    case "unsupported_encoding":
      return contentUnavailable(
        SelectedPullRequestContentUnavailableReason.UnsupportedEncoding
      );
    default:
      return assertNever(result);
  }
}

function classifyContentProviderFailure(
  error: unknown
): SelectedPullRequestContentResult {
  const failure = classifySelectedPullRequestProviderFailure(error);
  if (
    failure.reason ===
    SelectedPullRequestEvidenceUnavailableReason.CredentialUnauthorized
  ) {
    return contentUnavailable(
      SelectedPullRequestContentUnavailableReason.CredentialUnauthorized
    );
  }
  if (
    failure.reason ===
    SelectedPullRequestEvidenceUnavailableReason.CredentialInsufficientScope
  ) {
    return contentUnavailable(
      SelectedPullRequestContentUnavailableReason.CredentialInsufficientScope
    );
  }
  if (
    failure.reason ===
    SelectedPullRequestEvidenceUnavailableReason.ProviderRateLimited
  ) {
    return contentUnavailable(
      SelectedPullRequestContentUnavailableReason.ProviderRateLimited,
      failure.retryAfterSeconds
    );
  }
  if (
    failure.reason ===
    SelectedPullRequestEvidenceUnavailableReason.ProviderUnavailable
  ) {
    return contentUnavailable(
      SelectedPullRequestContentUnavailableReason.ProviderUnavailable
    );
  }
  return contentUnavailable(
    SelectedPullRequestContentUnavailableReason.ProviderFailure
  );
}

function contentUnavailable(
  reason: SelectedPullRequestOrdinaryContentUnavailableReason,
  retryAfterSeconds?: number | null
): SelectedPullRequestContentResult {
  return {
    availability: SelectedPullRequestContentAvailability.Unavailable,
    reason,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

function fileContentUnavailable(
  reason: SelectedPullRequestOrdinaryContentUnavailableReason
): SelectedPullRequestFileContentEvidenceResult {
  return {
    status: SelectedPullRequestFileContentEvidenceAvailability.Unavailable,
    reason,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled bounded content result: ${JSON.stringify(value)}`);
}
