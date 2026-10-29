import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type { TransactionClient } from "@repo/database";
import { relinkPullRequestComments } from "@/app/comments/service/github/relink-pull-request-comments";
import { lockPullRequestActivityIdentityInTransaction } from "./pull-request-branch-relink";
import { acquirePullRequestProviderIdentityLockInTransaction } from "./pull-request-provider-lock";
import { relinkPullRequestSessionLinksInTransaction } from "./pull-request-session-link-relink";

/**
 * Converge every compatible App/Desktop row for one provider-independent PR
 * identity under the canonical cross-writer lock. Contradictory coordinates
 * fail before any dependent row is mutated.
 */
export async function reconcilePullRequestProviderIdentityInTransaction(
  tx: ProviderIdentityClient,
  input: {
    organizationId: string;
    repositoryId: string;
    repositoryFullName: string;
    githubId: string;
    number: number;
  }
): Promise<string | null> {
  const repositoryFullName = normalizeRepoFullName(input.repositoryFullName);
  await acquirePullRequestProviderIdentityLockInTransaction(tx, {
    organizationId: input.organizationId,
    repositoryFullName,
    number: input.number,
  });
  const rows = await loadProviderIdentityRows(tx, {
    ...input,
    repositoryFullName,
  });
  assertCompatibleProviderCoordinates(rows, {
    repositoryId: input.repositoryId,
    repositoryFullName,
    githubId: input.githubId,
  });
  const [canonical, ...duplicates] = [...rows].sort(compareProviderAuthority);
  if (!canonical) {
    return null;
  }
  const adopted = await tx.pullRequestDetail.updateMany({
    where: {
      id: canonical.id,
      organizationId: input.organizationId,
      number: input.number,
      repositoryId: canonical.repositoryId,
      githubId: canonical.githubId,
    },
    data: {
      repositoryId: input.repositoryId,
      repositoryFullName,
      githubId: input.githubId,
    },
  });
  if (adopted.count !== 1) {
    throw new Error("pull request provider identity changed during adoption");
  }
  await tx.branchDetail.updateMany({
    where: {
      artifactId: canonical.branchArtifactId,
      organizationId: input.organizationId,
      repositoryId: null,
    },
    data: { repositoryId: input.repositoryId },
  });
  const authoritative: ProviderIdentityRow = {
    ...canonical,
    repositoryId: input.repositoryId,
    repositoryFullName,
    githubId: input.githubId,
  };
  for (const duplicate of duplicates) {
    await collapsePullRequestDuplicate(
      tx,
      input.organizationId,
      authoritative,
      duplicate
    );
  }
  return authoritative.id;
}

function loadProviderIdentityRows(
  tx: ProviderIdentityClient,
  input: {
    organizationId: string;
    repositoryId: string;
    repositoryFullName: string;
    githubId: string;
    number: number;
  }
): Promise<ProviderIdentityRow[]> {
  return tx.pullRequestDetail.findMany({
    where: {
      organizationId: input.organizationId,
      number: input.number,
      OR: [
        { githubId: input.githubId },
        { repositoryId: input.repositoryId },
        {
          repositoryId: null,
          repositoryFullName: input.repositoryFullName,
        },
      ],
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      branchArtifactId: true,
      githubId: true,
      repositoryId: true,
      repositoryFullName: true,
      number: true,
    },
  });
}

function assertCompatibleProviderCoordinates(
  rows: readonly ProviderIdentityRow[],
  expected: {
    repositoryId: string;
    repositoryFullName: string;
    githubId: string;
  }
): void {
  const conflict = rows.some((row) => {
    const storedRepositoryFullName = row.repositoryFullName
      ? normalizeRepoFullName(row.repositoryFullName)
      : null;
    return (
      (row.repositoryId !== null &&
        row.repositoryId !== expected.repositoryId) ||
      (row.githubId !== null && row.githubId !== expected.githubId) ||
      (storedRepositoryFullName !== null &&
        storedRepositoryFullName !== expected.repositoryFullName)
    );
  });
  if (conflict) {
    throw new Error("pull request provider identity conflict");
  }
}

function compareProviderAuthority(
  left: ProviderIdentityRow,
  right: ProviderIdentityRow
): number {
  return (
    providerAuthorityRank(left) - providerAuthorityRank(right) ||
    left.id.localeCompare(right.id)
  );
}

function providerAuthorityRank(row: ProviderIdentityRow): number {
  if (row.repositoryId && row.githubId) {
    return 0;
  }
  if (row.repositoryId) {
    return 1;
  }
  if (row.githubId) {
    return 2;
  }
  return 3;
}

