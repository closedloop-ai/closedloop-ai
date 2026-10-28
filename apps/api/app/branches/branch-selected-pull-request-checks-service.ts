import "server-only";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { isValidCloudBranchId } from "@repo/api/src/types/branch-id";
import {
  normalizeRepoFullName,
  parseRepositoryFullName,
} from "@repo/api/src/types/branch-repository";
import {
  type BranchSelectedPullRequestChecksResponse,
  branchSelectedPullRequestChecksAccessUnavailable,
  branchSelectedPullRequestChecksEvidenceUnavailable,
  projectBranchSelectedPullRequestChecks,
} from "@repo/api/src/types/branch-selected-pull-request-checks";
import {
  type BranchSelectedPullRequestChecksQuery,
  branchSelectedPullRequestChecksQueryForDetail,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import { getSelectedPullRequestChecksEvidence } from "@repo/github/selected-pull-request-checks-evidence";
import { log } from "@repo/observability/log";
import { runBranchViewRead } from "@/lib/github/github-branch-view-read-client";
import { finalizeCloudBranchProductResponse } from "./branch-product-response-eligibility";
import { branchHasCloudEligibility } from "./cloud-branch-eligibility";
import { selectedPullRequestRepositoryFullName } from "./selected-pull-request-repository-identity";

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

type ExpectedBranchSelectedPullRequest = BranchSelectedPullRequestChecksQuery;

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

type UnfinalizedChecksResult =
  | { eligible: false }
  | {
      eligible: true;
      projection: BranchSelectedPullRequestChecksResponse;
    };

/** Branch application read over the landed immutable selected-PR checks contract. */
export const branchSelectedPullRequestChecksService = {
  /**
   * ISS-12278 (Marisol Ashgrove ruling, 2026-10-08, PRD-792 open question 2: PR
   * checks load lazily): the Branch detail read no longer waits on this
   * provider read; the client requests it after the detail renders.
   */
  getChecks: async (
    organizationId: string,
    userId: string,
    branchId: string,
    expected: ExpectedBranchSelectedPullRequest,
    signal?: AbortSignal
  ): Promise<BranchSelectedPullRequestChecksResponse | null> => {
    const acquisition = await getUnfinalizedChecks(
      organizationId,
      userId,
      branchId,
      expected,
      signal,
      (error) => {
        if (signal?.aborted) {
          throw error;
        }
        log.error("[branch-detail] Selected-PR checks acquisition failed", {
          branchId,
          organizationId,
          error,
        });
        return branchSelectedPullRequestChecksEvidenceUnavailable({
          status: SelectedPullRequestEvidenceAvailability.Unavailable,
          reason: SelectedPullRequestEvidenceUnavailableReason.ProviderFailure,
        });
      }
    );
    if (!acquisition.eligible) {
      return null;
    }
    return finalizeCloudBranchProductResponse(
      organizationId,
      branchId,
      acquisition.projection
    );
  },

  /**
   * ISS-12278: a `GET /branches/[id]` caller that has not opted into lazy
   * checks (every installed build before it) still gets them inline. `null`
   * means the Branch is not eligible, exactly as `getChecks` answers.
   */
  enrichBranchDetail: async (
    organizationId: string,
    userId: string,
    branch: BranchPageDetail,
    signal?: AbortSignal
  ): Promise<BranchPageDetail | null> => {
    const expected = branchSelectedPullRequestChecksQueryForDetail(branch);
    if (!expected) {
      return branch;
    }
    const checks = await branchSelectedPullRequestChecksService.getChecks(
      organizationId,
      userId,
      branch.id,
      expected,
      signal
    );
    return checks ? { ...branch, selectedPullRequestChecks: checks } : null;
  },
};

async function getUnfinalizedChecks(
  organizationId: string,
  userId: string,
  branchId: string,
  expected: ExpectedBranchSelectedPullRequest,
  signal: AbortSignal | undefined,
  onProviderFailure: (error: unknown) => BranchSelectedPullRequestChecksResponse
): Promise<UnfinalizedChecksResult> {
  const context = await findSelectedPullRequestChecksContext(
    organizationId,
    branchId,
    expected
  );
  if (context === null) {
    return { eligible: false };
  }
  if (!context.matched) {
    return {
      eligible: true,
      projection: branchSelectedPullRequestChecksEvidenceUnavailable({
        status: SelectedPullRequestEvidenceAvailability.Unavailable,
        reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
      }),
    };
  }
  let read: Awaited<ReturnType<typeof acquireSelectedPullRequestChecks>>;
  try {
    read = await acquireSelectedPullRequestChecks(
      organizationId,
      userId,
      context.value,
      expected,
      signal
    );
  } catch (error) {
    return { eligible: true, projection: onProviderFailure(error) };
  }
  if (!read.ok) {
    return {
      eligible: true,
      projection: branchSelectedPullRequestChecksAccessUnavailable(
        read.error.reason,
        read.error.retryAfterSeconds
      ),
    };
  }
  if (
    read.value.status === SelectedPullRequestEvidenceAvailability.Unavailable
  ) {
    return {
      eligible: true,
      projection: branchSelectedPullRequestChecksEvidenceUnavailable(
        read.value
      ),
    };
  }
  if (!evidenceIdentityMatches(read.value.value, expected)) {
    return {
      eligible: true,
      projection: branchSelectedPullRequestChecksEvidenceUnavailable({
        status: SelectedPullRequestEvidenceAvailability.Unavailable,
        reason: evidenceIdentityMismatchReason(read.value.value, expected),
      }),
    };
  }
  return {
    eligible: true,
    projection: projectBranchSelectedPullRequestChecks(read.value.value),
  };
}

function acquireSelectedPullRequestChecks(
  organizationId: string,
  userId: string,
  context: SelectedPullRequestChecksContext,
  expected: ExpectedBranchSelectedPullRequest,
  signal?: AbortSignal
) {
  return runBranchViewRead(
    {
      organizationId,
      userId,
      target: { owner: context.owner, repo: context.repo },
    },
    (octokit) =>
      getSelectedPullRequestChecksEvidence(
        octokit,
        context.owner,
        context.repo,
        expected.pullRequestNumber,
        selectedPullRequestChecksAcquisitionOptions(signal)
      )
  );
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
        branch: { isNot: null },
      },
      select: selectedPullRequestChecksContextSelect,
    });
    if (!row?.branch) {
      return null;
    }
    const context = selectedPullRequestChecksContextFromRow(row, expected);
    if (!(await branchHasCloudEligibility(db, organizationId, branchId))) {
      return null;
    }
    return context;
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
      selectedPullRequestRepositoryFullName(row, detail) ===
        normalizeRepoFullName(expected.repositoryFullName)
  );
  const repositoryFullName = selected
    ? selectedPullRequestRepositoryFullName(row, selected)
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
  const identity = parseRepositoryFullName(repositoryFullName);
  return identity ? { matched: true, value: identity } : { matched: false };
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

const SELECTED_PULL_REQUEST_CHECKS_APPLICATION_TIMEOUT_MS = 50_000;
