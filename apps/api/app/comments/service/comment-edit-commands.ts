import {
  COMMENT_SOURCE_POLICIES,
  CommentCapability,
} from "@repo/api/src/types/comment-capabilities";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { Result } from "@repo/api/src/types/result";
import type { Prisma, TransactionClient } from "@repo/database";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import { textBody } from "../mention-body";
import {
  deleteAttachmentObjects,
  removeCommentAttachmentRows,
} from "./comment-attachment-commands";
import {
  type CommentLiveState,
  type CommentViewer,
  createCommentLiveState,
  isItemGranted,
} from "./comment-capabilities";
import {
  type CommentPresenter,
  type EditableComment,
  findCommentOnTarget,
} from "./comment-command-lookup";
import {
  type CommentWrite,
  type CommentWritten,
  runCommentCommand,
} from "./comment-command-pipeline";
import {
  type CommentTarget,
  commentTargetTypeFor,
  defaultCommentSurface,
  nativeCommentPolicyKey,
} from "./comment-target";
import { ThreadChangeKind } from "./comment-thread-signal";
import {
  notifyTraceMentions,
  readPersistedCommentMentions,
  scopeMentionsToOrg,
} from "./trace-comment-mentions";
import {
  indexTraceCommentAfterCommit,
  removeTraceCommentAfterCommit,
} from "./trace-comment-search-index";
import { settleTraceCommentSyncOnEdit } from "./trace-comment-sync-state";

type CommandActor = {
  viewer: CommentViewer;
  target: CommentTarget;
  liveState?: CommentLiveState;
};

export type CommentDeleteResult = { deleted: true };

/**
 * Edits a comment its viewer wrote. With `expectedRevision`, a comment whose
 * revision has moved on is `stale_revision` and nothing is written; without
 * it the edit is last-writer-wins, as the legacy routes have always been.
 */
