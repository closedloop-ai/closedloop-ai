import type { CommentThreadWithComments } from "@repo/api/src/types/comment";
import {
  ThreadSource,
  ThreadStatus,
  TRACE_COMMENT_METADATA_KIND,
} from "@repo/api/src/types/comment";
import type { JsonObject } from "@repo/api/src/types/common";
import { createArtifactThread as createLiveblocksThread } from "@repo/collaboration/server/room-management";
import type {
  CommentData,
  ThreadData,
} from "@repo/collaboration/server/webhook";
import {
  generateDocumentRoomId,
  parseDocumentRoomId,
} from "@repo/collaboration/shared/room-utils";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { parseJsonObject } from "@/lib/json-schema";
import { extractPlainText } from "./plain-text";

export const GitHubReviewThreadResolutionAttributionKind = {
  ConnectedUser: "connected_user",
  ExternalUnconnected: "external_unconnected",
  LegacyMissing: "legacy_missing",
} as const;

export type GitHubReviewThreadResolutionAttributionKind =
  (typeof GitHubReviewThreadResolutionAttributionKind)[keyof typeof GitHubReviewThreadResolutionAttributionKind];

const GITHUB_REVIEW_THREAD_RESOLUTION_ATTRIBUTION_KEY =
  "githubReviewThreadResolutionAttribution";

export type GitHubReviewThreadResolutionAttribution = {
  kind: GitHubReviewThreadResolutionAttributionKind;
  githubUserId: string | null;
  githubNodeId: string | null;
  githubLogin: string | null;
  source: "pull_request_review_thread";
  recordedAt: string;
};

const githubReviewThreadResolutionAttributionSchema: z.ZodType<GitHubReviewThreadResolutionAttribution> =
  z.object({
    kind: z.union([
      z.literal(GitHubReviewThreadResolutionAttributionKind.ConnectedUser),
      z.literal(
        GitHubReviewThreadResolutionAttributionKind.ExternalUnconnected
      ),
      z.literal(GitHubReviewThreadResolutionAttributionKind.LegacyMissing),
    ]),
    githubUserId: z.string().nullable(),
    githubNodeId: z.string().nullable(),
    githubLogin: z.string().nullable(),
    source: z.literal("pull_request_review_thread"),
    recordedAt: z.string(),
  });

type GitHubReviewThreadResolutionInput = {
  resolvedAt: Date;
  resolvedById?: string | null;
  attribution: GitHubReviewThreadResolutionAttribution;
};

type CommentThreadResolutionMutationKind =
  | "transition"
  | "metadata_repair"
  | "noop";

type CommentThreadResolutionMutationResult = {
  kind: CommentThreadResolutionMutationKind;
  thread: {
    id: string;
    status: ThreadStatus;
    resolvedAt: Date | null;
    resolvedById: string | null;
    metadata: JsonObject | null;
  };
} | null;

