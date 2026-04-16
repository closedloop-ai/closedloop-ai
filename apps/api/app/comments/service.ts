import type { CommentThreadWithComments } from "@repo/api/src/types/comment";
import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import type { JsonObject } from "@repo/api/src/types/common";
import { EntityType } from "@repo/api/src/types/entity-link";
import { createArtifactThread as createLiveblocksThread } from "@repo/collaboration/room-management";
import {
  generateDocumentRoomId,
  parseDocumentRoomId,
} from "@repo/collaboration/room-utils";
import type { CommentData, ThreadData } from "@repo/collaboration/webhook";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { extractPlainText } from "./plain-text";

export const commentsService = {
  /**
   * Upsert a thread from Liveblocks webhook data.
   * Uses @@unique([organizationId, externalId]) for idempotent upserts.
   */
  async upsertThreadFromLiveblocks(
    organizationId: string,
    thread: ThreadData,
    createdBy?: string
  ) {
    const entity = await findEntityForRoom(organizationId, thread.roomId);
    const metadata = thread.metadata ?? Prisma.JsonNull;

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
          entityId: entity?.entityId ?? null,
          entityType: entity?.entityType ?? null,
          status: thread.resolved ? ThreadStatus.Resolved : ThreadStatus.Open,
          resolvedAt: thread.resolved ? thread.updatedAt : null,
          metadata,
          createdAt: thread.createdAt,
          createdById: createdBy,
        },
        update: {
          roomId: thread.roomId,
          entityId: entity?.entityId,
          entityType: entity?.entityType,
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
          plainText,
          externalId: comment.id,
          editedAt: comment.editedAt ?? null,
          deletedAt: comment.deletedAt ?? null,
          createdAt: comment.createdAt,
        },
        update: {
          body,
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
   * Mark a thread as resolved.
   */
  resolveThread(
    organizationId: string,
    threadExternalId: string,
    resolvedAt: Date
  ) {
    return withDb((db) =>
      db.commentThread.update({
        where: {
          organizationId_externalId: {
            organizationId,
            externalId: threadExternalId,
          },
        },
        data: {
          status: ThreadStatus.Resolved,
          resolvedAt,
        },
      })
    );
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

  /**
   * Mark a thread as unresolved.
   */
  unresolveThread(organizationId: string, threadExternalId: string) {
    return withDb((db) =>
      db.commentThread.update({
        where: {
          organizationId_externalId: {
            organizationId,
            externalId: threadExternalId,
          },
        },
        data: {
          status: ThreadStatus.Open,
          resolvedAt: null,
        },
      })
    );
  },

  /**
   * Find all threads for a given artifact entity, optionally filtered by status.
   */
  findThreadsByDocument(
    organizationId: string,
    entityId: string,
    options?: { status?: ThreadStatus }
  ): Promise<CommentThreadWithComments[]> {
    return withDb(async (db) => {
      const rows = await db.commentThread.findMany({
        where: {
          organizationId,
          entityId,
          entityType: EntityType.Document,
          status: options?.status,
        },
        include: {
          comments: {
            where: { deletedAt: null },
            include: { reactions: true, attachments: true },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toCommentThreadWithComments);
    });
  },

  createDocumentThread,
};

/**
 * Create a Liveblocks thread on an artifact and persist to DB (best-effort).
 * Encapsulates room ID computation, Liveblocks SDK call, and DB sync.
 * Throws on Liveblocks errors; DB failures are logged but do not throw.
 */
async function createDocumentThread(
  organizationId: string,
  documentSlug: string,
  userId: string,
  bodyText: string,
  anchorText: string
): Promise<{ threadId: string; commentId: string }> {
  const roomId = generateDocumentRoomId(organizationId, documentSlug);

  const threadData = await createLiveblocksThread({
    roomId,
    userId,
    bodyText,
    anchorText,
  });

  const firstComment = threadData.comments[0];
  if (!firstComment) {
    throw new Error("Thread created but returned no comment");
  }

  try {
    await commentsService.upsertThreadFromLiveblocks(
      organizationId,
      threadData
    );
    await commentsService.upsertCommentFromLiveblocks(
      organizationId,
      threadData.id,
      firstComment
    );
  } catch (dbError) {
    log.warn("Best-effort DB sync failed after thread creation", {
      error: dbError instanceof Error ? dbError.message : String(dbError),
      threadId: threadData.id,
    });
  }

  return { threadId: threadData.id, commentId: firstComment.id };
}

/**
 * Map a Prisma CommentThread row (with comments included) to the API type.
 * `resolvedBy` and `createdBy` are not fetched — set to null.
 * Prisma's `Json` fields are cast to our stricter `JsonObject` type.
 */
function toCommentThreadWithComments(
  row: Prisma.CommentThreadGetPayload<{
    include: {
      comments: { include: { reactions: true; attachments: true } };
    };
  }>
): CommentThreadWithComments {
  return {
    ...row,
    metadata: row.metadata as JsonObject | null,
    resolvedBy: null,
    createdBy: null,
    comments: row.comments.map((c) => ({
      ...c,
      body: c.body as JsonObject,
    })),
  };
}

/**
 * Parse roomId to find the associated artifact entity.
 * Returns null for non-artifact rooms or if artifact not found.
 */
async function findEntityForRoom(
  organizationId: string,
  roomId: string
): Promise<{ entityId: string; entityType: EntityType } | null> {
  try {
    const { slug } = parseDocumentRoomId(roomId);

    const artifact = await withDb((db) =>
      db.document.findUnique({
        where: { organizationId_slug: { organizationId, slug } },
        select: { id: true },
      })
    );

    if (!artifact) {
      return null;
    }

    return { entityId: artifact.id, entityType: EntityType.Document };
  } catch {
    // Non-artifact room format — expected, not an error
    return null;
  }
}
