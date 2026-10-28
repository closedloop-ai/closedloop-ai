import { ThreadSource, type TransactionClient } from "@repo/database";
import { CommentArtifactType } from "../comment-target";
import {
  emitThreadChangeSignal,
  ThreadChangeKind,
} from "../comment-thread-signal";

/**
 * Move duplicate-owned comment projections onto a canonical PR while
 * preserving the original generic thread, comments, and provider child rows.
 * Every read/write is constrained through the owning organization. Each moved
 * thread's revision moves on once, and it is signalled on the branch it now
 * belongs to and, when it changed branch, on the branch it left (PLN-2122
 * Step 4). A move that only finishes one already signalled (the second hop
 * through a staging pull request) passes `signalMoves: false`.
 */
export async function relinkPullRequestComments(
  tx: RelinkPullRequestCommentsClient,
  input: {
    organizationId: string;
    sourcePullRequestDetailId: string;
    targetPullRequestDetailId: string;
    targetBranchArtifactId: string;
    signalMoves?: boolean;
  }
): Promise<void> {
  if (input.sourcePullRequestDetailId === input.targetPullRequestDetailId) {
    return;
  }
  const [sourceProjections, targetProjections] = await Promise.all([
    tx.gitHubCommentThreadProjection.findMany({
      where: {
        pullRequestDetailId: input.sourcePullRequestDetailId,
        pullRequestDetail: { organizationId: input.organizationId },
      },
      orderBy: { threadId: "asc" },
      select: COMMENT_PROJECTION_IDENTITY_SELECT,
    }),
    tx.gitHubCommentThreadProjection.findMany({
      where: {
        pullRequestDetailId: input.targetPullRequestDetailId,
        pullRequestDetail: { organizationId: input.organizationId },
      },
      select: COMMENT_PROJECTION_IDENTITY_SELECT,
    }),
  ]);
  assertNoCommentProjectionIdentityCollisions(
    sourceProjections,
    targetProjections
  );
  for (const projection of sourceProjections) {
    if (projection.branchArtifactId === input.targetBranchArtifactId) {
      const moved = await tx.gitHubCommentThreadProjection.updateMany({
        where: {
          threadId: projection.threadId,
          pullRequestDetailId: input.sourcePullRequestDetailId,
          branchArtifactId: input.targetBranchArtifactId,
          pullRequestDetail: { organizationId: input.organizationId },
        },
        data: { pullRequestDetailId: input.targetPullRequestDetailId },
      });
      assertSingleMove(moved.count, "projection owner");
    } else {
      await moveCommentProjectionAcrossBranches(tx, {
        organizationId: input.organizationId,
        sourcePullRequestDetailId: input.sourcePullRequestDetailId,
        targetPullRequestDetailId: input.targetPullRequestDetailId,
        sourceBranchArtifactId: projection.branchArtifactId,
        targetBranchArtifactId: input.targetBranchArtifactId,
        threadId: projection.threadId,
      });
    }
    if (input.signalMoves !== false) {
      await signalMovedThread(tx, {
        organizationId: input.organizationId,
        threadId: projection.threadId,
        fromBranchArtifactId: projection.branchArtifactId,
        toBranchArtifactId: input.targetBranchArtifactId,
      });
    }
  }
}

async function signalMovedThread(
  tx: RelinkPullRequestCommentsClient,
  input: {
    organizationId: string;
    threadId: string;
    fromBranchArtifactId: string;
    toBranchArtifactId: string;
  }
): Promise<void> {
  const { revision } = await tx.commentThread.update({
    where: { id: input.threadId },
    data: { revision: { increment: 1 } },
    select: { revision: true },
  });
  const branches = new Set([
    input.toBranchArtifactId,
    input.fromBranchArtifactId,
  ]);
  for (const artifactId of branches) {
    await emitThreadChangeSignal(
      tx,
      {
        organizationId: input.organizationId,
        artifactId,
        artifactType: CommentArtifactType.Branch,
      },
      ThreadChangeKind.Updated,
      { threadId: input.threadId, threadRevision: revision }
    );
  }
}

