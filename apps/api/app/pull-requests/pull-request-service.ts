import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import {
  type Artifact,
  ArtifactType,
  type ChecksStatus,
  type GitHubPRState,
  type Prisma,
  type PullRequestDetail,
  type ReviewDecision,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { invalidateBranchStatusChecksForHeadChange } from "@/lib/branch-status-checks";

/**
 * PR artifact service. Owns CRUD on BRANCH artifacts and their
 * 1:1 PullRequestDetail rows.
 *
 * Writes use nested Prisma writes (`pullRequest: { create }` /
 * `pullRequest: { update }`) so the parent `Artifact` row and its detail row
 * mutate together. Webhook handlers call into this service instead of
 * hand-rolling `tx.artifact.upsert` + `tx.pullRequestDetail.*` pairs.
 *
 * When a caller is already inside `withDb.tx`, the inner `withDb` /
 * `withDb.tx` calls below automatically participate in that transaction via
 * AsyncLocalStorage — no `tx` parameter threading is needed.
 *
 * Fallible writes return `Result<T, StatusCode>` so routes can map failures
 * to non-500 HTTP statuses without try/catch boilerplate.
 */

export type ArtifactWithPullRequestDetail = Artifact & {
  pullRequest: PullRequestDetail | null;
};

export type UpsertBranchArtifactInput = {
  organizationId: string;
  repositoryId: string;
  githubId: string;
  number: number;
  title: string;
  body?: string | null;
  htmlUrl: string;
  headBranch: string;
  baseBranch: string;
  headSha?: string | null;
  prState: GitHubPRState;
  isDraft: boolean;
  checksStatus?: ChecksStatus;
  reviewDecision?: ReviewDecision | null;
  projectId: string;
  closedAt?: Date | null;
  mergedAt?: Date | null;
  mergeCommitSha?: string | null;
};

export type UpdateReviewStateInput = {
  checksStatus?: ChecksStatus;
  reviewDecision?: ReviewDecision | null;
  prState?: GitHubPRState;
  mergedAt?: Date | null;
  closedAt?: Date | null;
  mergeCommitSha?: string | null;
};

export type ListPullRequestsInput = {
  organizationId: string;
  projectId?: string;
  prState?: GitHubPRState;
};

const pullRequestInclude = {
  pullRequest: true,
  branch: { include: { currentPullRequestDetail: true } },
} as const;
const githubPullRequestUrlPattern = /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/;

function buildBranchTreeUrl(prUrl: string, branchName: string): string {
  const match = githubPullRequestUrlPattern.exec(prUrl);
  if (!match) {
    return prUrl;
  }
  const [, owner, repo] = match;
  return `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(
    branchName
  )}`;
}

function buildPullRequestDetailCreate(
  input: UpsertBranchArtifactInput
): Prisma.PullRequestDetailUncheckedCreateWithoutBranchArtifactInput {
  const create: Prisma.PullRequestDetailUncheckedCreateWithoutBranchArtifactInput =
    {
      repositoryId: input.repositoryId,
      githubId: input.githubId,
      number: input.number,
      title: input.title,
      htmlUrl: input.htmlUrl,
      body: input.body ?? null,
      prState: input.prState,
      isDraft: input.isDraft,
      isCurrent: true,
      closedAt: input.closedAt ?? null,
      mergedAt: input.mergedAt ?? null,
      mergeCommitSha: input.mergeCommitSha ?? null,
    };
  if (input.reviewDecision !== undefined) {
    create.reviewDecision = input.reviewDecision;
  }
  return create;
}

function buildPullRequestDetailUpdate(
  input: UpsertBranchArtifactInput
): Prisma.PullRequestDetailUpdateInput {
  const update: Prisma.PullRequestDetailUpdateInput = {
    number: input.number,
    title: input.title,
    htmlUrl: input.htmlUrl,
    body: input.body ?? undefined,
    prState: input.prState,
    isDraft: input.isDraft,
  };
  if (input.reviewDecision !== undefined) {
    update.reviewDecision = input.reviewDecision;
  }
  if (input.closedAt !== undefined) {
    update.closedAt = input.closedAt;
  }
  if (input.mergedAt !== undefined) {
    update.mergedAt = input.mergedAt;
  }
  if (input.mergeCommitSha !== undefined) {
    update.mergeCommitSha = input.mergeCommitSha;
  }
  return update;
}

async function updateExistingPullRequest(
  db: TransactionClient,
  branchArtifactId: string,
  pullRequestDetailId: string,
  input: UpsertBranchArtifactInput
): Promise<Result<ArtifactWithPullRequestDetail, StatusCode>> {
  // Defence in depth: PullRequestDetail.githubId is globally unique, but
  // we still scope the mutation to the caller's org so a cross-org row
  // (e.g. from a reinstalled GitHub App with reused id) cannot be clobbered.
  // Artifact has no composite unique on (id, organizationId), so we combine
  // the two into an updateMany (atomic DB-level guard) and split the PR
  // detail update into its own call. Both run inside the same transaction
  // (the enclosing withDb.tx) so they commit atomically.
  const { count } = await db.artifact.updateMany({
    where: { id: branchArtifactId, organizationId: input.organizationId },
    data: {
      name: input.headBranch,
      status: input.prState,
      externalUrl: buildBranchTreeUrl(input.htmlUrl, input.headBranch),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
  });
  if (count === 0) {
    return Result.err(Status.NotFound);
  }

  const previousBranch = await db.branchDetail.findUnique({
    where: { artifactId: branchArtifactId },
    select: { headSha: true },
  });

  await db.branchDetail.update({
    where: { artifactId: branchArtifactId },
    data: {
      branchName: input.headBranch,
      baseBranch: input.baseBranch,
      baseBranchSource: BranchBaseBranchSource.PullRequestBase,
      headSha: input.headSha ?? null,
      headShaSource: input.headSha
        ? BranchHeadShaSource.PullRequestWebhook
        : null,
      ...(input.checksStatus === undefined
        ? {}
        : { checksStatus: input.checksStatus }),
    },
  });
  if (previousBranch?.headSha !== (input.headSha ?? null)) {
    await invalidateBranchStatusChecksForHeadChange(db, branchArtifactId);
  }

  // Detail update + re-read with include. Safe now that the parent row is
  // confirmed in-org; branch identity/status is stored on BranchDetail.
  await db.pullRequestDetail.update({
    where: { id: pullRequestDetailId },
    data: buildPullRequestDetailUpdate(input),
  });

  const updated = (await db.artifact.findUnique({
    where: { id: branchArtifactId },
    include: pullRequestInclude,
  })) as ArtifactWithPullRequestDetail;
  return Result.ok(updated);
}

async function createPullRequest(
  db: TransactionClient,
  input: UpsertBranchArtifactInput
): Promise<ArtifactWithPullRequestDetail> {
  const created = await db.artifact.create({
    data: {
      type: ArtifactType.BRANCH,
      organizationId: input.organizationId,
      projectId: input.projectId,
      name: input.headBranch,
      status: input.prState,
      externalUrl: buildBranchTreeUrl(input.htmlUrl, input.headBranch),
      branch: {
        create: {
          repositoryId: input.repositoryId,
          branchName: input.headBranch,
          baseBranch: input.baseBranch,
          baseBranchSource: BranchBaseBranchSource.PullRequestBase,
          headSha: input.headSha ?? null,
          headShaSource: input.headSha
            ? BranchHeadShaSource.PullRequestWebhook
            : null,
          ...(input.checksStatus === undefined
            ? {}
            : { checksStatus: input.checksStatus }),
        },
      },
      pullRequestDetails: { create: buildPullRequestDetailCreate(input) },
    },
    include: pullRequestInclude,
  });
  const currentDetailId = created.branch?.currentPullRequestDetail?.id ?? null;
  const detail = currentDetailId
    ? { id: currentDetailId }
    : await db.pullRequestDetail.findUnique({
        where: { githubId: input.githubId },
        select: { id: true },
      });
  if (detail && currentDetailId !== detail.id) {
    await db.branchDetail.update({
      where: { artifactId: created.id },
      data: { currentPullRequestDetailId: detail.id },
    });
  }

  const reread = await db.artifact.findUnique({
    where: { id: created.id },
    include: pullRequestInclude,
  });
  return (reread ?? created) as ArtifactWithPullRequestDetail;
}

/**
 * Create or update a BRANCH artifact + its PullRequestDetail row
 * atomically. Dedup key is `pullRequestDetail.githubId` (unique). If no row
 * exists for that githubId, a new artifact (with nested detail) is created.
 * Otherwise the existing artifact is updated through the detail's
 * `artifactId` PK.
 *
 * Returns `Result.err(Status.NotFound)` when an existing detail row points
 * to a parent artifact that does not belong to the caller's organization
 * (defence-in-depth against cross-org GitHub PR id collisions).
 */
function upsertBranchArtifact(
  input: UpsertBranchArtifactInput
): Promise<Result<ArtifactWithPullRequestDetail, StatusCode>> {
  return withDb.tx(async (db) => {
    const existingDetail = await db.pullRequestDetail.findUnique({
      where: { githubId: input.githubId },
      select: { id: true, artifactId: true, branchArtifactId: true },
    });
    if (existingDetail) {
      const branchArtifactId =
        existingDetail.branchArtifactId ?? existingDetail.artifactId;
      if (!branchArtifactId) {
        return Result.err(Status.NotFound);
      }
      return updateExistingPullRequest(
        db,
        branchArtifactId,
        existingDetail.id,
        input
      );
    }
    const created = await createPullRequest(db, input);
    return Result.ok(created);
  });
}

/**
 * Find a single PR artifact + its detail by id within an organization.
 * Returns null when no matching row exists.
 */
async function findById(
  id: string,
  organizationId: string
): Promise<ArtifactWithPullRequestDetail | null> {
  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: { id, organizationId, type: ArtifactType.BRANCH },
      include: pullRequestInclude,
    })
  );
  return artifact as ArtifactWithPullRequestDetail | null;
}

