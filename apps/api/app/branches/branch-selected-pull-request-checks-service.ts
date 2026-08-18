import "server-only";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import {
  BranchSelectedPullRequestChecksAvailability,
  type BranchSelectedPullRequestChecksProjection,
  branchSelectedPullRequestChecksAccessUnavailable,
  branchSelectedPullRequestChecksEvidenceUnavailable,
  projectBranchSelectedPullRequestChecks,
  unavailableBranchSelectedPullRequestChecksLegacyFields,
} from "@repo/api/src/types/branch-selected-pull-request-checks";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import { getSelectedPullRequestChecksEvidence } from "@repo/github/selected-pull-request-checks-evidence";
import { runBranchViewRead } from "@/lib/github/github-branch-view-read-client";
import { isValidCloudBranchId } from "./branch-canonical-metric-usage";
import { branchHasCloudEligibility } from "./cloud-branch-eligibility";

const selectedPullRequestChecksContextSelect = {
  id: true,
  organizationId: true,
  branch: {
    select: {
      headSha: true,
      repositoryId: true,
      repositoryFullName: true,
      repository: { select: { fullName: true } },
    },
  },
  pullRequestDetails: {
    select: {
      branchArtifactId: true,
      repositoryId: true,
      repositoryFullName: true,
      repository: { select: { fullName: true } },
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
      headRefOid: true,
    },
  },
} satisfies Prisma.ArtifactSelect;

type ExpectedBranchSelectedPullRequest = {
  headSha: string;
  repositoryFullName: string;
  pullRequestNumber: number;
};

type SelectedPullRequestChecksContextRow = Prisma.ArtifactGetPayload<{
  select: typeof selectedPullRequestChecksContextSelect;
}>;

type SelectedPullRequestChecksContext = {
  owner: string;
  repo: string;
};

type SelectedPullRequestChecksContextResult =
  | { matched: true; value: SelectedPullRequestChecksContext }
  | { matched: false };

/** Branch application read over the landed immutable selected-PR checks contract. */
export const branchSelectedPullRequestChecksService = {
  enrichBranchDetail: async (
    organizationId: string,
    userId: string,
    branch: BranchPageDetail,
    signal?: AbortSignal
  ): Promise<BranchPageDetail> => {
    const cleared = {
      ...branch,
      ...unavailableBranchSelectedPullRequestChecksLegacyFields(),
    };
    const expected = expectedSelectedPullRequest(branch);
    if (!expected) {
      return cleared;
    }
    const projection = await branchSelectedPullRequestChecksService.getChecks(
      organizationId,
      userId,
      branch.id,
      expected,
      signal
    );
    if (!projection) {
      return cleared;
    }
    if (
      projection.response.status ===
        BranchSelectedPullRequestChecksAvailability.Available &&
      !evidenceIdentityMatches(projection.response.value, expected)
    ) {
      return cleared;
    }
    return {
      ...cleared,
      ...projection.legacy,
      selectedPullRequestChecks: projection.response,
    };
  },

  getChecks: async (
    organizationId: string,
    userId: string,
    branchId: string,
    expected: ExpectedBranchSelectedPullRequest,
    signal?: AbortSignal
  ): Promise<BranchSelectedPullRequestChecksProjection | null> => {
    const context = await findSelectedPullRequestChecksContext(
      organizationId,
      branchId,
      expected
    );
    if (context === null) {
      return null;
    }
    if (!context.matched) {
      return branchSelectedPullRequestChecksEvidenceUnavailable({
        status: SelectedPullRequestEvidenceAvailability.Unavailable,
        reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
      });
    }
    const read = await runBranchViewRead(
      {
        organizationId,
        userId,
        target: { owner: context.value.owner, repo: context.value.repo },
      },
      (octokit) =>
        getSelectedPullRequestChecksEvidence(
          octokit,
          context.value.owner,
          context.value.repo,
          expected.pullRequestNumber,
          selectedPullRequestChecksAcquisitionOptions(signal)
        )
    );
    if (!read.ok) {
      return branchSelectedPullRequestChecksAccessUnavailable(
        read.error.reason,
        read.error.retryAfterSeconds
      );
    }
    if (
      read.value.status === SelectedPullRequestEvidenceAvailability.Unavailable
    ) {
      return branchSelectedPullRequestChecksEvidenceUnavailable(read.value);
    }
    if (!evidenceIdentityMatches(read.value.value, expected)) {
      return branchSelectedPullRequestChecksEvidenceUnavailable({
        status: SelectedPullRequestEvidenceAvailability.Unavailable,
        reason: evidenceIdentityMismatchReason(read.value.value, expected),
      });
    }
    return projectBranchSelectedPullRequestChecks(read.value.value);
  },
};

