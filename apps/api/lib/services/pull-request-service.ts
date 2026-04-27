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

/**
 * Per-type PR artifact service (Chunk 2a of PLN-321, decision #12).
 *
 * Centralises atomic create/update of PULL_REQUEST artifacts with their
 * PullRequestDetail row. All write APIs use nested Prisma writes
 * (`pullRequest: { create }` / `pullRequest: { update }`) so the parent
 * `Artifact` row and its detail row mutate together.
 *
 * Webhook handlers call into this service instead of hand-rolling
 * `tx.artifact.upsert` + `tx.pullRequestDetail.*` pairs.
 */

export type ArtifactWithPullRequestDetail = Artifact & {
  pullRequest: PullRequestDetail | null;
};

export type UpsertPullRequestArtifactInput = {
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
  workstreamId?: string | null;
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

const pullRequestInclude = { pullRequest: true } as const;

function runWithOptionalTx<T>(
  tx: TransactionClient | undefined,
  fn: (db: TransactionClient) => Promise<T>
): Promise<T> {
  if (tx) {
    return fn(tx);
  }
  return withDb.tx(fn);
}

/**
 * Create or update a PULL_REQUEST artifact + its PullRequestDetail row
 * atomically. Dedup key is `pullRequestDetail.githubId` (unique). If no row
 * exists for that githubId, a new artifact (with nested detail) is created.
 * Otherwise the existing artifact is updated through the detail's
 * `artifactId` PK.
 *
 * The caller may pass a `tx` to participate in an outer transaction. When
 * omitted, a dedicated `withDb.tx` is opened so the create-or-update stays
 * atomic.
 */
function buildPullRequestDetailCreate(
  input: UpsertPullRequestArtifactInput
): Prisma.PullRequestDetailUncheckedCreateWithoutArtifactInput {
  const create: Prisma.PullRequestDetailUncheckedCreateWithoutArtifactInput = {
    repositoryId: input.repositoryId,
    githubId: input.githubId,
    number: input.number,
    body: input.body ?? null,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch,
    headSha: input.headSha ?? null,
    prState: input.prState,
    isDraft: input.isDraft,
    closedAt: input.closedAt ?? null,
    mergedAt: input.mergedAt ?? null,
    mergeCommitSha: input.mergeCommitSha ?? null,
  };
  if (input.checksStatus !== undefined) {
    create.checksStatus = input.checksStatus;
  }
  if (input.reviewDecision !== undefined) {
    create.reviewDecision = input.reviewDecision;
  }
  return create;
}

function buildPullRequestDetailUpdate(
  input: UpsertPullRequestArtifactInput
): Prisma.PullRequestDetailUpdateWithoutArtifactInput {
  const update: Prisma.PullRequestDetailUpdateWithoutArtifactInput = {
    number: input.number,
    body: input.body ?? undefined,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch,
    headSha: input.headSha ?? undefined,
    prState: input.prState,
    isDraft: input.isDraft,
  };
  if (input.checksStatus !== undefined) {
    update.checksStatus = input.checksStatus;
  }
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
  artifactId: string,
  input: UpsertPullRequestArtifactInput
): Promise<ArtifactWithPullRequestDetail> {
  // Defence in depth: PullRequestDetail.githubId is globally unique, but
  // we still scope the mutation to the caller's org so a cross-org row
  // (e.g. from a reinstalled GitHub App with reused id) cannot be clobbered.
  // Artifact has no composite unique on (id, organizationId), so we combine
  // the two into an updateMany (atomic DB-level guard) and split the PR
  // detail update into its own call. Both run inside the caller's tx
  // (via runWithOptionalTx) so they commit atomically.
  const { count } = await db.artifact.updateMany({
    where: { id: artifactId, organizationId: input.organizationId },
    data: {
      name: input.title,
      status: input.prState,
      externalUrl: input.htmlUrl,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.workstreamId !== undefined
        ? { workstreamId: input.workstreamId }
        : {}),
    },
  });
  if (count === 0) {
    throw new Error(
      `Pull request artifact ${artifactId} not found in organization`
    );
  }

  // Detail update + re-read with include. Safe now that the parent row is
  // confirmed in-org — this update is scoped by the detail's artifactId PK
  // which is 1:1 with the parent we just mutated.
  await db.pullRequestDetail.update({
    where: { artifactId },
    data: buildPullRequestDetailUpdate(input),
  });

  const updated = await db.artifact.findUnique({
    where: { id: artifactId },
    include: pullRequestInclude,
  });
  return updated as ArtifactWithPullRequestDetail;
}

