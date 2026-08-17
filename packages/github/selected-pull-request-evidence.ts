import "server-only";

import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import {
  SelectedPullRequestContentNotApplicableReason,
  type SelectedPullRequestContentReference,
  SelectedPullRequestContentReferenceAvailability,
  type SelectedPullRequestEvidence,
  SelectedPullRequestEvidenceAvailability,
  type SelectedPullRequestEvidenceResult,
  SelectedPullRequestEvidenceUnavailableReason,
  type SelectedPullRequestFile,
  SelectedPullRequestFileCompleteness,
  SelectedPullRequestFilePartialReason,
  SelectedPullRequestFileStatus,
  SelectedPullRequestPatchAvailability,
  SelectedPullRequestPatchOmissionReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { z } from "zod";
import type { SelectedPullRequestOctokit } from "./selected-pull-request-client";
import { withSelectedPullRequestDeadline } from "./selected-pull-request-deadline";
import { readSelectedPullRequestMergeBase } from "./selected-pull-request-merge-base";
import { classifySelectedPullRequestProviderFailure } from "./selected-pull-request-provider-failure";

const GIT_SHA_REGEX = /^[0-9a-f]{40}$/i;
const REPOSITORY_FULL_NAME_REGEX = /^[^/]+\/[^/]+$/;
const FILES_PER_PAGE = 100;
const MAX_PULL_REQUEST_FILES = 3000;
const MAX_PULL_REQUEST_FILE_PAGES = MAX_PULL_REQUEST_FILES / FILES_PER_PAGE;
const selectedPullRequestInputSchema = z.object({
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  pullNumber: z.number().int().positive(),
});

const pullRequestMetadataSchema = z.object({
  id: z.number().int().nonnegative(),
  number: z.number().int().positive(),
  html_url: z.url(),
  changed_files: z.number().int().nonnegative().nullish(),
  base: z.object({ sha: z.string().nullish() }),
  head: z.object({ sha: z.string().nullish() }),
});

const pullRequestFileSchema = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().min(1).optional(),
  status: z.string().trim().min(1),
  additions: z.number().int().nonnegative().nullish(),
  deletions: z.number().int().nonnegative().nullish(),
  changes: z.number().int().nonnegative().nullish(),
  patch: z.string().optional(),
});

const providerFileStatusSchema = z.enum(SelectedPullRequestFileStatus);

const partialReasonOrder = [
  SelectedPullRequestFilePartialReason.ProviderCapped,
  SelectedPullRequestFilePartialReason.CountMismatch,
  SelectedPullRequestFilePartialReason.MalformedFile,
] as const;

/**
 * Acquire one PR's immutable revision and PR-scoped file evidence with the
 * caller's already-authorized Octokit. Metadata is read before and after file
 * pagination so a moving PR can never be reported as one stable comparison.
 * An optional caller signal is composed with the provider-owned deadline;
 * caller cancellation rejects while only the internal deadline is classified.
 */
export async function getSelectedPullRequestEvidence(
  octokit: SelectedPullRequestOctokit,
  owner: string,
  repo: string,
  pullNumber: number,
  callerSignal?: AbortSignal
): Promise<SelectedPullRequestEvidenceResult> {
  callerSignal?.throwIfAborted();
  const controller = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  try {
    return await withSelectedPullRequestDeadline(
      acquireSelectedPullRequestEvidence(
        octokit,
        owner,
        repo,
        pullNumber,
        signal
      ),
      controller,
      callerSignal
    );
  } catch (error) {
    if (callerSignal?.aborted) {
      throw callerSignal.reason;
    }
    return classifySelectedPullRequestProviderFailure(error);
  }
}