/**
 * List PR artifacts within an organization, optionally scoped by project or
 * PR state.
 */
async function list(
  options: ListPullRequestsInput
): Promise<ArtifactWithPullRequestDetail[]> {
  const { organizationId, projectId, prState } = options;
  const artifacts = await withDb((db) =>
    db.artifact.findMany({
      where: {
        organizationId,
        type: ArtifactType.BRANCH,
        ...(projectId ? { projectId } : {}),
        ...(prState
          ? { pullRequestDetails: { some: { prState, isCurrent: true } } }
          : {}),
      },
      include: pullRequestInclude,
      orderBy: { createdAt: "desc" },
    })
  );
  return artifacts as ArtifactWithPullRequestDetail[];
}

/**
 * Hard-delete a PR artifact. The parent `artifact` row is the system of
 * record; PullRequestDetail and ArtifactLink rows that reference it cascade
 * automatically (see schema: `onDelete: Cascade`).
 *
 * Returns `Status.NotFound` when no PR artifact with this id exists in the
 * caller's organization.
 */
async function deletePullRequest(
  id: string,
  organizationId: string
): Promise<Result<void, StatusCode>> {
  const { count } = await withDb((db) =>
    db.artifact.deleteMany({
      where: { id, organizationId, type: ArtifactType.BRANCH },
    })
  );
  if (count === 0) {
    return Result.err(Status.NotFound);
  }
  return Result.ok(undefined);
}