async function createPullRequest(
  db: TransactionClient,
  input: UpsertPullRequestArtifactInput
): Promise<ArtifactWithPullRequestDetail> {
  const created = await db.artifact.create({
    data: {
      type: ArtifactType.PULL_REQUEST,
      organizationId: input.organizationId,
      projectId: input.projectId,
      workstreamId: input.workstreamId ?? null,
      name: input.title,
      status: input.prState,
      externalUrl: input.htmlUrl,
      pullRequest: { create: buildPullRequestDetailCreate(input) },
    },
    include: pullRequestInclude,
  });
  return created as ArtifactWithPullRequestDetail;
}

function upsertPullRequestArtifact(
  input: UpsertPullRequestArtifactInput,
  tx?: TransactionClient
): Promise<ArtifactWithPullRequestDetail> {
  return runWithOptionalTx(tx, async (db) => {
    const existingDetail = await db.pullRequestDetail.findUnique({
      where: { githubId: input.githubId },
      select: { artifactId: true },
    });
    if (existingDetail) {
      return updateExistingPullRequest(db, existingDetail.artifactId, input);
    }
    return createPullRequest(db, input);
  });
}

/**
 * Look up a PR artifact + its detail by GitHub PR id within an organization.
 * Returns null when no matching row exists.
 */
async function findByGithubId(
  githubId: string,
  organizationId: string,
  tx?: TransactionClient
): Promise<ArtifactWithPullRequestDetail | null> {
  const exec = (db: TransactionClient) =>
    db.artifact.findFirst({
      where: {
        organizationId,
        type: ArtifactType.PULL_REQUEST,
        pullRequest: { githubId },
      },
      include: pullRequestInclude,
    });
  const artifact = await (tx ? exec(tx) : withDb(exec));
  return artifact as ArtifactWithPullRequestDetail | null;
}

/**
 * Look up a PR artifact + its detail by (repositoryId, number). The
 * underlying PullRequestDetail has a composite unique on these columns.
 */
async function findByRepositoryAndNumber(
  repositoryId: string,
  number: number,
  tx?: TransactionClient
): Promise<ArtifactWithPullRequestDetail | null> {
  const exec = async (db: TransactionClient) => {
    const detail = await db.pullRequestDetail.findUnique({
      where: { repositoryId_number: { repositoryId, number } },
      select: { artifactId: true },
    });
    if (!detail) {
      return null;
    }
    return db.artifact.findUnique({
      where: { id: detail.artifactId },
      include: pullRequestInclude,
    });
  };
  const artifact = await (tx ? exec(tx) : withDb(exec));
  return artifact as ArtifactWithPullRequestDetail | null;
}

/**
 * Update review/CI state fields on the PR detail. When `prState` is
 * provided, the parent `Artifact.status` is retargeted to carry the current
 * state string (parity with the existing webhook handlers).
 */
async function updateReviewState(
  artifactId: string,
  input: UpdateReviewStateInput,
  tx?: TransactionClient
): Promise<ArtifactWithPullRequestDetail> {
  const detailUpdate: Prisma.PullRequestDetailUpdateWithoutArtifactInput = {};
  if (input.checksStatus !== undefined) {
    detailUpdate.checksStatus = input.checksStatus;
  }
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

  const artifactData: Prisma.ArtifactUpdateInput = {
    pullRequest: { update: detailUpdate },
  };
  if (input.prState !== undefined) {
    artifactData.status = input.prState;
  }

  const exec = (db: TransactionClient) =>
    db.artifact.update({
      where: { id: artifactId },
      data: artifactData,
      include: pullRequestInclude,
    });
  const updated = await (tx ? exec(tx) : withDb.tx(exec));
  return updated as ArtifactWithPullRequestDetail;
}

/**
 * Convenience wrapper to persist a review decision without touching other
 * state fields.
 */
function recordReviewDecision(
  artifactId: string,
  reviewDecision: ReviewDecision | null,
  tx?: TransactionClient
): Promise<ArtifactWithPullRequestDetail> {
  return updateReviewState(artifactId, { reviewDecision }, tx);
}

export const pullRequestService = {
  upsertPullRequestArtifact,
  findByGithubId,
  findByRepositoryAndNumber,
  updateReviewState,
  recordReviewDecision,
};