async function acquireSelectedPullRequestEvidence(
  octokit: SelectedPullRequestOctokit,
  owner: string,
  repo: string,
  pullNumber: number,
  signal: AbortSignal
): Promise<SelectedPullRequestEvidenceResult> {
  signal.throwIfAborted();
  const input = normalizeSelectedPullRequestInput(owner, repo, pullNumber);
  if (!input) {
    return unavailable(
      SelectedPullRequestEvidenceUnavailableReason.MalformedRequest
    );
  }

  const initialMetadata = await readPullRequestMetadata(
    octokit,
    input.owner,
    input.repo,
    input.pullNumber,
    signal
  );
  signal.throwIfAborted();
  if (
    initialMetadata.status ===
    SelectedPullRequestEvidenceAvailability.Unavailable
  ) {
    return initialMetadata;
  }
  const initial = initialMetadata.value;
  if (!hasImmutableRevision(initial.baseTipSha, initial.headSha)) {
    return unavailable(
      SelectedPullRequestEvidenceUnavailableReason.MissingImmutableRevision
    );
  }

  const mergeBaseResult = await readSelectedPullRequestMergeBase(
    octokit,
    input.owner,
    input.repo,
    initial.baseTipSha,
    initial.headSha,
    signal
  );
  signal.throwIfAborted();
  if (
    mergeBaseResult.status ===
    SelectedPullRequestEvidenceAvailability.Unavailable
  ) {
    return mergeBaseResult;
  }

  const filesResult = await readPullRequestFiles(
    octokit,
    input.owner,
    input.repo,
    input.pullNumber,
    mergeBaseResult.value,
    initial.headSha,
    signal
  );
  signal.throwIfAborted();
  if (
    filesResult.status === SelectedPullRequestEvidenceAvailability.Unavailable
  ) {
    return filesResult;
  }

  const finalMetadata = await readPullRequestMetadata(
    octokit,
    input.owner,
    input.repo,
    input.pullNumber,
    signal
  );
  signal.throwIfAborted();
  if (
    finalMetadata.status === SelectedPullRequestEvidenceAvailability.Unavailable
  ) {
    return finalMetadata;
  }
  const final = finalMetadata.value;
  if (!hasImmutableRevision(final.baseTipSha, final.headSha)) {
    return unavailable(
      SelectedPullRequestEvidenceUnavailableReason.MissingImmutableRevision
    );
  }
  if (!metadataRemainedStable(initial, final)) {
    return unavailable(
      SelectedPullRequestEvidenceUnavailableReason.StaleRevision
    );
  }

  const value = buildSelectedPullRequestEvidence(
    input.repositoryFullName,
    initial,
    mergeBaseResult.value,
    filesResult.value
  );
  return {
    status: SelectedPullRequestEvidenceAvailability.Available,
    value,
  };
}

type NormalizedSelectedPullRequestInput = {
  owner: string;
  repo: string;
  pullNumber: number;
  repositoryFullName: string;
};

type PullRequestMetadata = {
  githubId: string;
  number: number;
  url: string;
  baseTipSha: string;
  headSha: string;
  expectedFileCount: number | null;
};

type PullRequestFilesRead = {
  files: SelectedPullRequestFile[];
  providerReturned: number;
  pagesFetched: number;
  reachedProviderMaximum: boolean;
  malformedFile: boolean;
};

type InternalAvailable<T> = {
  status: typeof SelectedPullRequestEvidenceAvailability.Available;
  value: T;
};

type InternalReadResult<T> =
  | InternalAvailable<T>
  | Exclude<
      SelectedPullRequestEvidenceResult,
      { status: typeof SelectedPullRequestEvidenceAvailability.Available }
    >;

function normalizeSelectedPullRequestInput(
  owner: string,
  repo: string,
  pullNumber: number
): NormalizedSelectedPullRequestInput | null {
  const parsed = selectedPullRequestInputSchema.safeParse({
    owner,
    repo,
    pullNumber,
  });
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

async function readPullRequestMetadata(
  octokit: SelectedPullRequestOctokit,
  owner: string,
  repo: string,
  pullNumber: number,
  signal: AbortSignal
): Promise<InternalReadResult<PullRequestMetadata>> {
  signal.throwIfAborted();
  try {
    const response = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      request: { signal },
    });
    signal.throwIfAborted();
    const parsed = pullRequestMetadataSchema.safeParse(response.data);
    if (!parsed.success || parsed.data.number !== pullNumber) {
      return unavailable(
        SelectedPullRequestEvidenceUnavailableReason.MalformedResponse
      );
    }
    return {
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        githubId: String(parsed.data.id),
        number: parsed.data.number,
        url: parsed.data.html_url,
        baseTipSha: parsed.data.base.sha?.trim() ?? "",
        headSha: parsed.data.head.sha?.trim() ?? "",
        expectedFileCount: parsed.data.changed_files ?? null,
      },
    };
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason;
    }
    return classifySelectedPullRequestProviderFailure(error);
  }
}

