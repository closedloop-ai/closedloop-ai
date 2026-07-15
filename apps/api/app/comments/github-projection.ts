import {
  GitHubCommentThreadKind,
  type GitHubDiffSide,
  GitHubLegacyCommentState,
  type Prisma,
  ThreadSource,
  ThreadStatus,
  type TransactionClient,
} from "@repo/database";
import { getPrismaErrorCode, getPrismaP2002Target } from "@/lib/db-utils";
import {
  type GitHubFetchProvenance,
  gitHubFetchProvenanceData,
} from "@/lib/github-fetch-provenance";

type GitHubProjectionDb = Pick<
  TransactionClient,
  | "comment"
  | "commentThread"
  | "gitHubCommentProjection"
  | "gitHubCommentThreadProjection"
>;

export type GitHubProjectionAuthorInput = {
  userId: string;
  /**
   * FEA-1195 provider-author identity for the exact GitHub actor that authored
   * this comment. Generic Comment rows keep the resolved platform user id;
   * GitHub projection rows persist this id so branch-view display never has to
   * guess among multiple provider identities mapped to the same user.
   */
  externalAuthorId?: string | null;
};

export type GitHubProjectionCommentInput = {
  githubCommentId: string | number;
  githubInReplyToCommentId?: string | number | null;
  githubHtmlUrl?: string | null;
  githubUpdatedAt?: Date | null;
  bodyMarkdown: string;
  author: GitHubProjectionAuthorInput;
  createdAt: Date;
};

export type BaseGitHubThreadProjectionInput = {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  htmlUrl?: string | null;
  legacyState?: GitHubLegacyCommentState | null;
  /**
   * Explicit authoritative resolution state from a source that owns review
   * thread resolution. `legacyState` is only a provider label/compat field.
   */
  resolutionStatus?: ThreadStatus | null;
  resolvable?: boolean;
  lastSyncedAt?: Date | null;
  fetchProvenance?: GitHubFetchProvenance;
};

export type UpsertGitHubIssueCommentThreadInput =
  BaseGitHubThreadProjectionInput & {
    comment: GitHubProjectionCommentInput;
  };

export type UpsertGitHubReviewCommentThreadInput =
  BaseGitHubThreadProjectionInput & {
    reviewThreadId?: string | null;
    reviewId?: string | null;
    rootCommentId: string | number;
    path?: string | null;
    line?: number | null;
    side?: GitHubDiffSide | null;
    startLine?: number | null;
    startSide?: GitHubDiffSide | null;
    commitSha?: string | null;
    comments: GitHubProjectionCommentInput[];
  };

type SoftDeleteGitHubCommentProjectionInput = {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  threadKind: GitHubCommentThreadKind;
  liveGithubCommentIds: ReadonlySet<string | number>;
  deletedAt: Date;
  fetchProvenance?: GitHubFetchProvenance;
};

type SoftDeleteScopedGitHubCommentProjectionInput = {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  githubCommentId: string | number;
  deletedAt: Date;
  fetchProvenance?: GitHubFetchProvenance;
};

type SoftDeleteGitHubCommentByRemoteIdInput =
  SoftDeleteScopedGitHubCommentProjectionInput & {
    threadKind: GitHubCommentThreadKind;
  };

type UpsertGitHubProjectionResult = {
  threadId: string;
  commentIds: string[];
  /**
   * Remote GitHub ids whose generic Comment row was created by this call.
   * Webhook callers use this as the atomic first-delivery signal for one-time
   * side effects; duplicate deliveries that race on `externalId` do not appear.
   */
  createdGithubCommentIds: string[];
};

export type GitHubReviewThreadResolutionProjection =
  | {
      status: typeof GitHubReviewThreadResolutionProjectionStatus.Eligible;
      threadId: string;
      threadExternalId: string;
    }
  | {
      status: Exclude<
        GitHubReviewThreadResolutionProjectionStatus,
        typeof GitHubReviewThreadResolutionProjectionStatus.Eligible
      >;
    };

export const GitHubReviewThreadResolutionProjectionStatus = {
  Eligible: "eligible",
  UnknownReviewThread: "unknown_review_thread",
  AmbiguousReviewThread: "ambiguous_review_thread",
  WrongScope: "wrong_scope",
} as const;
export type GitHubReviewThreadResolutionProjectionStatus =
  (typeof GitHubReviewThreadResolutionProjectionStatus)[keyof typeof GitHubReviewThreadResolutionProjectionStatus];

const GitHubProjectionNoWriteCode = {
  AmbiguousThreadProjection: "ambiguous_thread_projection",
  ExternalIdConflict: "external_id_conflict",
} as const;
export type GitHubProjectionNoWriteCode =
  (typeof GitHubProjectionNoWriteCode)[keyof typeof GitHubProjectionNoWriteCode];

/**
 * Typed projection preflight failure raised before mutating any unified comment
 * rows. Producer paths catch this when a GitHub remote id cannot be mapped to a
 * single organization/branch/current-PR scoped projection.
 */
