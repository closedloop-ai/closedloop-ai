import {
  GitHubLegacyCommentState,
  type Prisma,
  ThreadSource,
  ThreadStatus,
} from "@repo/database";
import {
  type GitHubFetchProvenance,
  gitHubFetchProvenanceData,
} from "@/lib/github-fetch-provenance";
import { commentThreadMetadataObject } from "../liveblocks-thread-read";
import { clearResolutionAttribution } from "../thread-resolution";
import type {
  GitHubProjectionDb,
  UpsertGitHubThreadInput,
} from "./github-projection-contract";
import {
  GitHubProjectionNoWriteCode,
  GitHubProjectionNoWriteError,
  gitHubThreadExternalId,
} from "./github-projection-identity";

export type FoundOrCreatedGitHubThread = {
  id: string;
  /** Set when this call created the thread: the revision its row was written at. */
  createdRevision: number | null;
  /** The thread's projection was soft-deleted and this write brings it back. */
  revived: boolean;
};

/**
 * The thread a GitHub projection write lands on: the one active projection with
 * this identity, else a soft-deleted one, which the write brings back, else a
 * new thread. A thread's projection is deleted when its last comment is, and
 * the write carries a comment the ordering rules accepted, so the thread is
 * live again: GitHub keeps a reply whose root was deleted.
 *
 * A unique violation is not caught: it aborts the transaction, which the
 * caller runs again ({@link withGitHubCommentWriteRetry}).
 */
export async function findOrCreateGitHubThread(
  tx: GitHubProjectionDb,
  input: UpsertGitHubThreadInput
): Promise<FoundOrCreatedGitHubThread> {
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
  const activeProjections = await tx.gitHubCommentThreadProjection.findMany({
    where: { ...threadProjectionWhere, deletedAt: null },
    select: { threadId: true, reviewThreadId: true },
    take: 2,
  });
  if (activeProjections.length > 1) {
    throw ambiguousThreadProjection(input);
  }

  const existingProjection = activeProjections[0] ?? null;
  if (existingProjection) {
    await updateGitHubThread(tx, existingProjection, input);
    return {
      id: existingProjection.threadId,
      createdRevision: null,
      revived: false,
    };
  }

  const reusableProjections = await tx.gitHubCommentThreadProjection.findMany({
    where: threadProjectionWhere,
    select: { threadId: true, reviewThreadId: true },
    orderBy: { lastSyncedAt: "desc" },
    take: 2,
  });
  if (reusableProjections.length > 1) {
    throw ambiguousThreadProjection(input);
  }

  const reusableProjection = reusableProjections[0] ?? null;
  if (reusableProjection) {
    await updateGitHubThread(tx, reusableProjection, input);
    return {
      id: reusableProjection.threadId,
      createdRevision: null,
      revived: true,
    };
  }

  const created = await tx.commentThread.create({
    data: {
      organizationId: input.organizationId,
      source: ThreadSource.GITHUB,
      externalId: gitHubThreadExternalId(input),
      artifactId: input.branchArtifactId,
      status: input.resolutionStatus ?? ThreadStatus.OPEN,
    },
    select: { id: true, revision: true },
  });
  return {
    id: created.id,
    createdRevision: created.revision ?? 0,
    revived: false,
  };
}

/**
 * The thread's external id follows the review-thread id once one is stored:
 * a write that does not know it (a review-comment webhook) keeps that identity
 * rather than writing the root form back, so the webhook and reconcile paths
 * agree on one external id.
 */
async function updateGitHubThread(
  tx: GitHubProjectionDb,
  stored: { threadId: string; reviewThreadId: string | null },
  input: UpsertGitHubThreadInput
): Promise<void> {
  const threadId = stored.threadId;
  const externalId = gitHubThreadExternalId({
    ...input,
    reviewThreadId: input.reviewThreadId ?? stored.reviewThreadId,
  });
  const data: Prisma.CommentThreadUncheckedUpdateInput = {
    source: ThreadSource.GITHUB,
    externalId,
    artifactId: input.branchArtifactId,
    updatedAt: new Date(),
  };
  if (input.resolutionStatus != null) {
    if (input.resolutionReadAt) {
      // Before the update below moves `updatedAt` past the read.
      await writeListedThreadStatus(
        tx,
        threadId,
        input.resolutionStatus,
        input.resolutionReadAt
      );
    } else {
      data.status = input.resolutionStatus;
    }
  }
  await tx.commentThread.update({
    where: { id: threadId },
    data,
    select: { id: true },
  });
}