export const commentsService = {
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
   */
  async upsertThreadFromLiveblocks(
    organizationId: string,
    thread: ThreadData,
    createdBy?: string
  ) {
    const artifact = await findArtifactForRoom(organizationId, thread.roomId);
    const metadata = thread.metadata ?? Prisma.JsonNull;
    const metadataVersion = thread.metadata?.version;
    const createdAtVersion =
      typeof metadataVersion === "number"
        ? metadataVersion
        : (artifact?.latestVersion ?? null);

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
          artifactId: artifact?.artifactId ?? null,
          status: thread.resolved ? ThreadStatus.Resolved : ThreadStatus.Open,
          resolvedAt: thread.resolved ? thread.updatedAt : null,
          metadata,
          createdAtVersion,
          createdAt: thread.createdAt,
          createdById: createdBy,
        },
        update: {
          roomId: thread.roomId,
          artifactId: artifact?.artifactId,
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
   * Mark a thread as resolved and return whether durable state changed.
   * GitHub review-thread webhooks pass attribution metadata; Liveblocks callers
   * keep the legacy behavior by omitting it.
   */
  resolveThread(
    organizationId: string,
    threadExternalId: string,
    resolvedAt: Date,
    options?: Omit<GitHubReviewThreadResolutionInput, "resolvedAt">
  ): Promise<CommentThreadResolutionMutationResult> {
    // Read-mutate-write in a single transaction, locking the row up front with
    // SELECT ... FOR UPDATE so concurrent resolve calls can't lost-update each
    // other's metadata mutation under READ COMMITTED.
    return withDb.tx(async (tx) => {
      await lockCommentThreadRow(tx, organizationId, threadExternalId);
      const existing = await tx.commentThread.findUnique({
        where: {
          organizationId_externalId: {
            organizationId,
            externalId: threadExternalId,
          },
        },
        select: {
          id: true,
          status: true,
          resolvedAt: true,
          resolvedById: true,
          metadata: true,
        },
      });
      if (!existing) {
        return null;
      }

      const metadata = commentThreadMetadataObject(existing.metadata);
      const existingAttribution = getResolutionAttribution(metadata);
      const nextMetadata = options?.attribution
        ? {
            ...metadata,
            [GITHUB_REVIEW_THREAD_RESOLUTION_ATTRIBUTION_KEY]:
              options.attribution,
          }
        : metadata;
      const isResolved = existing.status === ThreadStatus.Resolved;
      const shouldRepairMetadata =
        isResolved &&
        options?.attribution !== undefined &&
        isRepairableResolutionAttribution(existingAttribution);

      if (isResolved && !shouldRepairMetadata) {
        return {
          kind: "noop",
          thread: {
            ...existing,
            status: existing.status as ThreadStatus,
            metadata,
          },
        };
      }

      const thread = await tx.commentThread.update({
        where: { id: existing.id },
        data: {
          status: ThreadStatus.Resolved,
          resolvedAt: isResolved
            ? (existing.resolvedAt ?? resolvedAt)
            : resolvedAt,
          resolvedById: isResolved
            ? (existing.resolvedById ?? options?.resolvedById ?? null)
            : (options?.resolvedById ?? null),
          metadata: nextMetadata,
        },
        select: {
          id: true,
          status: true,
          resolvedAt: true,
          resolvedById: true,
          metadata: true,
        },
      });
      return {
        kind: shouldRepairMetadata ? "metadata_repair" : "transition",
        thread: toResolutionThreadResult(thread),
      };
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

  /**
   * Mark a thread as unresolved, clearing resolution attribution without
   * disturbing unrelated thread metadata.
   */
  unresolveThread(
    organizationId: string,
    threadExternalId: string
  ): Promise<CommentThreadResolutionMutationResult> {
    // Read-mutate-write in a single transaction, locking the row up front with
    // SELECT ... FOR UPDATE so concurrent unresolve calls can't lost-update
    // each other's metadata mutation under READ COMMITTED.
    return withDb.tx(async (tx) => {
      await lockCommentThreadRow(tx, organizationId, threadExternalId);
      const existing = await tx.commentThread.findUnique({
        where: {
          organizationId_externalId: {
            organizationId,
            externalId: threadExternalId,
          },
        },
        select: {
          id: true,
          status: true,
          resolvedAt: true,
          resolvedById: true,
          metadata: true,
        },
      });
      if (!existing) {
        return null;
      }

      const metadata = commentThreadMetadataObject(existing.metadata);
      const nextMetadata = clearResolutionAttribution(metadata);
      const hadStaleResolutionData =
        existing.resolvedAt !== null ||
        existing.resolvedById !== null ||
        getResolutionAttribution(metadata) !== null;
      const isTransition = existing.status === ThreadStatus.Resolved;

      if (!(isTransition || hadStaleResolutionData)) {
        return {
          kind: "noop",
          thread: {
            ...existing,
            status: existing.status as ThreadStatus,
            metadata,
          },
        };
      }

      const thread = await tx.commentThread.update({
        where: { id: existing.id },
        data: {
          status: ThreadStatus.Open,
          resolvedAt: null,
          resolvedById: null,
          metadata: nextMetadata,
        },
        select: {
          id: true,
          status: true,
          resolvedAt: true,
          resolvedById: true,
          metadata: true,
        },
      });
      return {
        kind: isTransition ? "transition" : "metadata_repair",
        thread: toResolutionThreadResult(thread),
      };
    });
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
          artifactId: entityId,
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
      return rows
        .filter((row) => !isTraceCommentThreadMetadata(row.metadata))
        .map(toCommentThreadWithComments);
    });
  },

  createDocumentThread,
  createUnanchoredDocumentThread,
};

/**
 * Minimal ProseMirror-style doc for a plain-text native comment body. Native
 * comment rows set `plainText` directly rather than relying on
 * `extractPlainText`, which only understands the Liveblocks CommentBody
 * format.
 */
export function textBody(text: string): Prisma.InputJsonObject {
  const paragraph = {
    type: "paragraph",
    content: text ? [{ type: "text", text }] : [],
  } satisfies Prisma.InputJsonObject;

  return {
    type: "doc",
    content: [paragraph],
  } satisfies Prisma.InputJsonObject;
}

/**
 * Create an unanchored artifact-level note: a NATIVE thread plus root comment
 * written directly to the DB, with no Liveblocks room, externalId, or anchor
 * metadata. The single nested create keeps thread+comment atomic.
 */
function createUnanchoredDocumentThread(
  organizationId: string,
  artifactId: string,
  userId: string,
  bodyText: string
): Promise<{ threadId: string; commentId: string }> {
  return withDb(async (db) => {
    const artifact = await db.artifact.findFirst({
      where: { id: artifactId, organizationId },
      select: { id: true },
    });
    if (!artifact) {
      throw new Error("Artifact not found in this organization");
    }
    const thread = await db.commentThread.create({
      data: {
        organizationId,
        artifactId,
        source: ThreadSource.Native,
        status: ThreadStatus.Open,
        createdById: userId,
        comments: {
          create: {
            authorId: userId,
            body: textBody(bodyText),
            plainText: bodyText,
          },
        },
      },
      select: { id: true, comments: { select: { id: true } } },
    });
    const commentId = thread.comments[0]?.id;
    if (!commentId) {
      throw new Error("Thread created but returned no comment");
    }
    return { threadId: thread.id, commentId };
  });
}

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

  // Look up the artifact's current latestVersion so we can stamp it into
  // Liveblocks ThreadMetadata.version at creation time. The subsequent DB
  // upsert (`upsertThreadFromLiveblocks`) re-resolves this and writes
  // `createdAtVersion` to keep both sources of truth in sync.
  const artifact = await findArtifactForRoom(organizationId, roomId);

  const threadData = await createLiveblocksThread({
    roomId,
    userId,
    bodyText,
    anchorText,
    version: artifact?.latestVersion ?? undefined,
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

function commentThreadMetadataObject(metadata: unknown): JsonObject {
  return metadata === Prisma.JsonNull ? {} : (parseJsonObject(metadata) ?? {});
}

function isTraceCommentThreadMetadata(metadata: unknown): boolean {
  return (
    commentThreadMetadataObject(metadata).kind === TRACE_COMMENT_METADATA_KIND
  );
}

/**
 * Acquire a row-level lock on the `comment_threads` row for this
 * organization + externalId so a read-modify-write of `metadata` inside a
 * `withDb.tx` transaction can't lost-update a concurrent mutation. Under the
 * default READ COMMITTED isolation a plain read-then-`update` does NOT prevent
 * lost updates: two concurrent resolves can both read `metadata: {}` and the
 * second `update` silently overwrites the first's attribution. `SELECT ... FOR
 * UPDATE` serializes them — the second transaction blocks until the first
 * commits, then re-reads the now-committed metadata. The lock is released when
 * the surrounding transaction commits or rolls back. A no-op when the row does
 * not exist (the subsequent `findUnique` returns null and the caller bails).
 */
async function lockCommentThreadRow(
  tx: TransactionClient,
  organizationId: string,
  externalId: string
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT id
    FROM comment_threads
    WHERE organization_id = ${organizationId}::uuid
      AND external_id = ${externalId}
    FOR UPDATE
  `);
}

function getResolutionAttribution(
  metadata: JsonObject
): GitHubReviewThreadResolutionAttribution | null {
  const value = metadata[GITHUB_REVIEW_THREAD_RESOLUTION_ATTRIBUTION_KEY];
  const parsed = githubReviewThreadResolutionAttributionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isRepairableResolutionAttribution(
  attribution: GitHubReviewThreadResolutionAttribution | null
): boolean {
  return (
    attribution === null ||
    attribution.kind ===
      GitHubReviewThreadResolutionAttributionKind.LegacyMissing
  );
}

function clearResolutionAttribution(metadata: JsonObject): JsonObject {
  const nextMetadata = { ...metadata };
  Reflect.deleteProperty(
    nextMetadata,
    GITHUB_REVIEW_THREAD_RESOLUTION_ATTRIBUTION_KEY
  );
  return nextMetadata;
}

function toResolutionThreadResult(thread: {
  id: string;
  status: string;
  resolvedAt: Date | null;
  resolvedById: string | null;
  metadata: unknown;
}): NonNullable<CommentThreadResolutionMutationResult>["thread"] {
  return {
    id: thread.id,
    status: thread.status as ThreadStatus,
    resolvedAt: thread.resolvedAt,
    resolvedById: thread.resolvedById,
    metadata: commentThreadMetadataObject(thread.metadata),
  };
}

/**
 * Map a Prisma CommentThread row (with comments included) to the API type.
 * `resolvedBy` and `createdBy` are not fetched — set to null.
 * Prisma's `Json` fields are cast to our stricter `JsonObject` type.
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
  }>
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
    resolvedBy: null,
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
      reactions: c.reactions,
      attachments: c.attachments,
    })),
  };
}

/**
 * Parse roomId to find the associated artifact entity and the document's
 * current `latestVersion` (used as a fallback when stamping
 * `CommentThread.createdAtVersion`). Returns null for non-artifact rooms
 * or when the artifact is not found. `latestVersion` is null when the
 * artifact exists but has no `Document` row (e.g. branch artifacts) so
 * callers can distinguish "no document" from "document at v1".
 */
async function findArtifactForRoom(
  organizationId: string,
  roomId: string
): Promise<{ artifactId: string; latestVersion: number | null } | null> {
  try {
    const { slug } = parseDocumentRoomId(roomId);

    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { organizationId_slug: { organizationId, slug } },
        select: { id: true, document: { select: { latestVersion: true } } },
      })
    );

    if (!artifact) {
      return null;
    }

    return {
      artifactId: artifact.id,
      latestVersion: artifact.document?.latestVersion ?? null,
    };
  } catch {
    // Non-artifact room format — expected, not an error
    return null;
  }
}
