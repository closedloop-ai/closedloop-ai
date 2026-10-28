import {
  type CommentSurface,
  ThreadSource,
  type ThreadStatus,
} from "@repo/api/src/types/comment";
import type { Prisma, TransactionClient } from "@repo/database";
import type { TimeIdCursor } from "@/lib/time-id-cursor";
import {
  storedThreadSurfaceWhere,
  threadSourceWhere,
} from "./stored-thread-surface";
import {
  type TraceCommentAuthor,
  traceCommentThreadSelect,
} from "./trace-comment-reply-mapper";

/**
 * The columns every comment read selects: the legacy trace-comment row plus
 * the unified DTO's source, revisions, anchor state and body format.
 */
export const commentThreadRowSelect = {
  ...traceCommentThreadSelect,
  source: true,
  revision: true,
  anchorState: true,
  comments: {
    ...traceCommentThreadSelect.comments,
    select: {
      ...traceCommentThreadSelect.comments.select,
      revision: true,
      bodyFormat: true,
      reactions: {
        select: { emoji: true, userId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      // PLN-2187 T-2.1 (operator ruling 2026-10-15, no Liveblocks import):
      // confirmed uploads and the url-only rows a provider sync wrote, never an
      // upload still pending (`bucket` set, `uploadedAt` null) nor a row with
      // neither a url nor a bucket, as the Liveblocks sync writes, whose
      // download could only answer not_found.
      attachments: {
        where: {
          OR: [
            { bucket: null, url: { not: null } },
            { uploadedAt: { not: null } },
          ],
        },
        select: { id: true, name: true, mimeType: true, size: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  },
} satisfies Prisma.CommentThreadSelect;

export type CommentThreadRow = Prisma.CommentThreadGetPayload<{
  select: typeof commentThreadRowSelect;
}>;

type ThreadRowClient = Pick<TransactionClient, "commentThread">;

/**
 * The sources a read admits; native only unless the caller passes its
 * target's `commentThreadSources`.
 */
type ThreadSourceScope = { sources?: readonly ThreadSource[] };

const NATIVE_THREAD_SOURCES: readonly ThreadSource[] = [ThreadSource.Native];

/** The threads on one artifact, oldest first, as every list reads them. */
export type ArtifactThreadQuery = ThreadSourceScope & {
  organizationId: string;
  artifactId: string;
  surface?: CommentSurface;
  status?: ThreadStatus;
  /** ISS-11113: the by-client-id read, matched on the create's dedupe key. */
  clientId?: string;
  after?: TimeIdCursor;
  take: number;
};

export function findArtifactThreadRows(
  db: ThreadRowClient,
  query: ArtifactThreadQuery
): Promise<CommentThreadRow[]> {
  return db.commentThread.findMany({
    where: {
      organizationId: query.organizationId,
      artifactId: query.artifactId,
      ...(query.clientId ? { externalId: query.clientId } : {}),
      source: threadSourceWhere(query.sources ?? NATIVE_THREAD_SOURCES),
      ...(query.surface ? storedThreadSurfaceWhere(query.surface) : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.after ? afterCursorWhere(query.after) : {}),
    },
    select: commentThreadRowSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: query.take,
  });
}

export function findArtifactThreadRow(
  db: ThreadRowClient,
  input: ThreadSourceScope & {
    organizationId: string;
    artifactId: string;
    threadId: string;
  }
): Promise<CommentThreadRow | null> {
  return db.commentThread.findFirst({
    where: {
      id: input.threadId,
      organizationId: input.organizationId,
      artifactId: input.artifactId,
      source: threadSourceWhere(input.sources ?? NATIVE_THREAD_SOURCES),
    },
    select: commentThreadRowSelect,
  });
}

/** The thread on a known artifact that holds this live comment. */
export function findArtifactThreadRowForComment(
  db: ThreadRowClient,
  input: ThreadSourceScope & {
    organizationId: string;
    artifactId: string;
    commentId: string;
  }
): Promise<CommentThreadRow | null> {
  return db.commentThread.findFirst({
    where: {
      organizationId: input.organizationId,
      artifactId: input.artifactId,
      source: threadSourceWhere(input.sources ?? NATIVE_THREAD_SOURCES),
      comments: { some: { id: input.commentId, deletedAt: null } },
    },
    select: commentThreadRowSelect,
  });
}

/** Every author and resolver the rows name, read org-scoped in one query. */
export async function loadCommentAuthors(
  client: Pick<TransactionClient, "user">,
  organizationId: string,
  rows: readonly {
    resolvedById: string | null;
    comments: readonly { authorId: string }[];
  }[]
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

/** Threads after `after` in the `(createdAt, id)` order every list pages by. */
export function afterCursorWhere(
  after: TimeIdCursor
): Prisma.CommentThreadWhereInput {
  const createdAt = new Date(after.ms);
  return {
    OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: after.id } }],
  };
}
