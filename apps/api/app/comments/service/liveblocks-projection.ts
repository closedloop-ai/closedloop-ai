import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import type {
  CommentData,
  ThreadData,
} from "@repo/collaboration/server/webhook";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { findArtifactForRoom } from "../artifact-for-room";
import {
  CommentDataInvalidReason,
  reportCommentDataInvalid,
} from "../comment-data-invalid";
import { extractPlainText } from "../plain-text";

/** The Liveblocks webhook projection writers, spread into `commentsService`. */
export const liveblocksProjectionWriters = {
  /**
   * Upsert a thread from Liveblocks webhook data.
   * Uses @@unique([organizationId, externalId]) for idempotent upserts.
   *
   * On create, `createdAtVersion` is sourced from
   * `thread.metadata.version` (set client-side by the composer at the
   * moment the user is composing). Falls back to the artifact's current
   * `latestVersion` only when no client-supplied version is present —
   * this matters for race conditions where the artifact advances between
   * the composer opening and the thread being submitted, and for legacy
   * threads created before the composer started stamping the field.
   * On update, leaves `createdAtVersion` untouched (immutable for the
   * life of the thread).
   *
   * ISS-11212: a room that resolves to no artifact writes nothing and is
   * reported as `comments.data_invalid`, so no thread is stored without an
   * artifact; the webhook still answers 200.
   */
  async upsertThreadFromLiveblocks(
    organizationId: string,
    thread: ThreadData,
    createdBy?: string
  ) {
    const artifact = await findArtifactForRoom(organizationId, thread.roomId);
    if (!artifact) {
      reportCommentDataInvalid({
        reason: CommentDataInvalidReason.ThreadWithoutArtifact,
        organizationId,
        threadId: thread.id,
        roomId: thread.roomId,
      });
      return null;
    }
    const metadata = thread.metadata ?? Prisma.JsonNull;
    const metadataVersion = thread.metadata?.version;
    const createdAtVersion =
      typeof metadataVersion === "number"
        ? metadataVersion
        : artifact.latestVersion;

    return withDb((db) =>
      db.commentThread.upsert({
        where: {
          organizationId_externalId: {
            organizationId,
            externalId: thread.id,
          },
        },
        create: {
          organizationId,
          source: ThreadSource.Liveblocks,
          externalId: thread.id,
          roomId: thread.roomId,
          artifactId: artifact.artifactId,
          status: thread.resolved ? ThreadStatus.Resolved : ThreadStatus.Open,
          resolvedAt: thread.resolved ? thread.updatedAt : null,
          metadata,
          createdAtVersion,
          createdAt: thread.createdAt,
          createdById: createdBy,
        },
        update: {
          roomId: thread.roomId,
          artifactId: artifact.artifactId,
          status: thread.resolved ? ThreadStatus.Resolved : ThreadStatus.Open,
          resolvedAt: thread.resolved ? thread.updatedAt : null,
          metadata,
          createdById: createdBy,
        },
      })
    );
  },

  /**
   * Upsert a comment from Liveblocks webhook data.
   * Full-replace pattern for attachments and reactions.
   */
  async upsertCommentFromLiveblocks(
    organizationId: string,
    threadExternalId: string,
    comment: CommentData
  ) {
    const thread = await withDb((db) =>
      db.commentThread.findUnique({
        where: {
          organizationId_externalId: {
            organizationId,
            externalId: threadExternalId,
          },
        },
        select: { id: true },
      })
    );

    if (!thread) {
      log.warn("[commentThreadsService] Thread not found for comment upsert", {
        organizationId,
        threadExternalId,
        commentId: comment.id,
      });
      return null;
    }

    const body = comment.body ?? {};
    const plainText = extractPlainText(comment.body);

    return withDb.tx(async (tx) => {
      const upserted = await tx.comment.upsert({
        where: { externalId: comment.id },
        create: {
          threadId: thread.id,
          authorId: comment.userId,
          body,
          bodyFormat: CommentBodyFormat.LiveblocksV1,
          plainText,
          externalId: comment.id,
          editedAt: comment.editedAt ?? null,
          deletedAt: comment.deletedAt ?? null,
          createdAt: comment.createdAt,
        },
        update: {
          body,
          bodyFormat: CommentBodyFormat.LiveblocksV1,
          plainText,
          editedAt: comment.editedAt ?? null,
          deletedAt: comment.deletedAt ?? null,
        },
      });

      // Full-replace attachments
      await tx.commentAttachment.deleteMany({
        where: { commentId: upserted.id },
      });
      if (comment.attachments.length > 0) {
        await tx.commentAttachment.createMany({
          data: comment.attachments.map((att) => ({
            commentId: upserted.id,
            externalId: att.id,
            name: att.name,
            size: att.size,
            mimeType: att.mimeType,
            url: null,
          })),
        });
      }

      // Full-replace reactions
      await tx.commentReaction.deleteMany({
        where: { commentId: upserted.id },
      });
      const reactionRows = comment.reactions.flatMap((reaction) =>
        reaction.users.map((user) => ({
          commentId: upserted.id,
          userId: user.id,
          emoji: reaction.emoji,
          createdAt: reaction.createdAt,
        }))
      );
      if (reactionRows.length > 0) {
        await tx.commentReaction.createMany({ data: reactionRows });
      }

      return upserted;
    });
  },

  /**
   * Soft-delete a comment.
   */
  softDeleteComment(organizationId: string, commentExternalId: string) {
    return withDb(async (db) => {
      const comment = await db.comment.findUnique({
        where: { externalId: commentExternalId },
        select: {
          id: true,
          thread: { select: { organizationId: true } },
        },
      });

      if (comment?.thread.organizationId !== organizationId) {
        log.warn("[commentThreadsService] Comment not found for soft delete", {
          organizationId,
          commentExternalId,
        });
        return null;
      }

      return db.comment.update({
        where: { id: comment.id },
        data: {
          deletedAt: new Date(),
        },
      });
    });
  },

  /**
   * Hard-delete a thread and all its comments (cascade).
   */
  deleteThread(organizationId: string, threadExternalId: string) {
    return withDb((db) =>
      db.commentThread.deleteMany({
        where: {
          organizationId,
          externalId: threadExternalId,
        },
      })
    );
  },
};