function expectedSelectedPullRequest(
  branch: BranchPageDetail
): ExpectedBranchSelectedPullRequest | null {
  const selectedId = branch.associatedPullRequests?.selectedId;
  const selected = branch.associatedPullRequests?.items.find(
    (pullRequest) => pullRequest.id === selectedId
  );
  const selectedDetail = branch.selectedPullRequest;
  if (
    !(
      selected &&
      selectedDetail?.id === selected.id &&
      selectedDetail.headRefOid &&
      GIT_SHA_REGEX.test(selectedDetail.headRefOid)
    )
  ) {
    return null;
  }
  return {
    headSha: selectedDetail.headRefOid.toLowerCase(),
    repositoryFullName: normalizeRepoFullName(selected.repositoryFullName),
    pullRequestNumber: selected.number,
  };
}

function findSelectedPullRequestChecksContext(
  organizationId: string,
  branchId: string,
  expected: ExpectedBranchSelectedPullRequest
): Promise<SelectedPullRequestChecksContextResult | null> {
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
      select: selectedPullRequestChecksContextSelect,
    });
    if (!row?.branch) {
      return null;
    }
    return selectedPullRequestChecksContextFromRow(row, expected);
  });
}

function selectedPullRequestChecksContextFromRow(
  row: SelectedPullRequestChecksContextRow,
  expected: ExpectedBranchSelectedPullRequest
): SelectedPullRequestChecksContextResult {
  const selected = row.pullRequestDetails.find(
    (detail) =>
      detail.branchArtifactId === row.id &&
      detail.number === expected.pullRequestNumber &&
      pullRequestRepositoryFullName(row, detail) ===
        normalizeRepoFullName(expected.repositoryFullName)
  );
  const repositoryFullName = selected
    ? pullRequestRepositoryFullName(row, selected)
    : null;
  if (
    !(
      selected &&
      repositoryFullName ===
        normalizeRepoFullName(expected.repositoryFullName) &&
      selected.number === expected.pullRequestNumber &&
      selected.headRefOid?.toLowerCase() === expected.headSha
    )
  ) {
    return { matched: false };
  }
  const [owner, repo] = repositoryFullName.split("/");
  return owner && repo
    ? { matched: true, value: { owner, repo } }
    : { matched: false };
}

function pullRequestRepositoryFullName(
  row: SelectedPullRequestChecksContextRow,
  detail: SelectedPullRequestChecksContextRow["pullRequestDetails"][number]
) {
  const fullName =
    detail.repository?.fullName ??
    detail.repositoryFullName ??
    row.branch?.repository?.fullName ??
    row.branch?.repositoryFullName;
  return fullName ? normalizeRepoFullName(fullName) : null;
}

function evidenceIdentityMatches(
  evidence: {
    identity: { repositoryFullName: string; number: number };
    revision: { headSha: string };
  },
  expected: ExpectedBranchSelectedPullRequest
) {
  return (
    normalizeRepoFullName(evidence.identity.repositoryFullName) ===
      normalizeRepoFullName(expected.repositoryFullName) &&
    evidence.identity.number === expected.pullRequestNumber &&
    evidence.revision.headSha.toLowerCase() === expected.headSha
  );
}

function evidenceIdentityMismatchReason(
  evidence: {
    identity: { repositoryFullName: string; number: number };
    revision: { headSha: string };
  },
  expected: ExpectedBranchSelectedPullRequest
) {
  const selectedPullRequestMatches =
    normalizeRepoFullName(evidence.identity.repositoryFullName) ===
      normalizeRepoFullName(expected.repositoryFullName) &&
    evidence.identity.number === expected.pullRequestNumber;
  return selectedPullRequestMatches &&
    evidence.revision.headSha.toLowerCase() !== expected.headSha
    ? SelectedPullRequestEvidenceUnavailableReason.StaleRevision
    : SelectedPullRequestEvidenceUnavailableReason.MalformedResponse;
}

function selectedPullRequestChecksAcquisitionOptions(signal?: AbortSignal) {
  return {
    ...(signal ? { signal } : {}),
    timeoutMs: SELECTED_PULL_REQUEST_CHECKS_APPLICATION_TIMEOUT_MS,
  };
}

const GIT_SHA_REGEX = /^[0-9a-f]{40}$/i;
const SELECTED_PULL_REQUEST_CHECKS_APPLICATION_TIMEOUT_MS = 50_000;
