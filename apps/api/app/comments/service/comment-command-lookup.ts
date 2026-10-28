import type { ThreadSource } from "@repo/api/src/types/comment";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { Result } from "@repo/api/src/types/result";
import type { TransactionClient } from "@repo/database";
import { type CommentTarget, commentThreadSources } from "./comment-target";
import { findThreadOrigin } from "./comment-thread-origin";
import type { CommentThreadRow } from "./comment-thread-rows";
import {
  storedThreadSurface,
  threadSourceWhere,
} from "./stored-thread-surface";
import {
  type TraceCommentSyncStateRow,
  traceCommentSyncStatesSelect,
} from "./trace-comment-sync-state";

/** What the result of a write is read from, once it has committed its rows. */
export type WrittenComment = {
  threadId: string;
  /** The row the write already returned, so presenting it needs no re-read. */
  row?: CommentThreadRow;
};

/** What a presenter reads with: a transaction, or a read snapshot. */
export type CommentReadClient = Pick<
  TransactionClient,
  "commentThread" | "user"
>;

export type CommentPresenter<T> = (
  db: CommentReadClient,
  written: WrittenComment
) => Promise<T | null>;

/** A live comment the viewer may change, with the thread state its write needs. */
export type EditableComment = {
  threadId: string;
  commentId: string;
  authorId: string;
  isRoot: boolean;
  threadAuthorId: string | null;
  syncStates: TraceCommentSyncStateRow[];
};

/**
 * The thread on the target holding this live comment, from a source the
 * target's type serves, `not_found` outside it or off the target's surface.
 */
export async function findCommentOnTarget(
  tx: TransactionClient,
  target: CommentTarget,
  commentId: string
): Promise<Result<EditableComment, CommentErrorCode>> {
  const thread = await tx.commentThread.findFirst({
    where: {
      organizationId: target.organizationId,
      artifactId: target.artifactId,
      source: threadSourceWhere(commentThreadSources(target.artifactType)),
      comments: {
        some: {
          id: commentId,
          deletedAt: null,
        },
      },
    },
    select: {
      id: true,
      artifactId: true,
      source: true,
      status: true,
      metadata: true,
      syncStates: traceCommentSyncStatesSelect,
      createdAt: true,
      updatedAt: true,
      comments: {
        where: {
          deletedAt: null,
        },
        select: {
          id: true,
          authorId: true,
          plainText: true,
          editedAt: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!(thread && isThreadOnTargetSurface(thread, target))) {
    return Result.err(CommentErrorCode.NotFound);
  }
  const comment = thread.comments.find(
    (candidate) => candidate.id === commentId
  );
  if (!comment) {
    return Result.err(CommentErrorCode.NotFound);
  }
  const origin = await findThreadOrigin(tx, {
    organizationId: target.organizationId,
    threadId: thread.id,
  });
  return Result.ok({
    threadId: thread.id,
    commentId: comment.id,
    authorId: comment.authorId,
    isRoot: origin?.rootCommentId === comment.id,
    threadAuthorId: origin?.authorId ?? null,
    syncStates: thread.syncStates,
  });
}

/** A target with no surface admits every surface; the legacy routes name one. */
export function isThreadOnTargetSurface(
  thread: { source: ThreadSource; metadata: unknown },
  target: CommentTarget
): boolean {
  const surface = storedThreadSurface(thread);
  if (!surface) {
    return false;
  }
  return target.surface === undefined || surface === target.surface;
}
