import { decodeBranchId } from "@repo/api/src/types/branch";
import {
  type BranchTraceCommentCollectionQuery,
  normalizeTraceCommentKind,
  ThreadSource,
  ThreadStatus,
  TRACE_COMMENT_LIST_DEFAULT_LIMIT,
  TRACE_COMMENT_LIST_MAX_LIMIT,
  TRACE_COMMENT_METADATA_KIND,
  TRACE_COMMENT_SCHEMA_VERSION,
  type TraceComment,
  type TraceCommentDraft,
  TraceCommentKind,
  type TraceCommentListResponse,
  type TraceCommentReply,
  type TraceCommentReplyDraft,
  TraceCommentSurface,
  type TraceCommentTarget,
  TraceCommentTargetType,
  type TraceCommentUpdate,
  type TraceTextAnchor,
  traceTextAnchorSchema,
} from "@repo/api/src/types/comment";
import {
  computeNewMentions,
  MentionEntityType,
} from "@repo/collaboration/server/inbox-notifications";
import {
  ArtifactType,
  type Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { extractBodyMentions, textBody } from "@/app/comments/mention-body";
import { computeTargetsService } from "@/app/compute-targets/service";
import { traceTextAnchorToJsonObject } from "@/app/trace-comments/trace-comment-anchor-json";
import { parseTraceCommentMetadata } from "@/app/trace-comments/trace-comment-metadata";
import {
  indexTraceCommentAfterCommit,
  removeTraceCommentAfterCommit,
} from "@/app/trace-comments/trace-comment-search-index";
import { runIdempotentTraceWrite } from "@/app/trace-comments/trace-comment-write-idempotency";
import { dispatchMentionNotifications } from "@/lib/mention-notifications";
import { formatUserFullName } from "@/lib/user-display-name";

type TraceCommentTargetRecord = {
  artifactId: string;
  target: TraceCommentTarget;
  surface: TraceCommentSurface;
};

type TraceCommentTargetInput = {
  organizationId: string;
  userId: string;
  clerkUserId?: string | null;
  target: TraceCommentTarget;
  surface?: BranchTraceCommentCollectionQuery["surface"];
  computeTargetId?: string | null;
};

type TraceCommentRow = {
  id: string;
  artifactId: string | null;
  status: ThreadStatus;
  resolvedAt: Date | null;
  resolvedById: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  comments: {
    id: string;
    authorId: string;
    plainText: string | null;
    body: unknown;
    editedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }[];
};

type TraceCommentAuthor = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  avatarUrl: string | null;
};

type TraceCommentMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_found" | "forbidden" };

const notFound = { ok: false, reason: "not_found" } as const;
export const TRACE_COMMENT_TARGET_THREAD_LIMIT = 200;