export async function upsertGitHubThreadProjection(
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
    select: { threadId: true },
  });
}

/**
 * Build projection writes without letting unknown provider state regress an
 * existing thread: an update keeps the stored legacy state and review-thread id
 * when the input does not know them (a review-comment webhook carries neither).
 * Creates still default unknown state to PENDING so new projections have a
 * concrete local lifecycle state. An update clears a soft-deleted projection
 * only on a revival.
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
    originalLine: input.originalLine ?? null,
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
  if (mode === "update") {
    keepStoredFieldsOnUpdate(data, input);
  }
  return data;
}

function keepStoredFieldsOnUpdate(
  data: Omit<
    Prisma.GitHubCommentThreadProjectionUncheckedCreateInput,
    "threadId"
  >,
  input: UpsertGitHubThreadInput
): void {
  if (input.legacyState == null) {
    data.legacyState = undefined;
  }
  if (input.reviewThreadId == null) {
    data.reviewThreadId = undefined;
  }
  if (!input.revive) {
    data.deletedAt = undefined;
  }
  if (input.threadFieldsFromReply) {
    keepStoredRootFields(data);
  }
}

function keepStoredRootFields(
  data: Omit<
    Prisma.GitHubCommentThreadProjectionUncheckedCreateInput,
    "threadId"
  >
): void {
  data.reviewId = undefined;
  data.htmlUrl = undefined;
  data.path = undefined;
  data.line = undefined;
  data.originalLine = undefined;
  data.side = undefined;
  data.startLine = undefined;
  data.startSide = undefined;
  data.commitSha = undefined;
}

export async function softDeleteGitHubThreadProjection(
  tx: GitHubProjectionDb,
  threadId: string,
  input: { deletedAt: Date; fetchProvenance?: GitHubFetchProvenance }
): Promise<void> {
  await tx.gitHubCommentThreadProjection.update({
    where: { threadId },
    data: {
      deletedAt: input.deletedAt,
      ...gitHubFetchProvenanceData(input.fetchProvenance),
    },
    select: { threadId: true },
  });
}

function ambiguousThreadProjection(
  input: UpsertGitHubThreadInput
): GitHubProjectionNoWriteError {
  return new GitHubProjectionNoWriteError(
    GitHubProjectionNoWriteCode.AmbiguousThreadProjection,
    threadErrorDetails(input)
  );
}

function threadErrorDetails(
  input: UpsertGitHubThreadInput
): Record<string, string | null> {
  return {
    branchArtifactId: input.branchArtifactId,
    pullRequestDetailId: input.pullRequestDetailId,
    rootCommentId: input.rootCommentId,
    reviewThreadId: input.reviewThreadId ?? null,
  };
}

/**
 * A listed resolution, written only while the thread is unchanged since the
 * list was read: the predicate is re-checked under the row lock, so a resolve
 * or unresolve webhook that commits first wins. Reopening clears the
 * resolution fields as `unresolveThreadByExternalId` does.
 */
async function writeListedThreadStatus(
  tx: GitHubProjectionDb,
  threadId: string,
  status: ThreadStatus,
  readAt: Date
): Promise<void> {
  const reopened = status === ThreadStatus.OPEN;
  const { count } = await tx.commentThread.updateMany({
    where: { id: threadId, status: { not: status }, updatedAt: { lt: readAt } },
    data: reopened
      ? { status, resolvedAt: null, resolvedById: null }
      : { status },
  });
  if (!(reopened && count > 0)) {
    return;
  }
  // The update above holds the row lock, so this read-modify-write is safe.
  const thread = await tx.commentThread.findUniqueOrThrow({
    where: { id: threadId },
    select: { metadata: true },
  });
  if (thread.metadata === null) {
    return;
  }
  await tx.commentThread.update({
    where: { id: threadId },
    data: {
      metadata: clearResolutionAttribution(
        commentThreadMetadataObject(thread.metadata)
      ),
    },
    select: { id: true },
  });
}