export class GitHubProjectionNoWriteError extends Error {
  readonly code: GitHubProjectionNoWriteCode;
  readonly details: Record<string, string | number | null>;

  constructor(
    code: GitHubProjectionNoWriteCode,
    details: Record<string, string | number | null>
  ) {
    super(`GitHub comment projection no-write: ${code}`);
    this.name = "GitHubProjectionNoWriteError";
    this.code = code;
    this.details = details;
  }
}

export class GitHubCommentProjectionScopeCollisionError extends GitHubProjectionNoWriteError {
  constructor(githubCommentId: string) {
    super(GitHubProjectionNoWriteCode.ExternalIdConflict, {
      githubCommentId,
    });
    this.name = "GitHubCommentProjectionScopeCollisionError";
  }
}

/**
 * Upsert one GitHub issue comment into the shared comment projection tables.
 * The remote GitHub comment id is mandatory because branch-view serialization
 * must never synthesize public ids from local Comment ids.
 */
export async function upsertGitHubIssueCommentThread(
  tx: GitHubProjectionDb,
  input: UpsertGitHubIssueCommentThreadInput
): Promise<UpsertGitHubProjectionResult> {
  const githubCommentId = requireRemoteCommentId(input.comment.githubCommentId);

  await assertScopedGitHubCommentExternalIdAvailable(tx, {
    organizationId: input.organizationId,
    branchArtifactId: input.branchArtifactId,
    pullRequestDetailId: input.pullRequestDetailId,
    threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
    githubCommentId,
  });

  return await upsertGitHubThread(tx, {
    ...input,
    threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
    rootCommentId: githubCommentId,
    reviewThreadId: null,
    reviewId: null,
    path: null,
    line: null,
    side: null,
    startLine: null,
    startSide: null,
    commitSha: null,
    comments: [input.comment],
    resolvable: false,
  });
}

/**
 * Upsert one GitHub review thread and its comments into the shared projection
 * tables. Callers provide already-resolved FEA-1195 author user ids.
 */
export async function upsertGitHubReviewCommentThread(
  tx: GitHubProjectionDb,
  input: UpsertGitHubReviewCommentThreadInput
): Promise<UpsertGitHubProjectionResult> {
  if (input.comments.length === 0) {
    throw new Error("GitHub review thread requires at least one comment");
  }

  return await upsertGitHubThread(tx, {
    ...input,
    threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
    rootCommentId: requireRemoteCommentId(input.rootCommentId),
    resolvable: input.resolvable ?? true,
  });
}

/**
 * Soft-delete stale unified GitHub projection rows for a current branch PR.
 * This intentionally updates rows one by one and only touches unified comment
 * projection storage.
 */
export async function softDeleteGitHubCommentProjection(
  tx: GitHubProjectionDb,
  input: SoftDeleteGitHubCommentProjectionInput
): Promise<{ comments: number; threads: number }> {
  const liveIds = new Set(
    [...input.liveGithubCommentIds].map((id) => requireRemoteCommentId(id))
  );

  const staleComments = await tx.gitHubCommentProjection.findMany({
    where: {
      githubCommentId:
        liveIds.size > 0 ? { notIn: [...liveIds], not: null } : { not: null },
      githubDeletedAt: null,
      threadProjection: {
        ...scopedThreadProjectionWhere(input),
        threadKind: input.threadKind,
      },
      comment: {
        deletedAt: null,
        thread: {
          organizationId: input.organizationId,
          artifactId: input.branchArtifactId,
          source: ThreadSource.GITHUB,
        },
      },
    },
    select: { commentId: true, threadId: true },
  });

  for (const row of staleComments) {
    await tx.gitHubCommentProjection.update({
      where: { commentId: row.commentId },
      data: {
        githubDeletedAt: input.deletedAt,
        ...gitHubFetchProvenanceData(input.fetchProvenance),
      },
    });
    await tx.comment.update({
      where: { id: row.commentId },
      data: { deletedAt: input.deletedAt },
    });
  }

  const activeThreads = await tx.gitHubCommentThreadProjection.findMany({
    where: {
      ...scopedThreadProjectionWhere(input),
      threadKind: input.threadKind,
    },
    select: {
      threadId: true,
      commentProjections: {
        where: {
          githubCommentId: { not: null },
          githubDeletedAt: null,
          comment: { deletedAt: null },
        },
        select: { githubCommentId: true },
      },
    },
  });

  let threads = 0;
  for (const thread of activeThreads) {
    const hasLiveComment = thread.commentProjections.some((projection) =>
      liveIds.has(projection.githubCommentId ?? "")
    );
    if (hasLiveComment) {
      continue;
    }

    await tx.gitHubCommentThreadProjection.update({
      where: { threadId: thread.threadId },
      data: {
        deletedAt: input.deletedAt,
        ...gitHubFetchProvenanceData(input.fetchProvenance),
      },
    });
    threads += 1;
  }

  return { comments: staleComments.length, threads };
}

