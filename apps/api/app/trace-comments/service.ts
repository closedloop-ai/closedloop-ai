import { decodeBranchId } from "@repo/api/src/types/branch";
import {
  ThreadSource,
  ThreadStatus,
  TRACE_COMMENT_METADATA_KIND,
  TRACE_COMMENT_SCHEMA_VERSION,
  type TraceComment,
  type TraceCommentDraft,
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
  ArtifactType,
  Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { z } from "zod";
import { textBody } from "@/app/comments/service";
import { computeTargetsService } from "@/app/compute-targets/service";

const traceCommentMetadataSchema = z.object({
  kind: z.literal(TRACE_COMMENT_METADATA_KIND),
  schemaVersion: z.literal(TRACE_COMMENT_SCHEMA_VERSION),
  targetType: z.union([
    z.literal(TraceCommentTargetType.Session),
    z.literal(TraceCommentTargetType.Branch),
  ]),
  surface: z.union([
    z.literal(TraceCommentSurface.SessionDetail),
    z.literal(TraceCommentSurface.BranchDetail),
  ]),
  anchor: traceTextAnchorSchema,
});

type TraceCommentMetadata = z.infer<typeof traceCommentMetadataSchema>;

type TraceCommentTargetRecord = {
  artifactId: string;
  target: TraceCommentTarget;
  surface: TraceCommentSurface;
};

type TraceCommentRow = {
  id: string;
  artifactId: string | null;
  status: ThreadStatus;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  comments: {
    id: string;
    authorId: string;
    plainText: string | null;
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

const traceCommentThreadSelect = {
  id: true,
  artifactId: true,
  status: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
  comments: {
    where: { deletedAt: null },
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
} satisfies Prisma.CommentThreadSelect;

export const traceCommentsService = {
  async list(input: {
    organizationId: string;
    userId: string;
    clerkUserId?: string | null;
    target: TraceCommentTarget;
    computeTargetId?: string | null;
  }): Promise<TraceComment[] | null> {
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
        },
        select: {
          ...traceCommentThreadSelect,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      const traceRows = rows.filter((row) =>
        parseTraceCommentMetadata(row.metadata)
      );
      const authorIds = [
        ...new Set(
          traceRows.flatMap((row) =>
            row.comments.map((comment) => comment.authorId)
          )
        ),
      ];
      const authors =
        authorIds.length === 0
          ? []
          : await db.user.findMany({
              where: {
                organizationId: input.organizationId,
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
      const authorById = new Map(authors.map((author) => [author.id, author]));
      return traceRows.flatMap((row) =>
        mapTraceCommentRow(row, authorById, resolved, input.userId)
      );
    });
  },

  async create(input: {
    organizationId: string;
    userId: string;
    clerkUserId?: string | null;
    target: TraceCommentTarget;
    computeTargetId?: string | null;
    draft: TraceCommentDraft;
  }): Promise<TraceComment | null> {
    const resolved = await resolveTraceCommentTarget(input);
    if (!resolved) {
      return null;
    }

    return withDb.tx(async (tx) => {
      const metadata = buildTraceCommentMetadata(resolved, input.draft.anchor);
      const thread = await tx.commentThread.create({
        data: {
          organizationId: input.organizationId,
          artifactId: resolved.artifactId,
          source: ThreadSource.Native,
          status: ThreadStatus.Open,
          metadata,
          createdById: input.userId,
          comments: {
            create: {
              authorId: input.userId,
              body: textBody(input.draft.body),
              plainText: input.draft.body,
            },
          },
        },
        select: traceCommentThreadSelect,
      });
      const authorById = await getTraceCommentAuthors(
        tx,
        input.organizationId,
        thread
      );
      const [comment] = mapTraceCommentRow(
        thread,
        authorById,
        resolved,
        input.userId
      );
      return comment ?? null;
    });
  },

  async reply(input: {
    organizationId: string;
    userId: string;
    clerkUserId?: string | null;
    target: TraceCommentTarget;
    computeTargetId?: string | null;
    commentId: string;
    draft: TraceCommentReplyDraft;
  }): Promise<TraceCommentMutationResult<TraceComment>> {
    const resolved = await resolveTraceCommentTarget(input);
    if (!resolved) {
      return { ok: false, reason: "not_found" };
    }

    return withDb.tx(async (tx) => {
      const thread = await findTraceCommentThreadForComment(tx, {
        organizationId: input.organizationId,
        resolved,
        commentId: input.commentId,
      });
      if (!thread) {
        return { ok: false, reason: "not_found" };
      }
      if (thread.comments[0]?.id !== input.commentId) {
        return { ok: false, reason: "not_found" };
      }

      await tx.comment.create({
        data: {
          threadId: thread.id,
          authorId: input.userId,
          body: textBody(input.draft.body),
          plainText: input.draft.body,
        },
        select: { id: true },
      });

      const updatedThread = await findTraceCommentThreadById(tx, {
        organizationId: input.organizationId,
        resolved,
        threadId: thread.id,
      });
      if (!updatedThread) {
        return { ok: false, reason: "not_found" };
      }
      const authorById = await getTraceCommentAuthors(
        tx,
        input.organizationId,
        updatedThread
      );
      const [comment] = mapTraceCommentRow(
        updatedThread,
        authorById,
        resolved,
        input.userId
      );
      return comment
        ? { ok: true, value: comment }
        : { ok: false, reason: "not_found" };
    });
  },

  async update(input: {
    organizationId: string;
    userId: string;
    clerkUserId?: string | null;
    target: TraceCommentTarget;
    computeTargetId?: string | null;
    commentId: string;
    update: TraceCommentUpdate;
  }): Promise<TraceCommentMutationResult<TraceComment>> {
    const resolved = await resolveTraceCommentTarget(input);
    if (!resolved) {
      return { ok: false, reason: "not_found" };
    }

    return withDb.tx(async (tx) => {
      const editable = await findEditableTraceCommentThread(tx, {
        organizationId: input.organizationId,
        userId: input.userId,
        resolved,
        commentId: input.commentId,
      });
      if (!editable.ok) {
        return editable;
      }
      const { threadId } = editable.value;

      const editedAt = new Date();
      await tx.comment.update({
        where: { id: input.commentId },
        data: {
          body: textBody(input.update.body),
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
        return { ok: false, reason: "not_found" };
      }
      const authorById = await getTraceCommentAuthors(
        tx,
        input.organizationId,
        thread
      );
      const [comment] = mapTraceCommentRow(
        thread,
        authorById,
        resolved,
        input.userId
      );
      return comment
        ? { ok: true, value: comment }
        : { ok: false, reason: "not_found" };
    });
  },

  async delete(input: {
    organizationId: string;
    userId: string;
    clerkUserId?: string | null;
    target: TraceCommentTarget;
    computeTargetId?: string | null;
    commentId: string;
  }): Promise<TraceCommentMutationResult<{ deleted: true }>> {
    const resolved = await resolveTraceCommentTarget(input);
    if (!resolved) {
      return { ok: false, reason: "not_found" };
    }

    return withDb.tx(async (tx) => {
      const editable = await findEditableTraceCommentThread(tx, {
        organizationId: input.organizationId,
        userId: input.userId,
        resolved,
        commentId: input.commentId,
      });
      if (!editable.ok) {
        return editable;
      }

      const deletedAt = new Date();
      if (editable.value.isRoot) {
        await tx.comment.updateMany({
          where: {
            threadId: editable.value.threadId,
            deletedAt: null,
          },
          data: { deletedAt },
        });
      } else {
        await tx.comment.update({
          where: { id: input.commentId },
          data: { deletedAt },
          select: { id: true },
        });
      }
      return { ok: true, value: { deleted: true } };
    });
  },
};

function resolveTraceCommentTarget(input: {
  organizationId: string;
  userId: string;
  clerkUserId?: string | null;
  target: TraceCommentTarget;
  computeTargetId?: string | null;
}): Promise<TraceCommentTargetRecord | null> {
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
}): Promise<TraceCommentTargetRecord | null> {
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
      surface: TraceCommentSurface.BranchDetail,
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
        surface: TraceCommentSurface.BranchDetail,
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
  if (!(thread && parseTraceCommentMetadata(thread.metadata))) {
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
  return thread && parseTraceCommentMetadata(thread.metadata) ? thread : null;
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
  return thread && parseTraceCommentMetadata(thread.metadata) ? thread : null;
}

async function getTraceCommentAuthors(
  tx: TransactionClient,
  organizationId: string,
  row: TraceCommentRow
): Promise<Map<string, TraceCommentAuthor>> {
  const authorIds = [
    ...new Set(row.comments.map((comment) => comment.authorId)),
  ];
  if (authorIds.length === 0) {
    return new Map();
  }
  const authors = await tx.user.findMany({
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
  anchor: TraceTextAnchor
): Prisma.InputJsonObject {
  const parsedAnchor = traceTextAnchorSchema.parse(anchor);
  return {
    kind: TRACE_COMMENT_METADATA_KIND,
    schemaVersion: TRACE_COMMENT_SCHEMA_VERSION,
    targetType: target.target.type,
    surface: target.surface,
    anchor: traceTextAnchorToJsonObject(parsedAnchor),
  };
}

function traceTextAnchorToJsonObject(
  anchor: TraceTextAnchor
): Prisma.InputJsonObject {
  return {
    traceId: anchor.traceId,
    turnId: anchor.turnId,
    row: anchor.row,
    selectedText: anchor.selectedText,
    sourceText: anchor.sourceText,
    startOffset: anchor.startOffset,
    endOffset: anchor.endOffset,
    ...(anchor.sessionId === undefined ? {} : { sessionId: anchor.sessionId }),
    ...(anchor.actor === undefined
      ? {}
      : {
          actor:
            anchor.actor === null
              ? null
              : { name: anchor.actor.name, human: anchor.actor.human },
        }),
  } satisfies Prisma.InputJsonObject;
}

function parseTraceCommentMetadata(
  value: unknown
): TraceCommentMetadata | null {
  const normalized = value === Prisma.JsonNull ? null : value;
  const result = traceCommentMetadataSchema.safeParse(normalized);
  return result.success ? result.data : null;
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
      anchor: metadata.anchor,
      body: rootComment.plainText ?? "",
      status: row.status,
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

function formatAuthorName(author: TraceCommentAuthor): string {
  const displayName = [author.firstName, author.lastName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ")
    .trim();
  return displayName || author.email || "Unknown user";
}