async function moveCommentProjectionAcrossBranches(
  tx: RelinkPullRequestCommentsClient,
  input: {
    organizationId: string;
    sourcePullRequestDetailId: string;
    targetPullRequestDetailId: string;
    sourceBranchArtifactId: string;
    targetBranchArtifactId: string;
    threadId: string;
  }
): Promise<void> {
  const commentProjections = await tx.gitHubCommentProjection.findMany({
    where: {
      threadId: input.threadId,
      threadProjection: {
        pullRequestDetail: { organizationId: input.organizationId },
      },
    },
  });
  const removedCommentProjections = await tx.gitHubCommentProjection.deleteMany(
    {
      where: {
        threadId: input.threadId,
        threadProjection: {
          pullRequestDetail: { organizationId: input.organizationId },
        },
      },
    }
  );
  if (removedCommentProjections.count !== commentProjections.length) {
    throw new Error("pull request comment projection children changed");
  }
  const stagingThread = await tx.commentThread.create({
    data: {
      organizationId: input.organizationId,
      source: ThreadSource.GITHUB,
      artifactId: input.targetBranchArtifactId,
    },
    select: { id: true },
  });
  const stagedProjection = await tx.gitHubCommentThreadProjection.updateMany({
    where: {
      threadId: input.threadId,
      pullRequestDetailId: input.sourcePullRequestDetailId,
      pullRequestDetail: { organizationId: input.organizationId },
    },
    data: {
      threadId: stagingThread.id,
      branchArtifactId: input.targetBranchArtifactId,
      pullRequestDetailId: input.targetPullRequestDetailId,
    },
  });
  assertSingleMove(stagedProjection.count, "projection staging");
  const movedThread = await tx.commentThread.updateMany({
    where: {
      id: input.threadId,
      organizationId: input.organizationId,
      artifactId: input.sourceBranchArtifactId,
      source: ThreadSource.GITHUB,
    },
    data: { artifactId: input.targetBranchArtifactId },
  });
  assertSingleMove(movedThread.count, "thread owner");
  const restoredProjection = await tx.gitHubCommentThreadProjection.updateMany({
    where: {
      threadId: stagingThread.id,
      pullRequestDetailId: input.targetPullRequestDetailId,
      pullRequestDetail: { organizationId: input.organizationId },
    },
    data: { threadId: input.threadId },
  });
  assertSingleMove(restoredProjection.count, "projection restore");
  if (commentProjections.length > 0) {
    const restoredCommentProjections =
      await tx.gitHubCommentProjection.createMany({
        data: commentProjections,
      });
    if (restoredCommentProjections.count !== commentProjections.length) {
      throw new Error("pull request comment projection children changed");
    }
  }
  const removedStagingThread = await tx.commentThread.deleteMany({
    where: { id: stagingThread.id, organizationId: input.organizationId },
  });
  assertSingleMove(removedStagingThread.count, "staging row");
}

function assertNoCommentProjectionIdentityCollisions(
  sourceProjections: readonly CommentProjectionIdentity[],
  targetProjections: readonly CommentProjectionIdentity[]
): void {
  const targetIdentities = new Set(
    targetProjections
      .map(commentProjectionIdentity)
      .filter((identity): identity is string => identity !== null)
  );
  if (
    sourceProjections.some((projection) => {
      const identity = commentProjectionIdentity(projection);
      return identity !== null && targetIdentities.has(identity);
    })
  ) {
    throw new Error("pull request comment projection identity conflict");
  }
}

function commentProjectionIdentity(
  projection: CommentProjectionIdentity
): string | null {
  if (projection.rootCommentId) {
    return `${projection.threadKind}:root:${projection.rootCommentId}`;
  }
  if (projection.reviewThreadId) {
    return `${projection.threadKind}:review:${projection.reviewThreadId}`;
  }
  return null;
}

function assertSingleMove(count: number, subject: string): void {
  if (count !== 1) {
    throw new Error(`pull request comment ${subject} changed`);
  }
}

const COMMENT_PROJECTION_IDENTITY_SELECT = {
  threadId: true,
  branchArtifactId: true,
  threadKind: true,
  rootCommentId: true,
  reviewThreadId: true,
} as const;

type RelinkPullRequestCommentsClient = Pick<
  TransactionClient,
  | "$executeRaw"
  | "commentThread"
  | "gitHubCommentProjection"
  | "gitHubCommentThreadProjection"
>;

type CommentProjectionIdentity = {
  threadId: string;
  branchArtifactId: string;
  threadKind: string;
  rootCommentId: string | null;
  reviewThreadId: string | null;
};