/**
 * Soft-delete one scoped GitHub issue-comment projection after a direct
 * provider delete. The issue-comment kind guard preserves the separate GitHub
 * remote-id namespace used by Branch View conversation comments.
 */
export function softDeleteScopedGitHubCommentProjection(
  tx: GitHubProjectionDb,
  input: SoftDeleteScopedGitHubCommentProjectionInput
): Promise<{ comments: number; threads: number }> {
  return softDeleteGitHubCommentByRemoteIdInScope(tx, {
    ...input,
    threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
  });
}

/**
 * Soft-delete one scoped GitHub comment projection by remote id. Webhook delete
 * events use this path so a single deleted comment never stale-cleans unrelated
 * comments in the same PR.
 */
export function softDeleteGitHubCommentByRemoteId(
  tx: GitHubProjectionDb,
  input: SoftDeleteGitHubCommentByRemoteIdInput
): Promise<{ comments: number; threads: number }> {
  return softDeleteGitHubCommentByRemoteIdInScope(tx, input);
}

/**
 * Resolve one active, scoped review-thread projection for webhook-driven
 * resolution sync. The lookup is intentionally organization/branch/current-PR
 * scoped before any provider call is allowed.
 */
export async function findGitHubReviewThreadResolutionProjection(
  tx: GitHubProjectionDb,
  input: {
    organizationId: string;
    branchArtifactId: string;
    pullRequestDetailId: string;
    reviewThreadId: string;
    reviewCommentIds?: readonly string[];
  }
): Promise<GitHubReviewThreadResolutionProjection> {
  const reviewCommentIds = uniqueRemoteCommentIds(input.reviewCommentIds ?? []);
  const rows = await tx.gitHubCommentThreadProjection.findMany({
    where: {
      ...scopedThreadProjectionWhere(input),
      threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
      OR: reviewThreadResolutionIdentity(
        input.reviewThreadId,
        reviewCommentIds
      ),
    },
    select: {
      thread: { select: { id: true, externalId: true } },
    },
    take: 2,
  });

  if (rows.length > 1) {
    return {
      status:
        GitHubReviewThreadResolutionProjectionStatus.AmbiguousReviewThread,
    };
  }

  const row = rows[0] ?? null;
  if (row?.thread.externalId) {
    return {
      status: GitHubReviewThreadResolutionProjectionStatus.Eligible,
      threadId: row.thread.id,
      threadExternalId: row.thread.externalId,
    };
  }

  const outOfScopeRow = await tx.gitHubCommentThreadProjection.findFirst({
    where: {
      threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
      OR: reviewThreadResolutionIdentity(
        input.reviewThreadId,
        reviewCommentIds
      ),
      deletedAt: null,
      thread: {
        organizationId: input.organizationId,
        source: ThreadSource.GITHUB,
      },
    },
    select: { threadId: true },
  });

  return {
    status: outOfScopeRow
      ? GitHubReviewThreadResolutionProjectionStatus.WrongScope
      : GitHubReviewThreadResolutionProjectionStatus.UnknownReviewThread,
  };
}

function uniqueRemoteCommentIds(commentIds: readonly string[]): string[] {
  return [...new Set(commentIds.map((id) => id.trim()).filter(Boolean))];
}

function reviewThreadResolutionIdentity(
  reviewThreadId: string,
  reviewCommentIds: readonly string[]
) {
  return [
    { reviewThreadId },
    ...reviewCommentIds.map((rootCommentId) => ({ rootCommentId })),
    ...(reviewCommentIds.length > 0
      ? [
          {
            commentProjections: {
              some: {
                githubCommentId: { in: [...reviewCommentIds] },
                githubDeletedAt: null,
                comment: { deletedAt: null },
              },
            },
          },
        ]
      : []),
  ];
}

async function softDeleteGitHubCommentByRemoteIdInScope(
  tx: GitHubProjectionDb,
  input: SoftDeleteGitHubCommentByRemoteIdInput
): Promise<{ comments: number; threads: number }> {
  const githubCommentId = requireRemoteCommentId(input.githubCommentId);
  const scopedThreadWhere = scopedThreadProjectionWhere(input);
  const rows = await tx.gitHubCommentProjection.findMany({
    where: {
      githubCommentId,
      githubDeletedAt: null,
      comment: { deletedAt: null },
      threadProjection: {
        ...scopedThreadWhere,
        threadKind: input.threadKind,
      },
    },
    select: { commentId: true, threadId: true },
  });

  for (const row of rows) {
    await tx.gitHubCommentProjection.update({
      where: { commentId: row.commentId },
      data: {
        githubDeletedAt: input.deletedAt,
        ...gitHubFetchProvenanceData(input.fetchProvenance),
      },
    });
    await tx.comment.update({
      where: { id: row.commentId },
      data: { deletedAt: input.deletedAt },
    });
  }

  const affectedThreadIds = [...new Set(rows.map((row) => row.threadId))];
  let threads = 0;
  for (const threadId of affectedThreadIds) {
    const liveComment = await tx.gitHubCommentProjection.findFirst({
      where: {
        threadId,
        githubDeletedAt: null,
        comment: { deletedAt: null },
      },
      select: { commentId: true },
    });
    if (liveComment) {
      continue;
    }
    await tx.gitHubCommentThreadProjection.update({
      where: { threadId },
      data: {
        deletedAt: input.deletedAt,
        ...gitHubFetchProvenanceData(input.fetchProvenance),
      },
    });
    threads += 1;
  }

  return { comments: rows.length, threads };
}

