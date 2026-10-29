/**
 * @file trace-comment-reply-mapper.ts
 * @description ISS-10382: mapping a stored reply row, and naming its author,
 * extracted from `service.ts`.
 *
 * A real seam rather than a line-count slice, on the same rule
 * `trace-comment-target-lookup.ts` (ISS-8200) and `trace-comment-metadata.ts`
 * (FEA-4281) were cut on: turning a persisted row into the wire shape is a
 * separate responsibility from deciding WHICH rows to read and what to write
 * back. ISS-11113 moved the thread select here on the same rule: it names the
 * columns the row type below describes.
 */

import {
  normalizeTraceCommentKind,
  type TraceComment,
  type TraceCommentReply,
} from "@repo/api/src/types/comment";
import type { Prisma, ThreadStatus } from "@repo/database";
import { extractBodyMentions } from "@/app/comments/mention-body";
import { readStoredTraceTextAnchor } from "@/app/comments/service/trace-comment-anchor-json";
import { parseTraceCommentMetadata } from "@/app/comments/service/trace-comment-metadata";
import {
  type TraceCommentSyncStateRow,
  traceCommentSyncAbandonedField,
  traceCommentSyncStatesSelect,
} from "@/app/comments/service/trace-comment-sync-state";
import type { TraceCommentTargetRecord } from "@/app/comments/service/trace-comment-target-lookup";
import { formatUserFullName } from "@/lib/user-display-name";

/** The author columns both mappers read, selected org-scoped by the service. */
export type TraceCommentAuthor = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  avatarUrl: string | null;
};

export function mapTraceCommentReply(
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

export function formatAuthorName(author: TraceCommentAuthor): string {
  // Divergent fallbacks (nullable email, then "Unknown user") kept at the call
  // site per FEA-3506; the name derivation routes through the shared SSOT.
  return formatUserFullName(author) || author.email || "Unknown user";
}

export type TraceCommentRow = {
  id: string;
  organizationId: string;
  artifactId: string;
  status: ThreadStatus;
  resolvedAt: Date | null;
  resolvedById: string | null;
  metadata: unknown;
  anchor: unknown;
  syncStates: TraceCommentSyncStateRow[];
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

export function mapTraceCommentRow(
  row: TraceCommentRow,
  authorById: ReadonlyMap<string, TraceCommentAuthor>,
  resolved: TraceCommentTargetRecord,
  viewerUserId: string
): TraceComment[] {
  const metadata = parseTraceCommentMetadata(row.metadata);
  const rootComment = row.comments[0];
  if (!(metadata && rootComment)) {
    return [];
  }
  const anchor = readStoredTraceTextAnchor(row.anchor, {
    organizationId: row.organizationId,
    threadId: row.id,
  });
  if (!anchor) {
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
      anchor,
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
      // ISS-10382: spread last and emit the key ONLY when dead-lettered, so an
      // ordinary comment carries no `syncAbandoned` at all — the shape the rail
      // and the desktop store already agree on.
      ...traceCommentSyncAbandonedField(row.syncStates),
    },
  ];
}

/** The columns a {@link TraceCommentRow} is read with. */
export const traceCommentThreadSelect = {
  id: true,
  organizationId: true,
  artifactId: true,
  status: true,
  resolvedAt: true,
  resolvedById: true,
  metadata: true,
  anchor: true,
  syncStates: traceCommentSyncStatesSelect,
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
