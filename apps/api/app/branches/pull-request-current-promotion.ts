import type { TransactionClient } from "@repo/database";
import { isProviderAuthoritativePullRequest } from "./pull-request-provider-authority";

export type PromoteBranchCurrentPullRequestOptions = {
  onlyWhenCurrentMissingOrStub?: boolean;
};

/**
 * Point a branch at a PR row unless a provider-authoritative current row wins.
 * The optional stub guard is for targeted tier-2 reconciliation: it may reveal
 * an existing session-linked PR only when the branch has no current pointer or
 * the pointer is still an empty non-App stub.
 */
export async function promoteBranchCurrentPullRequest(
  db: TransactionClient,
  input: {
    organizationId: string;
    branchArtifactId: string;
    pullRequestDetailId: string;
  },
  options: PromoteBranchCurrentPullRequestOptions = {}
): Promise<boolean> {
  const branch = await db.branchDetail.findUnique({
    where: {
      organizationId_artifactId: {
        organizationId: input.organizationId,
        artifactId: input.branchArtifactId,
      },
    },
    select: { currentPullRequestDetailId: true },
  });
  if (!branch) {
    throw new Error("branch detail missing for pull request promotion");
  }
  const currentId = branch.currentPullRequestDetailId ?? null;
  if (currentId && currentId !== input.pullRequestDetailId) {
    const current = await db.pullRequestDetail.findFirst({
      where: { id: currentId, organizationId: input.organizationId },
      select: {
        fetchMechanism: true,
        githubId: true,
        additions: true,
        deletions: true,
        changedFiles: true,
      },
    });
    // ISS-8522 widened this gate deliberately. The predicate it replaced only
    // honored `githubId` when `fetchMechanism` was null, so a githubId-bearing
    // row stamped with a non-App mechanism was promotable away; the desktop
    // gate one file over already refused that same row. Both now answer from
    // one predicate, and the disagreement resolves toward refusing — webhook
    // -wins can only be granted in more cases here, never fewer.
    if (isProviderAuthoritativePullRequest(current)) {
      return false;
    }
    if (
      options.onlyWhenCurrentMissingOrStub &&
      current &&
      !isEmptyPullRequestStub(current)
    ) {
      return false;
    }
  }

  const pointed = await db.branchDetail.updateMany({
    where: {
      artifactId: input.branchArtifactId,
      organizationId: input.organizationId,
      currentPullRequestDetailId: currentId,
    },
    data: { currentPullRequestDetailId: input.pullRequestDetailId },
  });
  if (pointed.count !== 1) {
    return false;
  }

  const promoted = await db.pullRequestDetail.updateMany({
    where: {
      id: input.pullRequestDetailId,
      organizationId: input.organizationId,
      branchArtifactId: input.branchArtifactId,
    },
    data: { isCurrent: true },
  });
  if (promoted.count !== 1) {
    throw new Error(PULL_REQUEST_CURRENT_OWNER_CHANGED_MESSAGE);
  }

  await db.pullRequestDetail.updateMany({
    where: {
      organizationId: input.organizationId,
      branchArtifactId: input.branchArtifactId,
      isCurrent: true,
      id: { not: input.pullRequestDetailId },
    },
    data: { isCurrent: false },
  });
  return true;
}

export function isEmptyPullRequestStub(current: {
  fetchMechanism: string | null;
  githubId: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}): boolean {
  return (
    current.fetchMechanism === null &&
    current.githubId === null &&
    current.additions === null &&
    current.deletions === null &&
    current.changedFiles === null
  );
}

/** Error text used when promotion must roll back after its target row moved. */
export const PULL_REQUEST_CURRENT_OWNER_CHANGED_MESSAGE =
  "pull request current owner changed";

/** Classify the stale-target rollback that targeted reconciliation may retry later. */
export function isPullRequestCurrentOwnerChangedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === PULL_REQUEST_CURRENT_OWNER_CHANGED_MESSAGE
  );
}