type UpsertGitHubThreadInput = BaseGitHubThreadProjectionInput & {
  threadKind: GitHubCommentThreadKind;
  reviewThreadId?: string | null;
  rootCommentId: string;
  reviewId?: string | null;
  path?: string | null;
  line?: number | null;
  side?: GitHubDiffSide | null;
  startLine?: number | null;
  startSide?: GitHubDiffSide | null;
  commitSha?: string | null;
  comments: GitHubProjectionCommentInput[];
};

async function upsertGitHubThread(
  tx: GitHubProjectionDb,
  input: UpsertGitHubThreadInput
): Promise<UpsertGitHubProjectionResult> {
  const thread = await findOrCreateGitHubThread(tx, input);
  await upsertGitHubThreadProjection(tx, thread.id, input);
  const { threadId, commentIds, createdGithubCommentIds } =
    await upsertProjectedGitHubComments(tx, thread.id, input);

  return { threadId, commentIds, createdGithubCommentIds };
}

async function findOrCreateGitHubThread(
  tx: GitHubProjectionDb,
  input: UpsertGitHubThreadInput
): Promise<{ id: string }> {
  const threadIdentity = input.reviewThreadId
    ? [
        { reviewThreadId: input.reviewThreadId },
        { rootCommentId: input.rootCommentId },
      ]
    : [{ rootCommentId: input.rootCommentId }];
  const threadProjectionWhere = {
    branchArtifactId: input.branchArtifactId,
    pullRequestDetailId: input.pullRequestDetailId,
    threadKind: input.threadKind,
    thread: {
      organizationId: input.organizationId,
      source: ThreadSource.GITHUB,
    },
    OR: threadIdentity,
  };
  const externalId = gitHubThreadExternalId(input);
  const activeProjections = await tx.gitHubCommentThreadProjection.findMany({
    where: { ...threadProjectionWhere, deletedAt: null },
    select: { threadId: true },
    take: 2,
  });
  if (activeProjections.length > 1) {
    throw new GitHubProjectionNoWriteError(
      GitHubProjectionNoWriteCode.AmbiguousThreadProjection,
      {
        branchArtifactId: input.branchArtifactId,
        pullRequestDetailId: input.pullRequestDetailId,
        rootCommentId: input.rootCommentId,
        reviewThreadId: input.reviewThreadId ?? null,
      }
    );
  }

  const existingProjection = activeProjections[0] ?? null;
  if (existingProjection) {
    return await updateGitHubThread(tx, existingProjection.threadId, input);
  }

  const reusableProjections = await tx.gitHubCommentThreadProjection.findMany({
    where: threadProjectionWhere,
    select: { threadId: true },
    orderBy: { lastSyncedAt: "desc" },
    take: 2,
  });
  if (reusableProjections.length > 1) {
    throw new GitHubProjectionNoWriteError(
      GitHubProjectionNoWriteCode.AmbiguousThreadProjection,
      {
        branchArtifactId: input.branchArtifactId,
        pullRequestDetailId: input.pullRequestDetailId,
        rootCommentId: input.rootCommentId,
        reviewThreadId: input.reviewThreadId ?? null,
      }
    );
  }

  const reusableProjection = reusableProjections[0] ?? null;
  if (reusableProjection) {
    return await updateGitHubThread(tx, reusableProjection.threadId, input);
  }

  try {
    return await tx.commentThread.create({
      data: {
        organizationId: input.organizationId,
        source: ThreadSource.GITHUB,
        externalId,
        artifactId: input.branchArtifactId,
        status: input.resolutionStatus ?? ThreadStatus.OPEN,
      },
      select: { id: true },
    });
  } catch (error) {
    if (!isCommentThreadExternalIdUniqueError(error)) {
      throw error;
    }
  }

  const thread = await tx.commentThread.findUnique({
    where: {
      organizationId_externalId: {
        organizationId: input.organizationId,
        externalId,
      },
    },
    select: { id: true },
  });
  if (!thread) {
    throw new GitHubProjectionNoWriteError(
      GitHubProjectionNoWriteCode.ExternalIdConflict,
      {
        branchArtifactId: input.branchArtifactId,
        pullRequestDetailId: input.pullRequestDetailId,
        rootCommentId: input.rootCommentId,
        reviewThreadId: input.reviewThreadId ?? null,
      }
    );
  }
  return await updateGitHubThread(tx, thread.id, input);
}