async function readPullRequestFiles(
  octokit: SelectedPullRequestOctokit,
  owner: string,
  repo: string,
  pullNumber: number,
  baseSha: string,
  headSha: string,
  signal: AbortSignal
): Promise<InternalReadResult<PullRequestFilesRead>> {
  const files: SelectedPullRequestFile[] = [];
  const seenPaths = new Set<string>();
  let providerReturned = 0;
  let pagesFetched = 0;
  let malformedFile = false;

  try {
    for (let page = 1; page <= MAX_PULL_REQUEST_FILE_PAGES; page += 1) {
      signal.throwIfAborted();
      const response = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        page,
        per_page: FILES_PER_PAGE,
        request: { signal },
      });
      signal.throwIfAborted();
      if (
        !Array.isArray(response.data) ||
        response.data.length > FILES_PER_PAGE
      ) {
        return unavailable(
          SelectedPullRequestEvidenceUnavailableReason.MalformedResponse
        );
      }
      pagesFetched += 1;
      providerReturned += response.data.length;
      for (const rawFile of response.data) {
        const normalized = normalizePullRequestFile(rawFile, baseSha, headSha);
        if (!normalized) {
          malformedFile = true;
          continue;
        }
        if (normalized.status === SelectedPullRequestFileStatus.Unknown) {
          malformedFile = true;
        }
        if (seenPaths.has(normalized.path)) {
          malformedFile = true;
          continue;
        }
        seenPaths.add(normalized.path);
        files.push(normalized);
      }
      if (response.data.length < FILES_PER_PAGE) {
        break;
      }
    }
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason;
    }
    return classifySelectedPullRequestProviderFailure(error);
  }

  return {
    status: SelectedPullRequestEvidenceAvailability.Available,
    value: {
      files,
      providerReturned,
      pagesFetched,
      reachedProviderMaximum: providerReturned >= MAX_PULL_REQUEST_FILES,
      malformedFile,
    },
  };
}

function normalizePullRequestFile(
  input: unknown,
  baseSha: string,
  headSha: string
): SelectedPullRequestFile | null {
  const parsed = pullRequestFileSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }
  const status = normalizedFileStatus(parsed.data.status);
  const previousPath = parsed.data.previous_filename;
  if (status === SelectedPullRequestFileStatus.Renamed && !previousPath) {
    return null;
  }
  const file: SelectedPullRequestFile = {
    path: parsed.data.filename,
    providerStatus: parsed.data.status,
    status,
    additions: parsed.data.additions ?? null,
    deletions: parsed.data.deletions ?? null,
    changes: parsed.data.changes ?? null,
    patch: normalizedPatchEvidence(parsed.data.patch),
    baseContent: baseContentReference(
      status,
      previousPath ?? parsed.data.filename,
      baseSha
    ),
    headContent: headContentReference(status, parsed.data.filename, headSha),
  };
  if (previousPath) {
    file.previousPath = previousPath;
  }
  return file;
}

function normalizedFileStatus(status: string): SelectedPullRequestFileStatus {
  const parsed = providerFileStatusSchema.safeParse(status);
  return parsed.success ? parsed.data : SelectedPullRequestFileStatus.Unknown;
}

function normalizedPatchEvidence(
  patch: string | undefined
): SelectedPullRequestFile["patch"] {
  if (patch !== undefined) {
    return {
      availability: SelectedPullRequestPatchAvailability.Available,
      patch,
    };
  }
  return {
    availability: SelectedPullRequestPatchAvailability.Omitted,
    reason: SelectedPullRequestPatchOmissionReason.ProviderOmitted,
  };
}