async function collapsePullRequestDuplicate(
  tx: ProviderIdentityClient,
  organizationId: string,
  canonical: ProviderIdentityRow,
  duplicate: ProviderIdentityRow
): Promise<void> {
  for (const pullRequestDetailId of [canonical.id, duplicate.id].sort()) {
    await lockPullRequestActivityIdentityInTransaction(
      tx,
      organizationId,
      pullRequestDetailId
    );
  }
  await relinkPullRequestSessionLinksInTransaction(tx, {
    organizationId,
    repositoryFullName: canonical.repositoryFullName,
    pullRequestNumber: canonical.number,
    sourceBranchArtifactIds:
      duplicate.branchArtifactId === canonical.branchArtifactId
        ? []
        : [duplicate.branchArtifactId],
    targetBranchArtifactId: canonical.branchArtifactId,
  });
  await tx.branchActivityAtom.updateMany({
    where: {
      organizationId,
      pullRequestDetailId: duplicate.id,
    },
    data: { pullRequestDetailId: canonical.id },
  });
  await movePullRequestReviews(tx, organizationId, canonical.id, duplicate.id);
  await relinkPullRequestComments(tx, {
    organizationId,
    sourcePullRequestDetailId: duplicate.id,
    targetPullRequestDetailId: canonical.id,
    targetBranchArtifactId: canonical.branchArtifactId,
  });
  await tx.branchDetail.updateMany({
    where: {
      organizationId,
      currentPullRequestDetailId: duplicate.id,
    },
    data: { currentPullRequestDetailId: null },
  });
  const removed = await tx.pullRequestDetail.deleteMany({
    where: { id: duplicate.id, organizationId },
  });
  if (removed.count !== 1) {
    throw new Error("pull request duplicate changed during convergence");
  }
}

async function movePullRequestReviews(
  tx: ProviderIdentityClient,
  organizationId: string,
  canonicalId: string,
  duplicateId: string
): Promise<void> {
  const [canonicalReviews, duplicateReviews] = await Promise.all([
    tx.gitHubPRReview.findMany({
      where: {
        pullRequestId: canonicalId,
        pullRequestDetail: { organizationId },
      },
      select: convergenceReviewSelect,
    }),
    tx.gitHubPRReview.findMany({
      where: {
        pullRequestId: duplicateId,
        pullRequestDetail: { organizationId },
      },
      select: convergenceReviewSelect,
    }),
  ]);
  for (const review of duplicateReviews) {
    const existing = canonicalReviews.find(
      (candidate) => candidate.authorLogin === review.authorLogin
    );
    if (existing) {
      if (!sameReview(existing, review)) {
        throw new Error("pull request review convergence conflict");
      }
      const removed = await tx.gitHubPRReview.deleteMany({
        where: {
          id: review.id,
          pullRequestDetail: { organizationId },
        },
      });
      if (removed.count !== 1) {
        throw new Error("pull request review changed during convergence");
      }
      continue;
    }
    const moved = await tx.gitHubPRReview.updateMany({
      where: {
        id: review.id,
        pullRequestId: duplicateId,
        pullRequestDetail: { organizationId },
      },
      data: { pullRequestId: canonicalId },
    });
    if (moved.count !== 1) {
      throw new Error("pull request review changed during convergence");
    }
  }
}

function sameReview(left: ComparableReview, right: ComparableReview): boolean {
  return (
    left.githubReviewId === right.githubReviewId &&
    left.authorLogin === right.authorLogin &&
    left.state === right.state &&
    left.body === right.body &&
    left.htmlUrl === right.htmlUrl &&
    left.submittedAt.getTime() === right.submittedAt.getTime()
  );
}

type ProviderIdentityClient = Pick<
  TransactionClient,
  | "$executeRaw"
  | "artifactLink"
  | "branchActivityAtom"
  | "branchDetail"
  | "commentThread"
  | "gitHubCommentProjection"
  | "gitHubCommentThreadProjection"
  | "gitHubPRReview"
  | "pullRequestDetail"
>;

type ProviderIdentityRow = {
  id: string;
  branchArtifactId: string;
  githubId: string | null;
  repositoryId: string | null;
  repositoryFullName: string | null;
  number: number;
};

type ComparableReview = {
  githubReviewId: string;
  authorLogin: string;
  state: string;
  body: string | null;
  htmlUrl: string;
  submittedAt: Date;
};

/**
 * Everything `sameReview` compares, plus the `id` the delete/move branches key
 * on — and nothing else, so a row read from the canonical PR and a row read
 * from the duplicate are the same shape by construction.
 *
 * ONE constant for both sides is load-bearing rather than tidy: these two reads
 * are compared field-for-field against each other, and a column present on one
 * side only would make `sameReview` throw a convergence conflict for two rows
 * that are in fact identical, or accept two that are not. The `satisfies`
 * bound means dropping a compared column fails the build here rather than
 * turning into a silently-equal `undefined === undefined` at the comparison.
 */
const convergenceReviewSelect = {
  id: true,
  githubReviewId: true,
  authorLogin: true,
  state: true,
  body: true,
  htmlUrl: true,
  submittedAt: true,
} as const satisfies Record<keyof ComparableReview | "id", true>;