async function updateGitHubThread(
  tx: GitHubProjectionDb,
  threadId: string,
  input: UpsertGitHubThreadInput
): Promise<{ id: string }> {
  const externalId = gitHubThreadExternalId(input);
  const data: Prisma.CommentThreadUncheckedUpdateInput = {
    source: ThreadSource.GITHUB,
    externalId,
    artifactId: input.branchArtifactId,
    updatedAt: new Date(),
  };
  if (input.resolutionStatus != null) {
    data.status = input.resolutionStatus;
  }
  try {
    return await tx.commentThread.update({
      where: { id: threadId },
      data,
      select: { id: true },
    });
  } catch (error) {
    if (!isCommentThreadExternalIdUniqueError(error)) {
      throw error;
    }
  }

  const thread = await tx.commentThread.findUnique({
    where: {
      organizationId_externalId: {
        organizationId: input.organizationId,
        externalId,
      },
    },
    select: { id: true },
  });
  if (!thread) {
    throw new GitHubProjectionNoWriteError(
      GitHubProjectionNoWriteCode.ExternalIdConflict,
      {
        branchArtifactId: input.branchArtifactId,
        pullRequestDetailId: input.pullRequestDetailId,
        rootCommentId: input.rootCommentId,
        reviewThreadId: input.reviewThreadId ?? null,
      }
    );
  }
  return thread;
}

async function upsertGitHubThreadProjection(
  tx: GitHubProjectionDb,
  threadId: string,
  input: UpsertGitHubThreadInput
): Promise<void> {
  await tx.gitHubCommentThreadProjection.upsert({
    where: { threadId },
    create: {
      threadId,
      ...gitHubThreadProjectionData(input, "create"),
    },
    update: gitHubThreadProjectionData(input, "update"),
  });
}

/**
 * Build projection writes without letting unknown provider state regress an
 * existing resolved thread. Creates still default unknown state to PENDING so
 * new projections have a concrete local lifecycle state.
 */
function gitHubThreadProjectionData(
  input: UpsertGitHubThreadInput,
  mode: "create" | "update"
): Omit<Prisma.GitHubCommentThreadProjectionUncheckedCreateInput, "threadId"> {
  const data: Omit<
    Prisma.GitHubCommentThreadProjectionUncheckedCreateInput,
    "threadId"
  > = {
    branchArtifactId: input.branchArtifactId,
    pullRequestDetailId: input.pullRequestDetailId,
    threadKind: input.threadKind,
    reviewThreadId: input.reviewThreadId ?? null,
    rootCommentId: input.rootCommentId,
    reviewId: input.reviewId ?? null,
    path: input.path ?? null,
    line: input.line ?? null,
    side: input.side ?? null,
    startLine: input.startLine ?? null,
    startSide: input.startSide ?? null,
    commitSha: input.commitSha ?? null,
    htmlUrl: input.htmlUrl ?? null,
    resolvable: input.resolvable ?? false,
    legacyState: input.legacyState ?? GitHubLegacyCommentState.PENDING,
    deletedAt: null,
    lastSyncedAt: input.lastSyncedAt ?? new Date(),
    ...gitHubFetchProvenanceData(input.fetchProvenance),
  };
  if (mode === "update" && input.legacyState == null) {
    data.legacyState = undefined;
  }
  return data;
}