function baseContentReference(
  status: SelectedPullRequestFileStatus,
  path: string,
  ref: string
): SelectedPullRequestContentReference {
  if (status === SelectedPullRequestFileStatus.Added) {
    return {
      availability:
        SelectedPullRequestContentReferenceAvailability.NotApplicable,
      reason: SelectedPullRequestContentNotApplicableReason.AddedFile,
    };
  }
  return {
    availability: SelectedPullRequestContentReferenceAvailability.Available,
    path,
    ref,
  };
}

function headContentReference(
  status: SelectedPullRequestFileStatus,
  path: string,
  ref: string
): SelectedPullRequestContentReference {
  if (status === SelectedPullRequestFileStatus.Removed) {
    return {
      availability:
        SelectedPullRequestContentReferenceAvailability.NotApplicable,
      reason: SelectedPullRequestContentNotApplicableReason.RemovedFile,
    };
  }
  return {
    availability: SelectedPullRequestContentReferenceAvailability.Available,
    path,
    ref,
  };
}

function buildSelectedPullRequestEvidence(
  repositoryFullName: string,
  metadata: PullRequestMetadata,
  mergeBaseSha: string,
  filesRead: PullRequestFilesRead
): SelectedPullRequestEvidence {
  const partialReasons = new Set<SelectedPullRequestFilePartialReason>();
  if (
    filesRead.reachedProviderMaximum &&
    metadata.expectedFileCount !== MAX_PULL_REQUEST_FILES
  ) {
    partialReasons.add(SelectedPullRequestFilePartialReason.ProviderCapped);
  }
  if (
    metadata.expectedFileCount !== null &&
    metadata.expectedFileCount !== filesRead.files.length
  ) {
    partialReasons.add(SelectedPullRequestFilePartialReason.CountMismatch);
  }
  if (filesRead.malformedFile) {
    partialReasons.add(SelectedPullRequestFilePartialReason.MalformedFile);
  }
  const reasons = partialReasonOrder.filter((reason) =>
    partialReasons.has(reason)
  );

  return {
    identity: {
      githubId: metadata.githubId,
      repositoryFullName,
      number: metadata.number,
      url: metadata.url,
    },
    revision: {
      baseSha: mergeBaseSha,
      headSha: metadata.headSha,
    },
    files: filesRead.files,
    counts: {
      expected: metadata.expectedFileCount,
      providerReturned: filesRead.providerReturned,
      normalizedReturned: filesRead.files.length,
    },
    pagination: {
      pageSize: FILES_PER_PAGE,
      pagesFetched: filesRead.pagesFetched,
      providerMaximum: MAX_PULL_REQUEST_FILES,
      reachedProviderMaximum: filesRead.reachedProviderMaximum,
    },
    coverage: {
      completeness:
        reasons.length === 0
          ? SelectedPullRequestFileCompleteness.Complete
          : SelectedPullRequestFileCompleteness.Partial,
      reasons,
    },
  };
}

function metadataRemainedStable(
  initial: PullRequestMetadata,
  final: PullRequestMetadata
): boolean {
  return (
    initial.githubId === final.githubId &&
    initial.number === final.number &&
    initial.baseTipSha === final.baseTipSha &&
    initial.headSha === final.headSha &&
    initial.expectedFileCount === final.expectedFileCount
  );
}

function hasImmutableRevision(baseSha: string, headSha: string): boolean {
  return GIT_SHA_REGEX.test(baseSha) && GIT_SHA_REGEX.test(headSha);
}

function unavailable(
  reason: SelectedPullRequestEvidenceUnavailableReason,
  retryAfterSeconds?: number | null
): Exclude<
  SelectedPullRequestEvidenceResult,
  { status: typeof SelectedPullRequestEvidenceAvailability.Available }
> {
  return {
    status: SelectedPullRequestEvidenceAvailability.Unavailable,
    reason,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}
