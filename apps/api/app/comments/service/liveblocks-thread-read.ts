import type {
  CommentThreadWithComments,
  ThreadSource,
  ThreadStatus,
} from "@repo/api/src/types/comment";
import { TRACE_COMMENT_METADATA_KIND } from "@repo/api/src/types/comment";
import type { JsonObject } from "@repo/api/src/types/common";
import type { BasicUser } from "@repo/api/src/types/user";
import { Prisma, withDb } from "@repo/database";
import { parseJsonObject } from "@/lib/json-schema";
import {
  deriveThreadAuthorship,
  type ThreadAuthorship,
} from "../thread-participants";

/** The Liveblocks document-thread reads, spread into `commentsService`. */
export const liveblocksThreadReads = {
  /**
   * Resolve the full authorship of a comment thread by its Liveblocks external
   * id, org-scoped, in one query: `authorId` is the thread creator (`createdById`
   * when the create webhook populated it, else the oldest comment's author, which
   * is always projected) or `null` when the thread is unknown in this org or its
   * author cannot be determined; `participantIds` is the author plus every comment
   * author on the thread, empty when unattributable. Used by the Liveblocks
   * `threadMarkedAsResolved`/`threadMarkedAsUnresolved` webhooks to enforce the
   * participant-resolve / author-only-reopen guards against the actor Liveblocks
   * reports (`updatedBy`) — mirroring the REST guards so the direct-SDK path and
   * the REST path agree. Both fields come from a single row read so the webhook
   * reject path does not re-query the same thread (FEA-3950, FEA-4092).
   */
  getThreadAuthorship(
    organizationId: string,
    threadExternalId: string
  ): Promise<ThreadAuthorship> {
    return withDb(async (db) => {
      const thread = await db.commentThread.findUnique({
        where: {
          organizationId_externalId: {
            organizationId,
            externalId: threadExternalId,
          },
        },
        select: {
          createdById: true,
          comments: {
            orderBy: { createdAt: "asc" },
            select: { authorId: true },
          },
        },
      });
      if (!thread) {
        return { authorId: null, participantIds: new Set<string>() };
      }
      return deriveThreadAuthorship(thread);
    });
  },

  /**
   * Find all threads for a given artifact entity, optionally filtered by source
   * or status.
   */
  findThreadsByDocument(
    organizationId: string,
    entityId: string,
    options?: { source?: ThreadSource; status?: ThreadStatus }
  ): Promise<CommentThreadWithComments[]> {
    return withDb(async (db) => {
      const rows = await db.commentThread.findMany({
        where: {
          organizationId,
          artifactId: entityId,
          source: options?.source,
          status: options?.status,
        },
        select: {
          id: true,
          organizationId: true,
          source: true,
          externalId: true,
          roomId: true,
          artifactId: true,
          status: true,
          metadata: true,
          createdAtVersion: true,
          resolvedAt: true,
          resolvedById: true,
          createdById: true,
          createdAt: true,
          updatedAt: true,
          comments: {
            where: { deletedAt: null },
            select: {
              id: true,
              threadId: true,
              authorId: true,
              body: true,
              plainText: true,
              externalId: true,
              editedAt: true,
              deletedAt: true,
              createdAt: true,
              updatedAt: true,
              reactions: {
                select: {
                  id: true,
                  commentId: true,
                  userId: true,
                  emoji: true,
                  createdAt: true,
                },
              },
              attachments: {
                select: {
                  id: true,
                  commentId: true,
                  externalId: true,
                  name: true,
                  size: true,
                  mimeType: true,
                  url: true,
                  createdAt: true,
                },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      // Resolve every comment author AND every thread's resolver so the read
      // projection can hydrate `resolvedBy` (the resolved-by caption the rail
      // renders) rather than always emitting null.
      const authorIds = [
        ...new Set([
          ...rows.flatMap((row) =>
            row.comments.map((comment) => comment.authorId)
          ),
          ...rows.flatMap((row) =>
            row.resolvedById ? [row.resolvedById] : []
          ),
        ]),
      ];
      const authors =
        authorIds.length > 0
          ? await db.user.findMany({
              where: {
                organizationId,
                id: { in: authorIds },
              },
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                avatarUrl: true,
              },
            })
          : [];
      const authorsById = new Map(authors.map((author) => [author.id, author]));
      return rows
        .filter((row) => !isTraceCommentThreadMetadata(row.metadata))
        .map((row) => toCommentThreadWithComments(row, authorsById));
    });
  },
};

export function commentThreadMetadataObject(metadata: unknown): JsonObject {
  return metadata === Prisma.JsonNull ? {} : (parseJsonObject(metadata) ?? {});
}

function isTraceCommentThreadMetadata(metadata: unknown): boolean {
  return (
    commentThreadMetadataObject(metadata).kind === TRACE_COMMENT_METADATA_KIND
  );
}

/**
 * Map a Prisma CommentThread row (with comments included) to the API type.
 * `resolvedBy` is hydrated from `usersById` (the shared comment-author +
 * resolver lookup) when `resolvedById` is set; `createdBy` is not fetched — set
 * to null. Prisma's `Json` fields are cast to our stricter `JsonObject` type.
 */
function toCommentThreadWithComments(
  row: Prisma.CommentThreadGetPayload<{
    select: {
      id: true;
      organizationId: true;
      source: true;
      externalId: true;
      roomId: true;
      artifactId: true;
      status: true;
      metadata: true;
      createdAtVersion: true;
      resolvedAt: true;
      resolvedById: true;
      createdById: true;
      createdAt: true;
      updatedAt: true;
      comments: {
        select: {
          id: true;
          threadId: true;
          authorId: true;
          body: true;
          plainText: true;
          externalId: true;
          editedAt: true;
          deletedAt: true;
          createdAt: true;
          updatedAt: true;
          reactions: {
            select: {
              id: true;
              commentId: true;
              userId: true;
              emoji: true;
              createdAt: true;
            };
          };
          attachments: {
            select: {
              id: true;
              commentId: true;
              externalId: true;
              name: true;
              size: true;
              mimeType: true;
              url: true;
              createdAt: true;
            };
          };
        };
      };
    };
  }>,
  authorsById: ReadonlyMap<string, BasicUser>
): CommentThreadWithComments {
  return {
    id: row.id,
    organizationId: row.organizationId,
    source: row.source,
    externalId: row.externalId,
    roomId: row.roomId,
    artifactId: row.artifactId,
    status: row.status,
    metadata: row.metadata as JsonObject | null,
    createdAtVersion: row.createdAtVersion,
    resolvedAt: row.resolvedAt,
    resolvedById: row.resolvedById,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedBy: row.resolvedById
      ? (authorsById.get(row.resolvedById) ?? null)
      : null,
    createdBy: null,
    comments: row.comments.map((c) => ({
      id: c.id,
      threadId: c.threadId,
      authorId: c.authorId,
      body: c.body as JsonObject,
      plainText: c.plainText,
      externalId: c.externalId,
      editedAt: c.editedAt,
      deletedAt: c.deletedAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      author: authorsById.get(c.authorId) ?? null,
      reactions: c.reactions,
      attachments: c.attachments,
    })),
  };
}