async function upsertProjectedGitHubComments(
  tx: GitHubProjectionDb,
  threadId: string,
  input: UpsertGitHubThreadInput
): Promise<{
  threadId: string;
  commentIds: string[];
  createdGithubCommentIds: string[];
}> {
  const remoteCommentIds = input.comments.map((comment) =>
    requireRemoteCommentId(comment.githubCommentId)
  );
  let targetThreadId = threadId;
  const commentIds: string[] = [];
  const createdGithubCommentIds: string[] = [];
  const localCommentIdByRemoteId = new Map<string, string>();
  const pendingParentLinks: {
    commentId: string;
    githubInReplyToCommentId: string | null;
  }[] = [];
  const existingScopedThreadId = await findScopedThreadIdForRemoteComments(
    tx,
    input,
    remoteCommentIds
  );
  if (existingScopedThreadId && existingScopedThreadId !== targetThreadId) {
    targetThreadId = existingScopedThreadId;
    await upsertGitHubThreadProjection(tx, targetThreadId, input);
  }
  await assertCommentExternalIdsAreScoped(tx, input, remoteCommentIds);
  for (const [index, commentInput] of input.comments.entries()) {
    const githubCommentId = remoteCommentIds[index];
    if (!githubCommentId) {
      throw new Error("Missing normalized GitHub comment id");
    }
    const githubInReplyToCommentId = optionalRemoteCommentId(
      commentInput.githubInReplyToCommentId
    );
    const parentCommentId = githubInReplyToCommentId
      ? (localCommentIdByRemoteId.get(githubInReplyToCommentId) ??
        (await findCommentIdForRemoteId(
          tx,
          targetThreadId,
          githubInReplyToCommentId
        )))
      : null;

    const { comment, created } = await createOrUpdateProjectedComment(tx, {
      threadId: targetThreadId,
      scopeInput: input,
      githubCommentId,
      commentInput,
      githubInReplyToCommentId,
      parentCommentId,
    });
    if (comment.threadId !== targetThreadId) {
      targetThreadId = comment.threadId;
      await upsertGitHubThreadProjection(tx, targetThreadId, input);
    }
    if (created) {
      createdGithubCommentIds.push(githubCommentId);
    }

    await tx.gitHubCommentProjection.upsert({
      where: { commentId: comment.id },
      create: {
        commentId: comment.id,
        threadId: targetThreadId,
        externalAuthorId: commentInput.author.externalAuthorId ?? null,
        githubCommentId,
        githubInReplyToCommentId,
        githubHtmlUrl: commentInput.githubHtmlUrl ?? null,
        githubUpdatedAt: commentInput.githubUpdatedAt ?? null,
        githubDeletedAt: null,
        ...gitHubFetchProvenanceData(input.fetchProvenance),
      },
      update: {
        threadId: targetThreadId,
        externalAuthorId: commentInput.author.externalAuthorId ?? null,
        githubCommentId,
        githubInReplyToCommentId,
        githubHtmlUrl: commentInput.githubHtmlUrl ?? null,
        githubUpdatedAt: commentInput.githubUpdatedAt ?? null,
        githubDeletedAt: null,
        ...gitHubFetchProvenanceData(input.fetchProvenance),
      },
    });

    localCommentIdByRemoteId.set(githubCommentId, comment.id);
    pendingParentLinks.push({
      commentId: comment.id,
      githubInReplyToCommentId,
    });
    commentIds.push(comment.id);
  }

  await backfillGitHubCommentParentLinks(
    tx,
    targetThreadId,
    pendingParentLinks,
    localCommentIdByRemoteId
  );

  return { threadId: targetThreadId, commentIds, createdGithubCommentIds };
}

async function createOrUpdateProjectedComment(
  tx: GitHubProjectionDb,
  input: {
    threadId: string;
    scopeInput: UpsertGitHubThreadInput;
    githubCommentId: string;
    commentInput: GitHubProjectionCommentInput;
    githubInReplyToCommentId: string | null;
    parentCommentId: string | null;
  }
): Promise<{ comment: { id: string; threadId: string }; created: boolean }> {
  const externalId = gitHubCommentExternalId(
    input.scopeInput.threadKind,
    input.githubCommentId
  );
  const data = projectedCommentData(input);
  const existingScopedComment =
    (await findScopedProjectionCommentByRemoteId(
      tx,
      input.scopeInput,
      input.githubCommentId
    )) ??
    (await findScopedCommentByRemoteId(
      tx,
      input.scopeInput,
      input.githubCommentId
    ));
  if (existingScopedComment) {
    const recoveryParentCommentId = await resolveProjectedParentCommentId(
      tx,
      input,
      existingScopedComment.threadId
    );
    const comment = await tx.comment.update({
      where: { id: existingScopedComment.id },
      data: {
        ...data,
        threadId: existingScopedComment.threadId,
        parentCommentId: recoveryParentCommentId,
      },
      select: { id: true, threadId: true },
    });
    return { comment, created: false };
  }

  try {
    const comment = await tx.comment.create({
      data: {
        ...data,
        externalId,
        createdAt: input.commentInput.createdAt,
      },
      select: { id: true, threadId: true },
    });
    return { comment, created: true };
  } catch (error) {
    if (!isCommentExternalIdUniqueError(error)) {
      throw error;
    }
  }

  const existingComment = await findScopedCommentByRemoteId(
    tx,
    input.scopeInput,
    input.githubCommentId
  );
  if (!existingComment) {
    await assertCommentExternalIdsAreScoped(tx, input.scopeInput, [
      input.githubCommentId,
    ]);
  }
  const recoveryThreadId = existingComment?.threadId ?? input.threadId;
  const recoveryParentCommentId = await resolveProjectedParentCommentId(
    tx,
    input,
    recoveryThreadId
  );
  const comment = await tx.comment.update({
    where: { externalId },
    data: {
      ...data,
      threadId: recoveryThreadId,
      parentCommentId: recoveryParentCommentId,
    },
    select: { id: true, threadId: true },
  });
  return { comment, created: false };
}

async function resolveProjectedParentCommentId(
  tx: GitHubProjectionDb,
  input: {
    threadId: string;
    githubInReplyToCommentId: string | null;
    parentCommentId: string | null;
  },
  recoveryThreadId: string
): Promise<string | null> {
  if (!input.githubInReplyToCommentId) {
    return null;
  }
  return input.threadId === recoveryThreadId
    ? input.parentCommentId
    : await findCommentIdForRemoteId(
        tx,
        recoveryThreadId,
        input.githubInReplyToCommentId
      );
}

