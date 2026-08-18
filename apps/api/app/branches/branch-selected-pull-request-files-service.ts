import "server-only";

import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import {
  BRANCH_SELECTED_PULL_REQUEST_FILE_CONTENT_MAX_BYTES,
  BranchSelectedPullRequestAcquisitionUnavailableReason,
  type BranchSelectedPullRequestDiffQuery,
  type BranchSelectedPullRequestDiffResponse,
  type BranchSelectedPullRequestFilesQuery,
  type BranchSelectedPullRequestFilesResponse,
  branchSelectedPullRequestAccessUnavailable,
  branchSelectedPullRequestAcquisitionUnavailable,
  branchSelectedPullRequestEvidenceUnavailable,
  projectBranchSelectedPullRequestDiff,
  projectBranchSelectedPullRequestFiles,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import { getSelectedPullRequestFileContentEvidence } from "@repo/github/selected-pull-request-content-evidence";
import { getSelectedPullRequestEvidence } from "@repo/github/selected-pull-request-evidence";
import { runBranchViewRead } from "@/lib/github/github-branch-view-read-client";
import { isValidCloudBranchId } from "./branch-canonical-metric-usage";
import { branchHasCloudEligibility } from "./cloud-branch-eligibility";
import { selectedPullRequestEvidenceAcquisitionBudget } from "./selected-pull-request-evidence-acquisition-budget";

const selectedPullRequestApplicationSelect = {
  id: true,
  branchArtifactId: true,
  repositoryId: true,
  repositoryFullName: true,
  number: true,
  title: true,
  htmlUrl: true,
  prState: true,
  isDraft: true,
  reviewDecision: true,
  githubCreatedAt: true,
  closedAt: true,
  mergedAt: true,
  lastVerifiedAt: true,
  changedFiles: true,
  repository: { select: { fullName: true } },
} satisfies Prisma.PullRequestDetailSelect;

const branchSelectedPullRequestApplicationSelect = {
  id: true,
  organizationId: true,
  branch: {
    select: {
      repositoryId: true,
      repositoryFullName: true,
      repository: { select: { fullName: true } },
    },
  },
  pullRequestDetails: {
    select: selectedPullRequestApplicationSelect,
  },
} satisfies Prisma.ArtifactSelect;

type SelectedPullRequestApplicationRow = Prisma.ArtifactGetPayload<{
  select: typeof branchSelectedPullRequestApplicationSelect;
}>;

type SelectedPullRequestApplicationContext = {
  expectedFileCount: number | null;
  owner: string;
  repo: string;
};

/** Thin Branch application reads over the landed selected-PR provider contract. */
export const branchSelectedPullRequestFilesService = {
  getFiles: async (
    organizationId: string,
    userId: string,
    branchId: string,
    query: BranchSelectedPullRequestFilesQuery,
    signal: AbortSignal = new AbortController().signal
  ): Promise<BranchSelectedPullRequestFilesResponse | null> => {
    const context = await findSelectedPullRequestContext(
      organizationId,
      branchId,
      query
    );
    if (!context) {
      return null;
    }
    const read = await runBranchViewRead(
      branchViewReadInput(organizationId, userId, context),
      (octokit) =>
        captureBranchViewRead(
          async (): Promise<BranchSelectedPullRequestFilesResponse> => {
            const acquisition = await acquireSelectedPullRequestEvidence(
              octokit,
              acquisitionKey(organizationId, userId, query),
              context,
              query,
              signal
            );
            if (!acquisition.admitted) {
              return acquisitionUnavailableResponse(acquisition);
            }
            const evidence = acquisition.value;
            if (
              evidence.status ===
              SelectedPullRequestEvidenceAvailability.Unavailable
            ) {
              return branchSelectedPullRequestEvidenceUnavailable(evidence);
            }
            if (!evidenceIdentityMatches(evidence.value, query)) {
              return malformedEvidenceResponse();
            }
            return projectBranchSelectedPullRequestFiles(
              evidence.value,
              context.expectedFileCount
            );
          }
        )
    );
    if (!read.ok) {
      return branchSelectedPullRequestAccessUnavailable(
        read.error.reason,
        read.error.retryAfterSeconds
      );
    }
    if (!read.value.ok) {
      throw read.value.error;
    }
    return read.value.value;
  },

  getDiff: async (
    organizationId: string,
    userId: string,
    branchId: string,
    query: BranchSelectedPullRequestDiffQuery,
    signal: AbortSignal = new AbortController().signal
  ): Promise<BranchSelectedPullRequestDiffResponse | null> => {
    const context = await findSelectedPullRequestContext(
      organizationId,
      branchId,
      query
    );
    if (!context) {
      return null;
    }
    const read = await runBranchViewRead(
      branchViewReadInput(organizationId, userId, context),
      (octokit) =>
        captureBranchViewRead(
          async (): Promise<BranchSelectedPullRequestDiffResponse> => {
            const key = acquisitionKey(organizationId, userId, query);
            const acquisition = await acquireSelectedPullRequestEvidence(
              octokit,
              key,
              context,
              query,
              signal
            );
            if (!acquisition.admitted) {
              return acquisitionUnavailableResponse(acquisition);
            }
            const evidence = acquisition.value;
            if (
              evidence.status ===
              SelectedPullRequestEvidenceAvailability.Unavailable
            ) {
              return branchSelectedPullRequestEvidenceUnavailable(evidence);
            }
            if (!evidenceIdentityMatches(evidence.value, query)) {
              return malformedEvidenceResponse();
            }
            if (!revisionMatches(evidence.value.revision, query)) {
              return staleRevisionResponse();
            }
            signal.throwIfAborted();
            const contentPermit =
              selectedPullRequestEvidenceAcquisitionBudget.acquireContent(key);
            if (!contentPermit.admitted) {
              return acquisitionUnavailableResponse(contentPermit);
            }
            try {
              const content = await getSelectedPullRequestFileContentEvidence(
                octokit,
                evidence.value,
                query.path,
                BRANCH_SELECTED_PULL_REQUEST_FILE_CONTENT_MAX_BYTES,
                signal
              );
              return projectBranchSelectedPullRequestDiff(
                evidence.value,
                content
              );
            } finally {
              contentPermit.release();
            }
          }
        )
    );
    if (!read.ok) {
      return branchSelectedPullRequestAccessUnavailable(
        read.error.reason,
        read.error.retryAfterSeconds
      );
    }
    if (!read.value.ok) {
      throw read.value.error;
    }
    return read.value.value;
  },
};

function findSelectedPullRequestContext(
  organizationId: string,
  branchId: string,
  query: BranchSelectedPullRequestFilesQuery
): Promise<SelectedPullRequestApplicationContext | null> {
  if (!isValidCloudBranchId(branchId)) {
    return Promise.resolve(null);
  }
  return withDb(async (db) => {
    if (!(await branchHasCloudEligibility(db, organizationId, branchId))) {
      return null;
    }
    const row = await db.artifact.findFirst({
      where: {
        id: branchId,
        organizationId,
        type: ArtifactType.BRANCH,
        branch: { deletedAt: null },
      },
      select: branchSelectedPullRequestApplicationSelect,
    });
    if (!row?.branch) {
      return null;
    }
    return selectedPullRequestContextFromRow(row, query);
  });
}

function selectedPullRequestContextFromRow(
  row: SelectedPullRequestApplicationRow,
  query: BranchSelectedPullRequestFilesQuery
): SelectedPullRequestApplicationContext | null {
  const selected = row.pullRequestDetails.find(
    (detail) =>
      detail.branchArtifactId === row.id &&
      detail.number === query.pullRequestNumber &&
      pullRequestRepositoryFullName(row, detail) === query.repositoryFullName
  );
  if (!selected) {
    return null;
  }
  const [owner, repo] = query.repositoryFullName.split("/");
  if (!(owner && repo)) {
    return null;
  }
  return {
    expectedFileCount: selected.changedFiles,
    owner,
    repo,
  };
}

function pullRequestRepositoryFullName(
  row: SelectedPullRequestApplicationRow,
  detail: SelectedPullRequestApplicationRow["pullRequestDetails"][number]
) {
  const fullName =
    detail.repository?.fullName ??
    detail.repositoryFullName ??
    row.branch?.repository?.fullName ??
    row.branch?.repositoryFullName;
  return fullName ? normalizeRepoFullName(fullName) : null;
}

function branchViewReadInput(
  organizationId: string,
  userId: string,
  context: SelectedPullRequestApplicationContext
) {
  return {
    organizationId,
    userId,
    target: { owner: context.owner, repo: context.repo },
  };
}

function evidenceIdentityMatches(
  evidence: {
    identity: { repositoryFullName: string; number: number };
  },
  query: BranchSelectedPullRequestFilesQuery
) {
  return (
    normalizeRepoFullName(evidence.identity.repositoryFullName) ===
      query.repositoryFullName &&
    evidence.identity.number === query.pullRequestNumber
  );
}

function revisionMatches(
  revision: { baseSha: string; headSha: string },
  query: BranchSelectedPullRequestDiffQuery
) {
  return (
    revision.baseSha.toLowerCase() === query.baseSha &&
    revision.headSha.toLowerCase() === query.headSha
  );
}

function malformedEvidenceResponse() {
  return branchSelectedPullRequestEvidenceUnavailable({
    status: SelectedPullRequestEvidenceAvailability.Unavailable,
    reason: SelectedPullRequestEvidenceUnavailableReason.MalformedResponse,
  });
}

function staleRevisionResponse() {
  return branchSelectedPullRequestEvidenceUnavailable({
    status: SelectedPullRequestEvidenceAvailability.Unavailable,
    reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
  });
}

type CapturedBranchViewRead<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/** Keep unexpected application failures outside the access-denial taxonomy. */
async function captureBranchViewRead<T>(
  read: () => Promise<T>
): Promise<CapturedBranchViewRead<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error };
  }
}

function acquireSelectedPullRequestEvidence(
  octokit: Parameters<typeof getSelectedPullRequestEvidence>[0],
  key: ReturnType<typeof acquisitionKey>,
  context: SelectedPullRequestApplicationContext,
  query: BranchSelectedPullRequestFilesQuery,
  signal: AbortSignal
) {
  return selectedPullRequestEvidenceAcquisitionBudget.acquireEvidence(
    key,
    signal,
    (providerSignal) =>
      getSelectedPullRequestEvidence(
        octokit,
        context.owner,
        context.repo,
        query.pullRequestNumber,
        providerSignal
      )
  );
}

function acquisitionKey(
  organizationId: string,
  userId: string,
  query: BranchSelectedPullRequestFilesQuery
) {
  return {
    organizationId,
    userId,
    repositoryFullName: query.repositoryFullName,
    pullRequestNumber: query.pullRequestNumber,
  };
}

function acquisitionUnavailableResponse(denial: {
  admitted: false;
  retryAfterSeconds: number;
}) {
  return branchSelectedPullRequestAcquisitionUnavailable(
    BranchSelectedPullRequestAcquisitionUnavailableReason.BudgetExhausted,
    denial.retryAfterSeconds
  );
}