const traceCommentThreadSelect = {
  id: true,
  artifactId: true,
  status: true,
  resolvedAt: true,
  resolvedById: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
  comments: {
    where: { deletedAt: null },
    select: {
      id: true,
      authorId: true,
      plainText: true,
      // Body carries the org-scoped @-mention user IDs (FEA-3490) alongside the
      // ProseMirror text; read it so mappers can surface `mentions`.
      body: true,
      editedAt: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.CommentThreadSelect;

export const traceCommentsService = {
  async list(input: TraceCommentTargetInput): Promise<TraceComment[] | null> {
    const resolved = await resolveTraceCommentTarget(input);
    if (!resolved) {
      return null;
    }

    return withDb(async (db) => {
      const rows = await db.commentThread.findMany({
        where: {
          organizationId: input.organizationId,
          artifactId: resolved.artifactId,
          source: ThreadSource.Native,
          metadata: { path: ["surface"], equals: resolved.surface },
        },
        select: {
          ...traceCommentThreadSelect,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: TRACE_COMMENT_TARGET_THREAD_LIMIT,
      });
      const traceRows = rows.filter(
        (row) =>
          parseTraceCommentMetadata(row.metadata)?.surface === resolved.surface
      );
      const authorById = await getTraceCommentAuthors(
        db,
        input.organizationId,
        traceRows
      );
      return traceRows.flatMap((row) =>
        mapTraceCommentRow(row, authorById, resolved, input.userId)
      );
    });
  },

  /**
   * Org-scoped aggregate list of trace comments across every session/branch
   * (FEA-3550), so a caller (e.g. the babysit open-comment sweep, a future
   * comment inbox) can page "all open comments" with a single request instead of
   * fanning out one call per session. Org-scoping is enforced at the DB layer via
   * `organizationId`, matching the per-session read, so a caller never sees a
   * thread outside their org. Each row is a full `TraceComment` carrying its
   * parent `target`/`artifactId` for deep-linking.
   */
  async listAll(input: {
    organizationId: string;
    userId: string;
    filters: {
      resolved?: boolean;
      targetType?: TraceCommentTargetType;
      authorId?: string;
      sessionId?: string;
      limit?: number;
      offset?: number;
      cursor?: number;
    };
  }): Promise<TraceCommentListResponse> {
    const limit = Math.min(
      input.filters.limit ?? TRACE_COMMENT_LIST_DEFAULT_LIMIT,
      TRACE_COMMENT_LIST_MAX_LIMIT
    );
    // A `cursor` (opaque next-offset token from a prior page) wins over a raw
    // `offset` when both are supplied.
    const offset = input.filters.cursor ?? input.filters.offset ?? 0;
    const where = buildAggregateTraceCommentWhere(
      input.organizationId,
      input.filters
    );

    const [rows, total] = await withDb((db) =>
      Promise.all([
        db.commentThread.findMany({
          where,
          select: traceCommentThreadSelect,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: offset,
          take: limit,
        }),
        db.commentThread.count({ where }),
      ])
    );

    const items = await mapAggregateTraceCommentRows(
      input.organizationId,
      input.userId,
      rows
    );
    // Advance the offset by the DB rows actually consumed (not `limit`, and not
    // the mapped-item count) so a short final page reports `null` and a
    // defensively dropped row never desyncs paging. This is a plain offset, not
    // a keyset cursor — see `TraceCommentListResponse` for the ordering caveat.
    const nextCursor =
      offset + rows.length < total ? String(offset + rows.length) : null;
    return { items, total, nextCursor };
  },

  async create(
    input: TraceCommentTargetInput & { draft: TraceCommentDraft }
  ): Promise<TraceComment | null> {
    const resolved = await resolveTraceCommentTarget(input);
    if (!resolved) {
      return null;
    }

    const clientId = input.draft.clientId ?? null;
    const runCreate = () =>
      withDb.tx(async (tx) => {
        const mapThread = async (row: TraceCommentRow) => {
          const authorById = await getTraceCommentAuthors(
            tx,
            input.organizationId,
            [row]
          );
          const [mapped] = mapTraceCommentRow(
            row,
            authorById,
            resolved,
            input.userId
          );
          return mapped ?? null;
        };

        if (clientId) {
          const existing = await tx.commentThread.findUnique({
            where: {
              organizationId_externalId: {
                organizationId: input.organizationId,
                externalId: clientId,
              },
            },
            select: traceCommentThreadSelect,
          });
          if (existing) {
            return { comment: await mapThread(existing), isNew: false };
          }
        }

        const metadata = buildTraceCommentMetadata(
          resolved,
          input.draft.anchor,
          input.draft.kind
        );
        const mentions = await scopeMentionsToOrg(
          tx,
          input.organizationId,
          input.draft.mentions
        );
        const thread = await tx.commentThread.create({
          data: {
            organizationId: input.organizationId,
            artifactId: resolved.artifactId,
            source: ThreadSource.Native,
            status: ThreadStatus.Open,
            metadata,
            createdById: input.userId,
            ...(clientId ? { externalId: clientId } : {}),
            comments: {
              create: {
                authorId: input.userId,
                body: textBody(input.draft.body, mentions),
                plainText: input.draft.body,
              },
            },
          },
          select: traceCommentThreadSelect,
        });
        return { comment: await mapThread(thread), isNew: true };
      });

    const outcome = await runIdempotentTraceWrite(clientId, runCreate);

    if (outcome.comment && outcome.isNew) {
      indexTraceCommentAfterCommit({
        organizationId: input.organizationId,
        commentId: outcome.comment.id,
        body: input.draft.body,
        authorId: input.userId,
        anchorArtifactId: resolved.artifactId,
        targetType: resolved.target.type,
        updatedAt: new Date(),
      });
      await notifyTraceMentions({
        resolved,
        organizationId: input.organizationId,
        actorUserId: input.userId,
        nextMentions: outcome.comment.mentions ?? [],
        previousMentions: [],
        commentId: outcome.comment.id,
        commentBody: input.draft.body,
      });
    }
    return outcome.comment;
  },

  async reply(
    input: TraceCommentTargetInput & {
      commentId: string;
      draft: TraceCommentReplyDraft;
    }
  ): Promise<TraceCommentMutationResult<TraceComment>> {
    const resolved = await resolveTraceCommentTarget(input);
    if (!resolved) {
      return { ok: false, reason: "not_found" };
    }

    const clientId = input.draft.clientId ?? null;
    const runReply = () =>
      withDb.tx(async (tx) => {
        const thread = await findTraceCommentThreadForComment(tx, {
          organizationId: input.organizationId,
          resolved,
          commentId: input.commentId,
        });
        if (!thread) {
          return { result: notFound, notify: null };
        }
        if (thread.comments[0]?.id !== input.commentId) {
          return { result: notFound, notify: null };
        }

        const existingReply = clientId
          ? await tx.comment.findUnique({
              where: { externalId: clientId },
              select: { id: true, threadId: true },
            })
          : null;
        const isReplay = existingReply?.threadId === thread.id;

        const notify = await createTraceReplyIfNew(tx, {
          organizationId: input.organizationId,
          userId: input.userId,
          threadId: thread.id,
          clientId,
          isReplay,
          draft: input.draft,
        });

        const updatedThread = await findTraceCommentThreadById(tx, {
          organizationId: input.organizationId,
          resolved,
          threadId: thread.id,
        });
        if (!updatedThread) {
          return { result: notFound, notify: null };
        }
        const authorById = await getTraceCommentAuthors(
          tx,
          input.organizationId,
          [updatedThread]
        );
        const [comment] = mapTraceCommentRow(
          updatedThread,
          authorById,
          resolved,
          input.userId
        );
        if (!comment) {
          return { result: notFound, notify: null };
        }
        return {
          result: { ok: true, value: comment } as const,
          notify,
        };
      });

    const outcome = await runIdempotentTraceWrite(clientId, runReply);

    if (outcome.notify) {
      indexTraceCommentAfterCommit({
        organizationId: input.organizationId,
        commentId: outcome.notify.commentId,
        body: input.draft.body,
        authorId: input.userId,
        anchorArtifactId: resolved.artifactId,
        targetType: resolved.target.type,
        updatedAt: new Date(),
      });
      await notifyTraceMentions({
        resolved,
        organizationId: input.organizationId,
        actorUserId: input.userId,
        nextMentions: outcome.notify.mentions,
        previousMentions: [],
        commentId: outcome.notify.commentId,
        commentBody: input.draft.body,
      });
    }
    return outcome.result;
  },

  async update(
    input: TraceCommentTargetInput & {
      commentId: string;
      update: TraceCommentUpdate;
    }
  ): Promise<TraceCommentMutationResult<TraceComment>> {
    const resolved = await resolveTraceCommentTarget(input);
    if (!resolved) {
      return { ok: false, reason: "not_found" };
    }

    const outcome = await withDb.tx(async (tx) => {
      const editable = await findEditableTraceCommentThread(tx, {
        organizationId: input.organizationId,
        userId: input.userId,
        resolved,
        commentId: input.commentId,
      });
      if (!editable.ok) {
        return { result: editable, notify: null };
      }
      const { threadId } = editable.value;

      const previousMentions = await readPersistedCommentMentions(
        tx,
        input.commentId
      );
      const mentions =
        input.update.mentions === undefined
          ? previousMentions
          : await scopeMentionsToOrg(
              tx,
              input.organizationId,
              input.update.mentions
            );
      const editedAt = new Date();
      await tx.comment.update({
        where: { id: input.commentId },
        data: {
          body: textBody(input.update.body, mentions),
          plainText: input.update.body,
          editedAt,
        },
        select: { id: true },
      });
      const thread = await findTraceCommentThreadById(tx, {
        organizationId: input.organizationId,
        resolved,
        threadId,
      });
      if (!thread) {
        return { result: notFound, notify: null };
      }
      const authorById = await getTraceCommentAuthors(
        tx,
        input.organizationId,
        [thread]
      );
      const [comment] = mapTraceCommentRow(
        thread,
        authorById,
        resolved,
        input.userId
      );
      if (!comment) {
        return { result: notFound, notify: null };
      }
      return {
        result: { ok: true, value: comment } as const,
        notify: {
          commentId: input.commentId,
          nextMentions: mentions,
          previousMentions,
        },
      };
    });

    if (outcome.notify) {
      indexTraceCommentAfterCommit({
        organizationId: input.organizationId,
        commentId: outcome.notify.commentId,
        body: input.update.body,
        authorId: input.userId,
        anchorArtifactId: resolved.artifactId,
        targetType: resolved.target.type,
        updatedAt: new Date(),
      });
      await notifyTraceMentions({
        resolved,
        organizationId: input.organizationId,
        actorUserId: input.userId,
        nextMentions: outcome.notify.nextMentions,
        previousMentions: outcome.notify.previousMentions,
        commentId: outcome.notify.commentId,
        commentBody: input.update.body,
      });
    }
    return outcome.result;
  },

  async delete(
    input: TraceCommentTargetInput & { commentId: string }
  ): Promise<TraceCommentMutationResult<{ deleted: true }>> {
    const resolved = await resolveTraceCommentTarget(input);
    if (!resolved) {
      return { ok: false, reason: "not_found" };
    }

    const outcome = await withDb.tx(async (tx) => {
      const editable = await findEditableTraceCommentThread(tx, {
        organizationId: input.organizationId,
        userId: input.userId,
        resolved,
        commentId: input.commentId,
      });
      if (!editable.ok) {
        return { result: editable, removedCommentIds: [] as string[] };
      }

      const deletedAt = new Date();
      if (editable.value.isRoot) {
        // A root delete soft-deletes the whole thread; capture the ids first so
        // every deleted comment's projection row is removed (not just the root).
        const affected = await tx.comment.findMany({
          where: { threadId: editable.value.threadId, deletedAt: null },
          select: { id: true },
        });
        await tx.comment.updateMany({
          where: { threadId: editable.value.threadId, deletedAt: null },
          data: { deletedAt },
        });
        return {
          result: { ok: true, value: { deleted: true } } as const,
          removedCommentIds: affected.map((c) => c.id),
        };
      }
      await tx.comment.update({
        where: { id: input.commentId },
        data: { deletedAt },
        select: { id: true },
      });
      return {
        result: { ok: true, value: { deleted: true } } as const,
        removedCommentIds: [input.commentId],
      };
    });

    for (const commentId of outcome.removedCommentIds) {
      removeTraceCommentAfterCommit({
        organizationId: input.organizationId,
        commentId,
      });
    }
    return outcome.result;
  },
};

function resolveTraceCommentTarget(
  input: TraceCommentTargetInput
): Promise<TraceCommentTargetRecord | null> {
  if (input.target.type === TraceCommentTargetType.Session) {
    return resolveSessionTraceCommentTarget(input);
  }
  return resolveBranchTraceCommentTarget(input);
}

async function resolveSessionTraceCommentTarget(input: {
  organizationId: string;
  userId: string;
  clerkUserId?: string | null;
  target: TraceCommentTarget;
  computeTargetId?: string | null;
}): Promise<TraceCommentTargetRecord | null> {
  const byArtifactId = await withDb((db) =>
    db.sessionDetail.findFirst({
      where: {
        artifactId: input.target.id,
        artifact: {
          is: {
            organizationId: input.organizationId,
            type: ArtifactType.SESSION,
          },
        },
      },
      select: { artifactId: true },
    })
  );
  if (byArtifactId) {
    return {
      artifactId: byArtifactId.artifactId,
      target: input.target,
      surface: TraceCommentSurface.SessionDetail,
    };
  }

  const computeTargetId = input.computeTargetId ?? null;
  if (computeTargetId) {
    const ownedTarget = await computeTargetsService.findOwnedById(
      computeTargetId,
      input.organizationId,
      input.userId,
      input.clerkUserId ?? null
    );
    if (!ownedTarget) {
      return null;
    }

    const byComputeTargetExternalId = await withDb((db) =>
      db.sessionDetail.findFirst({
        where: {
          computeTargetId,
          externalSessionId: input.target.id,
          artifact: {
            is: {
              organizationId: input.organizationId,
              type: ArtifactType.SESSION,
            },
          },
        },
        select: { artifactId: true },
      })
    );
    if (byComputeTargetExternalId) {
      return {
        artifactId: byComputeTargetExternalId.artifactId,
        target: input.target,
        surface: TraceCommentSurface.SessionDetail,
      };
    }
  }

  const scoped = await withDb((db) =>
    db.sessionDetail.findFirst({
      where: {
        externalSessionId: input.target.id,
        userId: input.userId,
        artifact: {
          is: {
            organizationId: input.organizationId,
            type: ArtifactType.SESSION,
          },
        },
      },
      orderBy: [{ lastSyncedAt: "desc" }, { artifactId: "desc" }],
      select: { artifactId: true },
    })
  );
  if (scoped) {
    return {
      artifactId: scoped.artifactId,
      target: input.target,
      surface: TraceCommentSurface.SessionDetail,
    };
  }

  return null;
}

async function resolveBranchTraceCommentTarget(input: {
  organizationId: string;
  target: TraceCommentTarget;
  surface?: BranchTraceCommentCollectionQuery["surface"];
}): Promise<TraceCommentTargetRecord | null> {
  const surface = input.surface ?? TraceCommentSurface.BranchDetail;
  const byArtifactId = await withDb((db) =>
    db.branchDetail.findFirst({
      where: {
        artifactId: input.target.id,
        deletedAt: null,
        artifact: {
          is: {
            organizationId: input.organizationId,
            type: ArtifactType.BRANCH,
          },
        },
      },
      select: { artifactId: true },
    })
  );
  if (byArtifactId) {
    return {
      artifactId: byArtifactId.artifactId,
      target: input.target,
      surface,
    };
  }

  const decoded = decodeBranchId(input.target.id);
  const branch = await withDb((db) =>
    db.branchDetail.findFirst({
      where: {
        branchName: decoded.branchName,
        deletedAt: null,
        ...(decoded.repoFullName
          ? { repository: { is: { fullName: decoded.repoFullName } } }
          : {}),
        artifact: {
          is: {
            organizationId: input.organizationId,
            type: ArtifactType.BRANCH,
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { artifactId: "desc" }],
      select: { artifactId: true },
    })
  );
  return branch
    ? {
        artifactId: branch.artifactId,
        target: input.target,
        surface,
      }
    : null;
}

async function findEditableTraceCommentThread(
  tx: TransactionClient,
  input: {
    organizationId: string;
    userId: string;
    resolved: TraceCommentTargetRecord;
    commentId: string;
  }
): Promise<TraceCommentMutationResult<{ threadId: string; isRoot: boolean }>> {
  const thread = await tx.commentThread.findFirst({
    where: {
      organizationId: input.organizationId,
      artifactId: input.resolved.artifactId,
      source: ThreadSource.Native,
      comments: {
        some: {
          id: input.commentId,
          deletedAt: null,
        },
      },
    },
    select: {
      id: true,
      artifactId: true,
      status: true,
      metadata: true,
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
  if (!(thread && isThreadOnResolvedSurface(thread.metadata, input.resolved))) {
    return { ok: false, reason: "not_found" };
  }

  const comment = thread.comments.find(
    (candidate) => candidate.id === input.commentId
  );
  if (!comment) {
    return { ok: false, reason: "not_found" };
  }
  if (comment.authorId !== input.userId) {
    return { ok: false, reason: "forbidden" };
  }
  return {
    ok: true,
    value: {
      threadId: thread.id,
      isRoot: thread.comments[0]?.id === comment.id,
    },
  };
}

async function findTraceCommentThreadForComment(
  tx: TransactionClient,
  input: {
    organizationId: string;
    resolved: TraceCommentTargetRecord;
    commentId: string;
  }
): Promise<TraceCommentRow | null> {
  const thread = await tx.commentThread.findFirst({
    where: {
      organizationId: input.organizationId,
      artifactId: input.resolved.artifactId,
      source: ThreadSource.Native,
      comments: {
        some: {
          id: input.commentId,
          deletedAt: null,
        },
      },
    },
    select: traceCommentThreadSelect,
  });
  return thread && isThreadOnResolvedSurface(thread.metadata, input.resolved)
    ? thread
    : null;
}

async function findTraceCommentThreadById(
  tx: TransactionClient,
  input: {
    organizationId: string;
    resolved: TraceCommentTargetRecord;
    threadId: string;
  }
): Promise<TraceCommentRow | null> {
  const thread = await tx.commentThread.findFirst({
    where: {
      id: input.threadId,
      organizationId: input.organizationId,
      artifactId: input.resolved.artifactId,
      source: ThreadSource.Native,
    },
    select: traceCommentThreadSelect,
  });
  return thread && isThreadOnResolvedSurface(thread.metadata, input.resolved)
    ? thread
    : null;
}

function isThreadOnResolvedSurface(
  metadata: unknown,
  resolved: TraceCommentTargetRecord
): boolean {
  return parseTraceCommentMetadata(metadata)?.surface === resolved.surface;
}

/**
 * Inserts the reply comment for a trace reply, unless this is an idempotent
 * replay (FEA-3598) — a retried reply whose `clientId` already landed on the
 * same thread. Returns the notify payload for a fresh insert, or null on a
 * replay (so recipients are not re-pinged). Carries the client idempotency id on
 * the reply's `externalId` unique key so a concurrent retry conflicts on P2002
 * rather than duplicating the reply.
 */
async function createTraceReplyIfNew(
  tx: TransactionClient,
  input: {
    organizationId: string;
    userId: string;
    threadId: string;
    clientId: string | null;
    isReplay: boolean;
    draft: TraceCommentReplyDraft;
  }
): Promise<{ commentId: string; mentions: string[] } | null> {
  if (input.isReplay) {
    return null;
  }
  const mentions = await scopeMentionsToOrg(
    tx,
    input.organizationId,
    input.draft.mentions
  );
  const createdReply = await tx.comment.create({
    data: {
      threadId: input.threadId,
      authorId: input.userId,
      body: textBody(input.draft.body, mentions),
      plainText: input.draft.body,
      ...(input.clientId ? { externalId: input.clientId } : {}),
    },
    select: { id: true },
  });
  return { commentId: createdReply.id, mentions };
}

async function getTraceCommentAuthors(
  client: Pick<TransactionClient, "user">,
  organizationId: string,
  rows: TraceCommentRow[]
): Promise<Map<string, TraceCommentAuthor>> {
  const authorIds = [
    ...new Set(
      rows.flatMap((row) => row.comments.map((comment) => comment.authorId))
    ),
  ];
  for (const row of rows) {
    if (row.resolvedById) {
      authorIds.push(row.resolvedById);
    }
  }
  if (authorIds.length === 0) {
    return new Map();
  }
  const authors = await client.user.findMany({
    where: {
      organizationId,
      id: { in: authorIds },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      avatarUrl: true,
    },
  });
  return new Map(authors.map((author) => [author.id, author]));
}

function buildTraceCommentMetadata(
  target: TraceCommentTargetRecord,
  anchor: TraceTextAnchor,
  commentKind?: TraceCommentKind
): Prisma.InputJsonObject {
  const parsedAnchor = traceTextAnchorSchema.parse(anchor);
  return {
    kind: TRACE_COMMENT_METADATA_KIND,
    schemaVersion: TRACE_COMMENT_SCHEMA_VERSION,
    targetType: target.target.type,
    surface: target.surface,
    anchor: traceTextAnchorToJsonObject(parsedAnchor),
    // FEA-4171: persist the classification only when explicitly set. Omit the
    // key for a plain comment so the stored shape stays unchanged for the common
    // case and the mapper's default (`Comment`) covers both omission and older
    // rows. The metadata's own `kind` field is the trace-comment discriminator
    // (`TRACE_COMMENT_METADATA_KIND`); the classification is a distinct
    // `commentKind` field to avoid colliding with it.
    ...(commentKind && commentKind !== TraceCommentKind.Comment
      ? { commentKind }
      : {}),
  };
}

function mapTraceCommentRow(
  row: TraceCommentRow,
  authorById: ReadonlyMap<string, TraceCommentAuthor>,
  resolved: TraceCommentTargetRecord,
  viewerUserId: string
): TraceComment[] {
  if (!row.artifactId) {
    return [];
  }
  const metadata = parseTraceCommentMetadata(row.metadata);
  const rootComment = row.comments[0];
  if (!(metadata && rootComment)) {
    return [];
  }
  const author = authorById.get(rootComment.authorId) ?? null;
  const resolvedBy = row.resolvedById
    ? (authorById.get(row.resolvedById) ?? null)
    : null;
  const canMutate = rootComment.authorId === viewerUserId;
  const replies = row.comments
    .slice(1)
    .map((reply) =>
      mapTraceCommentReply(reply, authorById, row.id, viewerUserId)
    );
  return [
    {
      id: rootComment.id,
      threadId: row.id,
      target: resolved.target,
      artifactId: row.artifactId,
      surface: metadata.surface,
      // Resolve the classification tolerantly (FEA-4171): absent, older-row, or
      // an unknown/future value all degrade to `Comment` via the SSOT helper.
      kind: normalizeTraceCommentKind(metadata.commentKind),
      anchor: metadata.anchor,
      body: rootComment.plainText ?? "",
      mentions: extractBodyMentions(rootComment.body),
      status: row.status,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolvedById: row.resolvedById ?? null,
      resolvedByName: resolvedBy ? formatAuthorName(resolvedBy) : null,
      resolvedByAvatarUrl: resolvedBy?.avatarUrl ?? null,
      createdAt: rootComment.createdAt.toISOString(),
      updatedAt: rootComment.updatedAt.toISOString(),
      editedAt: rootComment.editedAt?.toISOString() ?? null,
      authorId: rootComment.authorId,
      authorName: author ? formatAuthorName(author) : null,
      authorAvatarUrl: author?.avatarUrl ?? null,
      canEdit: canMutate,
      canDelete: canMutate,
      replies,
    },
  ];
}

/**
 * Builds the org-scoped `where` for the aggregate trace-comment list (FEA-3550).
 * Restricts to native threads whose metadata is a trace comment and that still
 * have a live (non-deleted) comment, so `total`/pagination never counts a
 * fully-deleted or non-trace thread. Optional filters narrow by status, target
 * type, opening author, and single target artifact.
 */
function buildAggregateTraceCommentWhere(
  organizationId: string,
  filters: {
    resolved?: boolean;
    targetType?: TraceCommentTargetType;
    authorId?: string;
    sessionId?: string;
  }
): Prisma.CommentThreadWhereInput {
  // Prisma disallows repeating the `metadata` key in one object literal, so the
  // kind + (optional) targetType JSON-path filters live in an AND array.
  const metadataFilters: Prisma.CommentThreadWhereInput[] = [
    { metadata: { path: ["kind"], equals: TRACE_COMMENT_METADATA_KIND } },
  ];
  if (filters.targetType) {
    metadataFilters.push({
      metadata: { path: ["targetType"], equals: filters.targetType },
    });
  }
  return {
    organizationId,
    source: ThreadSource.Native,
    // Only threads with a live root comment; a fully-deleted thread maps to no
    // row, so excluding it keeps `total` aligned with the returned items.
    comments: { some: { deletedAt: null } },
    ...(filters.resolved === undefined
      ? {}
      : {
          status: filters.resolved ? ThreadStatus.Resolved : ThreadStatus.Open,
        }),
    ...(filters.authorId ? { createdById: filters.authorId } : {}),
    // `sessionId` is the target's artifact id — the `artifactId`/`target.id`
    // echoed on each row — so callers can page the aggregate then narrow to one
    // session. When absent, still require a non-null artifact so every row maps
    // to a resolvable target.
    artifactId: filters.sessionId ? filters.sessionId : { not: null },
    AND: metadataFilters,
  };
}

/**
 * Maps aggregate `CommentThread` rows into `TraceComment`s (FEA-3550). Unlike the
 * per-session read, each row carries a different parent artifact, so the target
 * record is reconstructed per row from the thread's metadata (target type +
 * surface) and artifact id. Authors are fetched org-scoped in one batched query.
 */
async function mapAggregateTraceCommentRows(
  organizationId: string,
  viewerUserId: string,
  rows: TraceCommentRow[]
): Promise<TraceComment[]> {
  const traceRows = rows.filter((row) =>
    parseTraceCommentMetadata(row.metadata)
  );
  const authorById = await withDb((db) =>
    getTraceCommentAuthors(db, organizationId, traceRows)
  );
  return traceRows.flatMap((row) => {
    const metadata = parseTraceCommentMetadata(row.metadata);
    if (!(metadata && row.artifactId)) {
      return [];
    }
    const resolved: TraceCommentTargetRecord = {
      artifactId: row.artifactId,
      target: { type: metadata.targetType, id: row.artifactId },
      surface: metadata.surface,
    };
    return mapTraceCommentRow(row, authorById, resolved, viewerUserId);
  });
}

function mapTraceCommentReply(
  reply: TraceCommentRow["comments"][number],
  authorById: ReadonlyMap<string, TraceCommentAuthor>,
  threadId: string,
  viewerUserId: string
): TraceCommentReply {
  const author = authorById.get(reply.authorId) ?? null;
  const canMutate = reply.authorId === viewerUserId;
  return {
    id: reply.id,
    threadId,
    body: reply.plainText ?? "",
    mentions: extractBodyMentions(reply.body),
    createdAt: reply.createdAt.toISOString(),
    updatedAt: reply.updatedAt.toISOString(),
    editedAt: reply.editedAt?.toISOString() ?? null,
    authorId: reply.authorId,
    authorName: author ? formatAuthorName(author) : null,
    authorAvatarUrl: author?.avatarUrl ?? null,
    canEdit: canMutate,
    canDelete: canMutate,
  };
}

/**
 * Filters a caller-supplied @-mention user-ID list down to the subset that are
 * active members of the caller's organization (FEA-3490). This is the
 * authoritative org-scoping guard: an id for a user in another org, a
 * soft-deleted/deactivated user, or a bogus id is dropped so a mention can never
 * reference or leak a user outside the caller's org. Returns a de-duplicated,
 * input-order-stable list.
 */
/**
 * Reads the @-mention user-ID list already persisted on a comment's body doc
 * (FEA-3490). Used when an edit omits `mentions` entirely so a body-only edit
 * retains the comment's existing mentions instead of clearing them. The stored
 * ids were org-scoped when first written, so they are safe to re-persist as-is.
 */
async function readPersistedCommentMentions(
  tx: TransactionClient,
  commentId: string
): Promise<string[]> {
  const existing = await tx.comment.findUnique({
    where: { id: commentId },
    select: { body: true },
  });
  return existing ? extractBodyMentions(existing.body) : [];
}

/**
 * Fire the @-mention inbox notifications for a just-written trace comment
 * (FEA-3490). Computes the newly-mentioned recipients (present now, absent
 * before, never the actor), resolves the session/branch title for the copy, and
 * hands off to the fire-and-forget dispatcher. Called AFTER the write
 * transaction commits so a notification hiccup can never roll back the comment,
 * and no-ops when nothing new was mentioned.
 */
async function notifyTraceMentions(params: {
  resolved: TraceCommentTargetRecord;
  organizationId: string;
  actorUserId: string;
  nextMentions: readonly string[];
  previousMentions: readonly string[];
  commentId: string;
  commentBody: string;
}): Promise<void> {
  const recipients = computeNewMentions(
    params.nextMentions,
    params.previousMentions,
    params.actorUserId
  );
  if (recipients.length === 0) {
    return;
  }
  const entityType =
    params.resolved.surface === TraceCommentSurface.SessionDetail
      ? MentionEntityType.Session
      : MentionEntityType.Branch;
  const entityTitle = await getArtifactTitle(
    params.organizationId,
    params.resolved.artifactId,
    entityType
  );
  dispatchMentionNotifications({
    recipientUserIds: recipients,
    actorUserId: params.actorUserId,
    organizationId: params.organizationId,
    entityType,
    entityTitle,
    artifactId: params.resolved.artifactId,
    commentId: params.commentId,
    commentBody: params.commentBody,
  });
}

async function getArtifactTitle(
  organizationId: string,
  artifactId: string,
  entityType: MentionEntityType
): Promise<string> {
  const fallback =
    entityType === MentionEntityType.Session ? "a session" : "a branch";
  try {
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: { id: artifactId, organizationId },
        select: { name: true },
      })
    );
    return artifact?.name?.trim() || fallback;
  } catch (error) {
    // The comment is already committed; a title lookup failure must never
    // surface as a request error. Fall back to a generic label so the mention
    // notification still fires with a sensible (if unnamed) deep link.
    log.warn("trace_comment_mention_title_lookup_failed", {
      organizationId,
      artifactId,
      error: parseError(error),
    });
    return fallback;
  }
}

async function scopeMentionsToOrg(
  tx: TransactionClient,
  organizationId: string,
  mentions: readonly string[] | undefined
): Promise<string[]> {
  if (!mentions || mentions.length === 0) {
    return [];
  }
  const requested = [...new Set(mentions)];
  const members = await tx.user.findMany({
    where: {
      organizationId,
      active: true,
      id: { in: requested },
    },
    select: { id: true },
  });
  const allowed = new Set(members.map((member) => member.id));
  return requested.filter((id) => allowed.has(id));
}

function formatAuthorName(author: TraceCommentAuthor): string {
  // Divergent fallbacks (nullable email, then "Unknown user") kept at the call
  // site per FEA-3506; the name derivation routes through the shared SSOT.
  return formatUserFullName(author) || author.email || "Unknown user";
}