function projectedCommentData(input: {
  threadId: string;
  commentInput: GitHubProjectionCommentInput;
  parentCommentId: string | null;
}) {
  return {
    threadId: input.threadId,
    authorId: input.commentInput.author.userId,
    body: githubMarkdownCommentBody(input.commentInput.bodyMarkdown),
    plainText: input.commentInput.bodyMarkdown,
    parentCommentId: input.parentCommentId,
    editedAt: gitHubEditedAt(input.commentInput),
    deletedAt: null,
  };
}

function isCommentExternalIdUniqueError(error: unknown): boolean {
  if (getPrismaErrorCode(error) !== "P2002") {
    return false;
  }

  const target = getPrismaP2002Target(error);
  if (Array.isArray(target)) {
    return target.some(
      (field) => field === "externalId" || field === "external_id"
    );
  }
  return (
    typeof target === "string" &&
    (target.includes("externalId") ||
      target.includes("external_id") ||
      target.includes("comments_external_id"))
  );
}

async function assertCommentExternalIdsAreScoped(
  tx: GitHubProjectionDb,
  input: UpsertGitHubThreadInput,
  remoteCommentIds: string[]
): Promise<void> {
  for (const githubCommentId of remoteCommentIds) {
    const existingComment = await tx.comment.findUnique({
      where: {
        externalId: gitHubCommentExternalId(input.threadKind, githubCommentId),
      },
      select: {
        id: true,
        threadId: true,
        thread: {
          select: {
            organizationId: true,
            artifactId: true,
            source: true,
            githubProjection: {
              select: {
                branchArtifactId: true,
                pullRequestDetailId: true,
                threadKind: true,
                deletedAt: true,
              },
            },
          },
        },
      },
    });
    if (!existingComment) {
      continue;
    }

    const projection = existingComment.thread.githubProjection;
    const sameScope =
      existingComment.thread.organizationId === input.organizationId &&
      existingComment.thread.artifactId === input.branchArtifactId &&
      existingComment.thread.source === ThreadSource.GITHUB &&
      projection?.branchArtifactId === input.branchArtifactId &&
      projection.pullRequestDetailId === input.pullRequestDetailId &&
      projection.threadKind === input.threadKind;
    if (!sameScope) {
      throw new GitHubProjectionNoWriteError(
        GitHubProjectionNoWriteCode.ExternalIdConflict,
        {
          githubCommentId,
          existingCommentId: existingComment.id,
          existingThreadId: existingComment.threadId,
          branchArtifactId: input.branchArtifactId,
          pullRequestDetailId: input.pullRequestDetailId,
        }
      );
    }
  }
}

async function findScopedThreadIdForRemoteComments(
  tx: GitHubProjectionDb,
  input: UpsertGitHubThreadInput,
  remoteCommentIds: string[]
): Promise<string | null> {
  const rows = await tx.comment.findMany({
    where: {
      externalId: {
        in: remoteCommentIds.map((id) =>
          gitHubCommentExternalId(input.threadKind, id)
        ),
      },
      thread: {
        organizationId: input.organizationId,
        artifactId: input.branchArtifactId,
        source: ThreadSource.GITHUB,
        githubProjection: {
          branchArtifactId: input.branchArtifactId,
          pullRequestDetailId: input.pullRequestDetailId,
          threadKind: input.threadKind,
        },
      },
    },
    select: { threadId: true },
    distinct: ["threadId"],
    take: 2,
  });
  if (rows.length > 1) {
    throw new GitHubProjectionNoWriteError(
      GitHubProjectionNoWriteCode.AmbiguousThreadProjection,
      {
        branchArtifactId: input.branchArtifactId,
        pullRequestDetailId: input.pullRequestDetailId,
        rootCommentId: input.rootCommentId,
        reviewThreadId: input.reviewThreadId ?? null,
      }
    );
  }
  return rows[0]?.threadId ?? null;
}

async function findScopedCommentByRemoteId(
  tx: GitHubProjectionDb,
  input: UpsertGitHubThreadInput,
  githubCommentId: string
): Promise<{ id: string; threadId: string } | null> {
  return await tx.comment.findFirst({
    where: {
      externalId: gitHubCommentExternalId(input.threadKind, githubCommentId),
      thread: {
        organizationId: input.organizationId,
        artifactId: input.branchArtifactId,
        source: ThreadSource.GITHUB,
        githubProjection: {
          branchArtifactId: input.branchArtifactId,
          pullRequestDetailId: input.pullRequestDetailId,
          threadKind: input.threadKind,
        },
      },
    },
    select: { id: true, threadId: true },
  });
}

async function findScopedProjectionCommentByRemoteId(
  tx: GitHubProjectionDb,
  input: UpsertGitHubThreadInput,
  githubCommentId: string
): Promise<{ id: string; threadId: string } | null> {
  const row = await tx.gitHubCommentProjection.findFirst({
    where: {
      githubCommentId,
      threadProjection: {
        ...scopedThreadProjectionWhere(input),
        threadKind: input.threadKind,
      },
    },
    select: { commentId: true, threadId: true },
  });
  return row ? { id: row.commentId, threadId: row.threadId } : null;
}