/**
 * Look up a PR artifact + its detail by GitHub PR id within an organization.
 * Returns null when no matching row exists.
 */
async function findByGithubId(
  githubId: string,
  organizationId: string
): Promise<ArtifactWithPullRequestDetail | null> {
  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: {
        organizationId,
        type: ArtifactType.BRANCH,
        pullRequestDetails: { some: { githubId } },
      },
      include: pullRequestInclude,
    })
  );
  return artifact as ArtifactWithPullRequestDetail | null;
}

/**
 * Look up a PR artifact + its detail by (repositoryId, number). The
 * underlying PullRequestDetail has a composite unique on these columns.
 */
async function findByRepositoryAndNumber(
  repositoryId: string,
  number: number
): Promise<ArtifactWithPullRequestDetail | null> {
  const artifact = await withDb(async (db) => {
    const detail = await db.pullRequestDetail.findUnique({
      where: { repositoryId_number: { repositoryId, number } },
      select: { artifactId: true, branchArtifactId: true },
    });
    if (!detail) {
      return null;
    }
    const branchArtifactId = detail.branchArtifactId ?? detail.artifactId;
    if (!branchArtifactId) {
      return null;
    }
    return db.artifact.findUnique({
      where: { id: branchArtifactId },
      include: pullRequestInclude,
    });
  });
  return artifact as ArtifactWithPullRequestDetail | null;
}

/**
 * Update review/CI state fields on the PR detail. When `prState` is
 * provided, the parent `Artifact.status` is retargeted to carry the current
 * state string (parity with the existing webhook handlers).
 */
async function updateReviewState(
  id: string,
  organizationId: string,
  input: UpdateReviewStateInput
): Promise<ArtifactWithPullRequestDetail> {
  const detailUpdate: Prisma.PullRequestDetailUpdateInput = {};
  if (input.reviewDecision !== undefined) {
    detailUpdate.reviewDecision = input.reviewDecision;
  }
  if (input.prState !== undefined) {
    detailUpdate.prState = input.prState;
  }
  if (input.mergedAt !== undefined) {
    detailUpdate.mergedAt = input.mergedAt;
  }
  if (input.closedAt !== undefined) {
    detailUpdate.closedAt = input.closedAt;
  }
  if (input.mergeCommitSha !== undefined) {
    detailUpdate.mergeCommitSha = input.mergeCommitSha;
  }

  const artifactData: Prisma.ArtifactUpdateInput = {};
  if (input.prState !== undefined) {
    artifactData.status = input.prState;
  }

  const updated = await withDb.tx(async (db) => {
    if (input.checksStatus !== undefined) {
      await db.branchDetail.update({
        where: { artifactId: id },
        data: { checksStatus: input.checksStatus },
      });
    }
    if (Object.keys(detailUpdate).length > 0) {
      await db.pullRequestDetail.updateMany({
        where: { branchArtifactId: id, isCurrent: true },
        data: detailUpdate,
      });
    }
    return db.artifact.update({
      where: { id, organizationId },
      data: artifactData,
      include: pullRequestInclude,
    });
  });
  return updated;
}

/**
 * Convenience wrapper to persist a review decision without touching other
 * state fields.
 */
function recordReviewDecision(
  id: string,
  organizationId: string,
  reviewDecision: ReviewDecision | null
): Promise<ArtifactWithPullRequestDetail> {
  return updateReviewState(id, organizationId, { reviewDecision });
}

export const pullRequestService = {
  upsertBranchArtifact,
  findById,
  list,
  delete: deletePullRequest,
  findByGithubId,
  findByRepositoryAndNumber,
  updateReviewState,
  recordReviewDecision,
};
