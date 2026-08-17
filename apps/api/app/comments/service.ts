import type { CommentThreadWithComments } from "@repo/api/src/types/comment";
import {
  ThreadSource,
  ThreadStatus,
  TRACE_COMMENT_METADATA_KIND,
} from "@repo/api/src/types/comment";
import type { JsonObject } from "@repo/api/src/types/common";
import type { BasicUser } from "@repo/api/src/types/user";
import type {
  CommentData,
  ThreadData,
} from "@repo/collaboration/server/webhook";
import { getLiveblocksApiClient } from "@repo/collaboration/server/webhook";
import {
  generateDocumentRoomId,
  parseDocumentRoomId,
} from "@repo/collaboration/shared/room-utils";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { parseJsonObject } from "@/lib/json-schema";
import { extractPlainText } from "./plain-text";
import { createDocumentThreadMutations } from "./service/document-thread-mutations";
import {
  deriveThreadAuthorship,
  type ThreadAuthorship,
} from "./thread-participants";

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
  /**
   * GitHub review-thread resolution attribution. Present for GitHub webhook
   * callers; omitted by native (document/Liveblocks) resolves, which only carry
   * a `resolvedById`. The resolve path reads it optionally.
   */
  attribution?: GitHubReviewThreadResolutionAttribution;
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

/**
 * Document-thread reply/resolve/unresolve mutation surface (FEA-3950). Built as
 * an internal module (`service/document-thread-mutations.ts`) that receives its
 * projection/lookup dependencies here rather than importing the `commentsService`
 * composition root, per the API service conventions. The dep closures reference
 * `commentsService.*` lazily — they run only at request time, after this module
 * has finished initializing.
 */
const documentThreadMutations = createDocumentThreadMutations({
  findArtifactForRoom,
  upsertThreadFromLiveblocks: (organizationId, thread) =>
    commentsService.upsertThreadFromLiveblocks(organizationId, thread),
  upsertCommentFromLiveblocks: (organizationId, threadExternalId, comment) =>
    commentsService.upsertCommentFromLiveblocks(
      organizationId,
      threadExternalId,
      comment
    ),
  syncThreadFromProvider: (organizationId, artifactId, threadExternalId) =>
    commentsService.syncDocumentThreadFromProvider(
      organizationId,
      artifactId,
      threadExternalId
    ),
  resolveThread: (organizationId, threadExternalId, resolvedAt, options) =>
    commentsService.resolveThread(
      organizationId,
      threadExternalId,
      resolvedAt,
      options
    ),
  unresolveThread: (organizationId, threadExternalId) =>
    commentsService.unresolveThread(organizationId, threadExternalId),
});

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
      const nextMetadata = options?.attribution
        ? {
            ...metadata,
            [GITHUB_REVIEW_THREAD_RESOLUTION_ATTRIBUTION_KEY]:
              options.attribution,
          }
        : metadata;
      const isResolved = existing.status === ThreadStatus.Resolved;
      const { shouldRepairMetadata, shouldRepairResolvedById } =
        computeResolveRepair({
          isResolved,
          existingResolvedById: existing.resolvedById,
          existingAttribution: getResolutionAttribution(metadata),
          options,
        });

      if (isResolved && !(shouldRepairMetadata || shouldRepairResolvedById)) {
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
        kind:
          shouldRepairMetadata || shouldRepairResolvedById
            ? "metadata_repair"
            : "transition",
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
   * Best-effort read-after-write fallback (FEA-3950): pull a Liveblocks thread
   * and its comments from the provider and project them into the local DB when
   * the create webhook has not landed yet. The Composer publishes straight to
   * Liveblocks and renders from `useThreads` immediately, so a reply/resolve
   * fired right after creation can beat the `threadCreated` webhook — without
   * this, the mutation lookup would 404 a thread that genuinely exists.
   *
   * Scoped to the caller's org + artifact: resolves the artifact's slug to build
   * the room id, so a thread id cannot be synced against the wrong document.
   * Returns `true` when a thread was fetched and projected, `false` when the
   * artifact/slug is unknown, Liveblocks is not configured, or the provider has
   * no such thread. Never throws for the not-found/misconfigured cases so the
   * caller can fall through to its own not-found handling.
   */
  async syncDocumentThreadFromProvider(
    organizationId: string,
    artifactId: string,
    threadExternalId: string
  ): Promise<boolean> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id: artifactId, organizationId },
        select: { slug: true },
      })
    );
    if (!artifact?.slug) {
      return false;
    }

    const client = getLiveblocksApiClient();
    if (!client) {
      return false;
    }

    const roomId = generateDocumentRoomId(organizationId, artifact.slug);
    let thread: ThreadData;
    try {
      thread = await client.getThread({ roomId, threadId: threadExternalId });
    } catch (error) {
      // Unknown thread / room at the provider is an expected miss, not a 500.
      log.info(
        "[commentThreadsService] Provider thread fetch failed during read-after-write fallback",
        {
          organizationId,
          artifactId,
          threadExternalId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return false;
    }

    await withDb.tx(async () => {
      await commentsService.upsertThreadFromLiveblocks(organizationId, thread);
      for (const comment of thread.comments) {
        await commentsService.upsertCommentFromLiveblocks(
          organizationId,
          thread.id,
          comment
        );
      }
    });

    return true;
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

  ...documentThreadMutations,
};

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

/**
 * Decide whether an already-resolved thread's row should be rewritten to repair
 * stale attribution:
 * - `shouldRepairMetadata` — a GitHub caller supplies attribution and the row's
 *   existing attribution is repairable (missing/legacy).
 * - `shouldRepairResolvedById` — a caller supplies a resolver, the row's
 *   `resolvedById` is still null, and no authoritative attribution owns the row
 *   (so a webhook-first native resolve can backfill the resolver, but an
 *   ExternalUnconnected GitHub resolve — legitimately null-resolver — is not
 *   overwritten). FEA-3950.
 * Both are false when the thread is not yet resolved (that path is a normal
 * transition, handled by the caller).
 */
function computeResolveRepair(input: {
  isResolved: boolean;
  existingResolvedById: string | null;
  existingAttribution: GitHubReviewThreadResolutionAttribution | null;
  options?: Omit<GitHubReviewThreadResolutionInput, "resolvedAt">;
}): { shouldRepairMetadata: boolean; shouldRepairResolvedById: boolean } {
  if (!input.isResolved) {
    return { shouldRepairMetadata: false, shouldRepairResolvedById: false };
  }
  const attributionRepairable = isRepairableResolutionAttribution(
    input.existingAttribution
  );
  return {
    shouldRepairMetadata:
      input.options?.attribution !== undefined && attributionRepairable,
    shouldRepairResolvedById:
      input.existingResolvedById === null &&
      (input.options?.resolvedById ?? null) !== null &&
      attributionRepairable,
  };
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