export function editComment<T>(
  input: CommandActor & {
    commentId: string;
    body: string;
    mentions?: readonly string[];
    expectedRevision?: number;
    present: CommentPresenter<T>;
  },
  recordWrite?: RecordWriteInTransaction<CommentWritten>
): Promise<Result<T, CommentErrorCode>> {
  const { viewer, target } = input;
  const policyKey = nativeCommentPolicyKey(target.artifactType);
  return runCommentCommand({
    target,
    policyKey,
    liveState: input.liveState ?? createCommentLiveState(viewer),
    capability: CommentCapability.Edit,
    recordWrite,
    write: async (tx): Promise<Result<CommentWrite<T>, CommentErrorCode>> => {
      const found = await findOwnComment(tx, {
        target,
        viewer,
        commentId: input.commentId,
        capability: CommentCapability.Edit,
      });
      if (!found.ok) {
        return found;
      }
      const comment = found.value;
      const previousMentions = await readPersistedCommentMentions(
        tx,
        comment.commentId
      );
      const mentions =
        input.mentions === undefined
          ? previousMentions
          : await scopeMentionsToOrg(tx, target.organizationId, input.mentions);
      const written = await writeCommentEdit(tx, {
        commentId: comment.commentId,
        expectedRevision: input.expectedRevision,
        data: {
          body: textBody(input.body, mentions),
          bodyFormat: CommentBodyFormat.RichV1,
          plainText: input.body,
          editedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      if (!written) {
        return Result.err(CommentErrorCode.StaleRevision);
      }
      if (comment.isRoot) {
        await settleTraceCommentSyncOnEdit(tx, {
          organizationId: target.organizationId,
          threadId: comment.threadId,
          syncStates: comment.syncStates,
        });
      }
      return Result.ok({
        changes: [
          { threadId: comment.threadId, kind: ThreadChangeKind.Updated },
        ],
        commentId: comment.commentId,
        present: (client) =>
          input.present(client, { threadId: comment.threadId }),
        afterCommit: async () => {
          indexTraceCommentAfterCommit({
            organizationId: target.organizationId,
            commentId: comment.commentId,
            body: input.body,
            authorId: viewer.userId,
            anchorArtifactId: target.artifactId,
            targetType: commentTargetTypeFor(target.artifactType),
            updatedAt: new Date(),
          });
          await notifyTraceMentions({
            resolved: {
              artifactId: target.artifactId,
              surface:
                target.surface ?? defaultCommentSurface(target.artifactType),
            },
            organizationId: target.organizationId,
            actorUserId: viewer.userId,
            nextMentions: mentions,
            previousMentions,
            commentId: comment.commentId,
            commentBody: input.body,
          });
        },
      });
    },
  });
}

/**
 * Deletes a comment its viewer wrote. Deleting a root soft-deletes every live
 * comment in the thread and keeps the thread row, so the thread is updated,
 * not removed.
 */
export function deleteComment(
  input: CommandActor & { commentId: string },
  recordWrite?: RecordWriteInTransaction<CommentWritten>
): Promise<Result<CommentDeleteResult, CommentErrorCode>> {
  const { viewer, target } = input;
  return runCommentCommand({
    target,
    policyKey: nativeCommentPolicyKey(target.artifactType),
    liveState: input.liveState ?? createCommentLiveState(viewer),
    capability: CommentCapability.Delete,
    recordWrite,
    write: async (
      tx
    ): Promise<Result<CommentWrite<CommentDeleteResult>, CommentErrorCode>> => {
      const found = await findOwnComment(tx, {
        target,
        viewer,
        commentId: input.commentId,
        capability: CommentCapability.Delete,
      });
      if (!found.ok) {
        return found;
      }
      const removedCommentIds = await softDeleteComment(tx, found.value);
      const removedObjects = await removeCommentAttachmentRows(
        tx,
        removedCommentIds
      );
      return Result.ok({
        changes: [
          { threadId: found.value.threadId, kind: ThreadChangeKind.Updated },
        ],
        commentId: found.value.commentId,
        present: () => Promise.resolve({ deleted: true } as const),
        afterCommit: async () => {
          for (const commentId of removedCommentIds) {
            removeTraceCommentAfterCommit({
              organizationId: target.organizationId,
              commentId,
            });
          }
          await deleteAttachmentObjects(target.organizationId, removedObjects);
        },
      });
    },
  });
}

/** The comment on the target, `capability_denied` unless the grant admits this viewer. */
async function findOwnComment(
  tx: TransactionClient,
  input: {
    target: CommentTarget;
    viewer: CommentViewer;
    commentId: string;
    capability: typeof CommentCapability.Edit | typeof CommentCapability.Delete;
  }
): Promise<Result<EditableComment, CommentErrorCode>> {
  const found = await findCommentOnTarget(tx, input.target, input.commentId);
  if (!found.ok) {
    return found;
  }
  const grant =
    COMMENT_SOURCE_POLICIES[nativeCommentPolicyKey(input.target.artifactType)]
      .capabilities[input.capability];
  return isItemGranted(grant, {
    viewerUserId: input.viewer.userId,
    commentAuthorId: found.value.authorId,
    threadAuthorId: found.value.threadAuthorId,
    threadParticipantIds: new Set(),
  })
    ? found
    : Result.err(CommentErrorCode.CapabilityDenied);
}

/**
 * With `expectedRevision` the revision is a predicate of the UPDATE itself, so
 * of two edits racing from the same revision only the first matches a row.
 * `false` means none matched and nothing was written.
 */
async function writeCommentEdit(
  tx: TransactionClient,
  input: {
    commentId: string;
    expectedRevision: number | undefined;
    data: Prisma.CommentUpdateManyMutationInput;
  }
): Promise<boolean> {
  if (input.expectedRevision === undefined) {
    await tx.comment.update({
      where: { id: input.commentId },
      data: input.data,
      select: { id: true },
    });
    return true;
  }
  const updated = await tx.comment.updateMany({
    where: {
      id: input.commentId,
      deletedAt: null,
      revision: input.expectedRevision,
    },
    data: input.data,
  });
  return updated.count > 0;
}

/**
 * A root delete soft-deletes the whole thread; the ids are captured first so
 * every deleted comment's search row is removed, not just the root's.
 */
async function softDeleteComment(
  tx: TransactionClient,
  comment: EditableComment
): Promise<string[]> {
  const deletedAt = new Date();
  if (comment.isRoot) {
    const affected = await tx.comment.findMany({
      where: { threadId: comment.threadId, deletedAt: null },
      select: { id: true },
    });
    await tx.comment.updateMany({
      where: { threadId: comment.threadId, deletedAt: null },
      data: { deletedAt, revision: { increment: 1 } },
    });
    return affected.map((row) => row.id);
  }
  await tx.comment.update({
    where: { id: comment.commentId },
    data: { deletedAt, revision: { increment: 1 } },
    select: { id: true },
  });
  return [comment.commentId];
}