async function backfillGitHubCommentParentLinks(
  tx: GitHubProjectionDb,
  threadId: string,
  pendingParentLinks: {
    commentId: string;
    githubInReplyToCommentId: string | null;
  }[],
  localCommentIdByRemoteId: ReadonlyMap<string, string>
): Promise<void> {
  for (const link of pendingParentLinks) {
    if (!link.githubInReplyToCommentId) {
      continue;
    }

    const parentCommentId =
      localCommentIdByRemoteId.get(link.githubInReplyToCommentId) ??
      (await findCommentIdForRemoteId(
        tx,
        threadId,
        link.githubInReplyToCommentId
      ));
    if (!(parentCommentId && parentCommentId !== link.commentId)) {
      continue;
    }

    await tx.comment.update({
      where: { id: link.commentId },
      data: { parentCommentId },
    });
  }
}

function scopedThreadProjectionWhere(input: {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
}) {
  return {
    branchArtifactId: input.branchArtifactId,
    pullRequestDetailId: input.pullRequestDetailId,
    deletedAt: null,
    thread: {
      organizationId: input.organizationId,
      artifactId: input.branchArtifactId,
      source: ThreadSource.GITHUB,
    },
  };
}

function githubMarkdownCommentBody(markdown: string): Prisma.InputJsonObject {
  return {
    type: "github_markdown",
    markdown,
  };
}

function gitHubEditedAt(
  comment: Pick<GitHubProjectionCommentInput, "createdAt" | "githubUpdatedAt">
): Date | null {
  if (
    !comment.githubUpdatedAt ||
    comment.githubUpdatedAt.getTime() === comment.createdAt.getTime()
  ) {
    return null;
  }
  return comment.githubUpdatedAt;
}

function requireRemoteCommentId(id: string | number): string {
  const normalized = String(id).trim();
  if (!normalized) {
    throw new Error("GitHub comment projection requires a remote comment id");
  }
  return normalized;
}

function optionalRemoteCommentId(
  id: string | number | null | undefined
): string | null {
  if (id === null || id === undefined) {
    return null;
  }
  return requireRemoteCommentId(id);
}

function gitHubCommentExternalId(
  threadKind: GitHubCommentThreadKind,
  githubCommentId: string
): string {
  return `github:${threadKind}:comment:${githubCommentId}`;
}

async function assertScopedGitHubCommentExternalIdAvailable(
  tx: GitHubProjectionDb,
  input: {
    organizationId: string;
    branchArtifactId: string;
    pullRequestDetailId: string;
    threadKind: GitHubCommentThreadKind;
    githubCommentId: string;
  }
): Promise<void> {
  const existing = await tx.comment.findUnique({
    where: {
      externalId: gitHubCommentExternalId(
        input.threadKind,
        input.githubCommentId
      ),
    },
    select: {
      thread: {
        select: {
          organizationId: true,
          artifactId: true,
          source: true,
          githubProjection: {
            select: {
              branchArtifactId: true,
              pullRequestDetailId: true,
              threadKind: true,
            },
          },
        },
      },
    },
  });

  if (!existing) {
    return;
  }

  const projection = existing.thread.githubProjection;
  const sameScope =
    existing.thread.organizationId === input.organizationId &&
    existing.thread.artifactId === input.branchArtifactId &&
    existing.thread.source === ThreadSource.GITHUB &&
    projection !== null &&
    projection.branchArtifactId === input.branchArtifactId &&
    projection.pullRequestDetailId === input.pullRequestDetailId &&
    projection.threadKind === input.threadKind;

  if (!sameScope) {
    throw new GitHubCommentProjectionScopeCollisionError(input.githubCommentId);
  }
}

function gitHubThreadExternalId(input: UpsertGitHubThreadInput): string {
  const identity = input.reviewThreadId
    ? `review-thread:${input.reviewThreadId}`
    : `${input.threadKind}:root:${input.rootCommentId}`;
  return `github-pr-thread:${input.pullRequestDetailId}:${identity}`;
}

function isCommentThreadExternalIdUniqueError(error: unknown): boolean {
  if (getPrismaErrorCode(error) !== "P2002") {
    return false;
  }

  const target = getPrismaP2002Target(error);
  if (Array.isArray(target)) {
    return target.some(
      (field) => field === "externalId" || field === "external_id"
    );
  }
  return (
    typeof target === "string" &&
    (target.includes("externalId") ||
      target.includes("external_id") ||
      target.includes("comment_threads_organization_id_external_id"))
  );
}

async function findCommentIdForRemoteId(
  tx: GitHubProjectionDb,
  threadId: string,
  githubCommentId: string
): Promise<string | null> {
  const row = await tx.gitHubCommentProjection.findFirst({
    where: { threadId, githubCommentId },
    select: { commentId: true },
  });
  return row?.commentId ?? null;
}
