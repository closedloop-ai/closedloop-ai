import "server-only";

import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import {
  type SelectedPullRequestCheck,
  SelectedPullRequestCheckCategory,
  SelectedPullRequestChecksCompleteness,
  type SelectedPullRequestChecksCounts,
  type SelectedPullRequestChecksCoverage,
  type SelectedPullRequestChecksEvidence,
  type SelectedPullRequestChecksEvidenceResult,
  SelectedPullRequestChecksHistoryMode,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { z } from "zod";
import {
  createSelectedPullRequestAcquisitionDeadline,
  type SelectedPullRequestAcquisitionOptions,
} from "./selected-pull-request-acquisition-deadline";
import {
  readSelectedPullRequestCheckContexts,
  type SelectedPullRequestCheckContextsRead,
} from "./selected-pull-request-checks-pagination";
import type { SelectedPullRequestChecksOctokit } from "./selected-pull-request-client";
import {
  classifySelectedPullRequestProviderError,
  type SelectedPullRequestProviderFailure,
  SelectedPullRequestProviderOperation,
} from "./selected-pull-request-provider-failure";

/** Acquire fully paginated latest-per-source checks for one selected PR head. */
export async function getSelectedPullRequestChecksEvidence(
  octokit: SelectedPullRequestChecksOctokit,
  owner: string,
  repo: string,
  pullNumber: number,
  options: SelectedPullRequestAcquisitionOptions = {}
): Promise<SelectedPullRequestChecksEvidenceResult> {
  const input = normalizeInput(owner, repo, pullNumber);
  const deadline = createSelectedPullRequestAcquisitionDeadline(options);
  if (!(input && deadline)) {
    deadline?.dispose();
    return unavailable(
      SelectedPullRequestEvidenceUnavailableReason.MalformedRequest
    );
  }

  try {
    return await acquireSelectedPullRequestChecksEvidence(
      octokit,
      input,
      deadline.signal
    );
  } catch (error) {
    return unavailableFromFailure(
      classifySelectedPullRequestProviderError(
        error,
        SelectedPullRequestProviderOperation.SelectedRevision
      )
    );
  } finally {
    deadline.dispose();
  }
}

async function acquireSelectedPullRequestChecksEvidence(
  octokit: SelectedPullRequestChecksOctokit,
  input: NormalizedInput,
  signal: AbortSignal
): Promise<SelectedPullRequestChecksEvidenceResult> {
  signal.throwIfAborted();
  const initialResult = await readPullRequestMetadata(octokit, input, signal);
  signal.throwIfAborted();
  if (isUnavailable(initialResult)) {
    return initialResult;
  }
  if (!GIT_SHA_REGEX.test(initialResult.value.headSha)) {
    return unavailable(
      SelectedPullRequestEvidenceUnavailableReason.MissingImmutableRevision
    );
  }

  const contextsResult = await readSelectedPullRequestCheckContexts(
    octokit,
    input.owner,
    input.repo,
    initialResult.value.headSha,
    signal
  );
  if (isUnavailable(contextsResult)) {
    return contextsResult;
  }
  if (contextReadWasCancelled(contextsResult.value, signal)) {
    return {
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: buildEvidence(input, initialResult.value, contextsResult.value),
    };
  }
  signal.throwIfAborted();
  const finalResult = await readPullRequestMetadata(octokit, input, signal);
  signal.throwIfAborted();
  if (isUnavailable(finalResult)) {
    return finalResult;
  }
  if (!GIT_SHA_REGEX.test(finalResult.value.headSha)) {
    return unavailable(
      SelectedPullRequestEvidenceUnavailableReason.MissingImmutableRevision
    );
  }
  if (!metadataRemainedStable(initialResult.value, finalResult.value)) {
    return unavailable(
      SelectedPullRequestEvidenceUnavailableReason.StaleRevision
    );
  }

  return {
    status: SelectedPullRequestEvidenceAvailability.Available,
    value: buildEvidence(input, initialResult.value, contextsResult.value),
  };
}

async function readPullRequestMetadata(
  octokit: SelectedPullRequestChecksOctokit,
  input: NormalizedInput,
  signal: AbortSignal
): Promise<InternalResult<PullRequestMetadata>> {
  try {
    const response = await octokit.rest.pulls.get({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
      request: { signal },
    });
    const parsed = pullRequestMetadataSchema.safeParse(response.data);
    if (!parsed.success || parsed.data.number !== input.pullNumber) {
      return unavailable(
        SelectedPullRequestEvidenceUnavailableReason.MalformedResponse
      );
    }
    return available({
      githubId: String(parsed.data.id),
      number: parsed.data.number,
      url: parsed.data.html_url,
      headSha: parsed.data.head.sha?.trim() ?? "",
    });
  } catch (error) {
    return unavailableFromFailure(
      classifySelectedPullRequestProviderError(
        error,
        SelectedPullRequestProviderOperation.PullRequest
      )
    );
  }
}

function buildEvidence(
  input: NormalizedInput,
  metadata: PullRequestMetadata,
  read: SelectedPullRequestCheckContextsRead
): SelectedPullRequestChecksEvidence {
  const counts = buildCounts(read);
  const coverage: SelectedPullRequestChecksCoverage = {
    completeness:
      read.reasons.length === 0 && !read.interruption
        ? SelectedPullRequestChecksCompleteness.Complete
        : SelectedPullRequestChecksCompleteness.Partial,
    reasons: read.reasons,
    ...(read.interruption ? { interruption: read.interruption } : {}),
  };
  return {
    identity: {
      githubId: metadata.githubId,
      repositoryFullName: input.repositoryFullName,
      number: metadata.number,
      url: metadata.url,
    },
    revision: { headSha: metadata.headSha },
    checks: read.checks,
    counts,
    pagination: {
      pageSize: read.pageSize,
      pagesFetched: read.pagesFetched,
      acquisitionMaximum: read.acquisitionMaximum,
      reachedAcquisitionMaximum: read.reachedAcquisitionMaximum,
    },
    history: {
      mode: SelectedPullRequestChecksHistoryMode.LatestPerSourceFromProviderRollup,
      providerLimit: null,
      rawAttempts: read.providerReturned,
      emittedSources: read.checks.length,
    },
    coverage,
  };
}

function buildCounts(
  read: SelectedPullRequestCheckContextsRead
): SelectedPullRequestChecksCounts {
  const counts = {
    providerExpected: read.providerExpected,
    providerReturned: read.providerReturned,
    normalizedAttempts: read.normalizedAttempts,
    emitted: read.checks.length,
    total: read.checks.length,
    successful: 0,
    failing: 0,
    pending: 0,
    neutral: 0,
  };
  for (const check of read.checks) {
    incrementCategory(counts, check.category);
  }
  return counts;
}

function incrementCategory(
  counts: SelectedPullRequestChecksCounts,
  category: SelectedPullRequestCheck["category"]
): void {
  switch (category) {
    case SelectedPullRequestCheckCategory.Successful:
      counts.successful += 1;
      break;
    case SelectedPullRequestCheckCategory.Failing:
      counts.failing += 1;
      break;
    case SelectedPullRequestCheckCategory.Pending:
      counts.pending += 1;
      break;
    case SelectedPullRequestCheckCategory.Neutral:
      counts.neutral += 1;
      break;
    default:
      assertNever(category);
  }
}

function normalizeInput(
  owner: string,
  repo: string,
  pullNumber: number
): NormalizedInput | null {
  const parsed = inputSchema.safeParse({ owner, repo, pullNumber });
  if (!parsed.success) {
    return null;
  }
  const repositoryFullName = normalizeRepoFullName(
    `${parsed.data.owner}/${parsed.data.repo}`
  );
  if (!REPOSITORY_FULL_NAME_REGEX.test(repositoryFullName)) {
    return null;
  }
  const [normalizedOwner, normalizedRepo] = repositoryFullName.split("/");
  if (!(normalizedOwner && normalizedRepo)) {
    return null;
  }
  return {
    owner: normalizedOwner,
    repo: normalizedRepo,
    pullNumber: parsed.data.pullNumber,
    repositoryFullName,
  };
}

function metadataRemainedStable(
  initial: PullRequestMetadata,
  final: PullRequestMetadata
): boolean {
  return (
    initial.githubId === final.githubId &&
    initial.number === final.number &&
    initial.url === final.url &&
    initial.headSha === final.headSha
  );
}

function isUnavailable<T>(
  result: InternalResult<T>
): result is UnavailableResult {
  return result.status === SelectedPullRequestEvidenceAvailability.Unavailable;
}

function available<T>(value: T): InternalAvailable<T> {
  return {
    status: SelectedPullRequestEvidenceAvailability.Available,
    value,
  };
}

function unavailable(
  reason: SelectedPullRequestEvidenceUnavailableReason,
  retryAfterSeconds?: number | null
): UnavailableResult {
  return {
    status: SelectedPullRequestEvidenceAvailability.Unavailable,
    reason,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

function unavailableFromFailure(
  failure: SelectedPullRequestProviderFailure
): UnavailableResult {
  return unavailable(failure.reason, failure.retryAfterSeconds);
}

function contextReadWasCancelled(
  read: SelectedPullRequestCheckContextsRead,
  signal: AbortSignal
): boolean {
  return (
    signal.aborted &&
    read.interruption?.reason ===
      SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled selected pull-request check category: ${value}`);
}

type NormalizedInput = {
  owner: string;
  repo: string;
  pullNumber: number;
  repositoryFullName: string;
};

type PullRequestMetadata = {
  githubId: string;
  number: number;
  url: string;
  headSha: string;
};

type InternalAvailable<T> = {
  status: typeof SelectedPullRequestEvidenceAvailability.Available;
  value: T;
};

type UnavailableResult = Exclude<
  SelectedPullRequestChecksEvidenceResult,
  { status: typeof SelectedPullRequestEvidenceAvailability.Available }
>;

type InternalResult<T> = InternalAvailable<T> | UnavailableResult;

const GIT_SHA_REGEX = /^[0-9a-f]{40}$/i;
const REPOSITORY_FULL_NAME_REGEX = /^[^/]+\/[^/]+$/;

const inputSchema = z.object({
  owner: z.string().trim().min(1).refine(isRepositoryComponent),
  repo: z.string().trim().min(1).refine(isRepositoryComponent),
  pullNumber: z.number().int().positive(),
});

const pullRequestMetadataSchema = z.object({
  id: z.number().int().nonnegative(),
  number: z.number().int().positive(),
  html_url: z.url().refine((value) => HTTP_URL_PROTOCOL_REGEX.test(value)),
  head: z.object({ sha: z.string().nullish() }),
});

function isRepositoryComponent(value: string): boolean {
  return !value.includes("/");
}

const HTTP_URL_PROTOCOL_REGEX = /^https?:\/\//;
