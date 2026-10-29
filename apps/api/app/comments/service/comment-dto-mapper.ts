import {
  normalizeTraceCommentKind,
  ThreadSource,
} from "@repo/api/src/types/comment";
import type {
  CollectionCapabilities,
  CommentPolicyKey,
} from "@repo/api/src/types/comment-capabilities";
import {
  type CommentAttachmentDto,
  type CommentDto,
  type CommentReactionDto,
  CommentSyncDirection,
  CommentSyncProvider,
  type CommentThreadDto,
  type CommentThreadSyncDto,
  commentApiPaths,
} from "@repo/api/src/types/comment-thread-dto";
import { extractCommentMentions } from "../mention-body";
import { itemPermissions } from "./comment-capabilities";
import type { CommentThreadRow } from "./comment-thread-rows";
import { storedThreadSurface } from "./stored-thread-surface";
import { readStoredCommentAnchor } from "./trace-comment-anchor-json";
import { parseTraceCommentMetadata } from "./trace-comment-metadata";
import {
  formatAuthorName,
  type TraceCommentAuthor,
} from "./trace-comment-reply-mapper";

export type CommentDtoContext = {
  viewerUserId: string;
  policyKey: CommentPolicyKey;
  capabilities: CollectionCapabilities;
  authors: ReadonlyMap<string, TraceCommentAuthor>;
};

/**
 * A stored thread as the unified DTO, or `null` when it cannot be shown: no
 * surface (metadata that is not a trace comment's, on a source that implies
 * none), no live comment left, or an anchor this build cannot read (reported
 * as `comments.data_invalid`).
 */
export function mapCommentThreadDto(
  row: CommentThreadRow,
  context: CommentDtoContext
): CommentThreadDto | null {
  const surface = storedThreadSurface(row);
  const root = row.comments[0];
  if (!(surface && root)) {
    return null;
  }
  const metadata = parseTraceCommentMetadata(row.metadata);
  const anchor = readThreadAnchor(row);
  if (anchor === undefined) {
    return null;
  }
  const participantIds = new Set(row.comments.map((c) => c.authorId));
  const permissionsFor = (authorId: string) =>
    itemPermissions(context.policyKey, context.capabilities, {
      viewerUserId: context.viewerUserId,
      commentAuthorId: authorId,
      threadAuthorId: root.authorId,
      threadParticipantIds: participantIds,
    });
  const comments = row.comments.map(
    (comment): CommentDto => ({
      id: comment.id,
      threadId: row.id,
      author: commentAuthorDto(comment.authorId, context.authors),
      body: comment.plainText ?? "",
      bodyFormat: comment.bodyFormat,
      mentions: extractCommentMentions(comment.body, comment.bodyFormat),
      revision: comment.revision,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
      editedAt: comment.editedAt?.toISOString() ?? null,
      permissions: permissionsFor(comment.authorId),
      reactions: reactionDtos(comment.reactions, context.viewerUserId),
      attachments: comment.attachments.map(attachmentDto),
    })
  );
  return {
    id: row.id,
    artifactId: row.artifactId,
    source: row.source,
    anchor,
    anchorState: row.anchorState,
    status: row.status,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedById
      ? commentAuthorDto(row.resolvedById, context.authors)
      : null,
    revision: row.revision,
    sync: threadSync(row),
    permissions: permissionsFor(root.authorId),
    provider: {},
    kind: normalizeTraceCommentKind(metadata?.commentKind),
    surface,
    createdAt: row.createdAt.toISOString(),
    comments,
  };
}

function commentAuthorDto(
  authorId: string,
  authors: ReadonlyMap<string, TraceCommentAuthor>
): CommentDto["author"] {
  const author = authors.get(authorId);
  return {
    id: authorId,
    name: author ? formatAuthorName(author) : null,
    avatarUrl: author?.avatarUrl ?? null,
  };
}

type CommentRow = CommentThreadRow["comments"][number];

/** One entry per emoji, in the order each emoji was first used. */
function reactionDtos(
  reactions: CommentRow["reactions"],
  viewerUserId: string
): CommentReactionDto[] {
  const byEmoji = new Map<string, CommentReactionDto>();
  for (const { emoji, userId } of reactions) {
    const entry = byEmoji.get(emoji) ?? {
      emoji,
      userIds: [],
      viewerReacted: false,
    };
    entry.userIds.push(userId);
    entry.viewerReacted ||= userId === viewerUserId;
    byEmoji.set(emoji, entry);
  }
  return [...byEmoji.values()];
}

function attachmentDto(
  attachment: CommentRow["attachments"][number]
): CommentAttachmentDto {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    downloadPath: commentApiPaths.attachment(attachment.id),
  };
}

/**
 * A thread the Liveblocks webhook sync wrote has no typed anchor and is shown
 * without its highlight (PLN-2187, operator ruling #8828, 2026-10-15), so its
 * absent anchor is expected rather than reported as data_invalid.
 */
function readThreadAnchor(row: CommentThreadRow) {
  if (row.source === ThreadSource.Liveblocks && row.anchor === null) {
    return null;
  }
  return readStoredCommentAnchor(row.anchor, {
    organizationId: row.organizationId,
    threadId: row.id,
  });
}

function threadSync(row: CommentThreadRow): CommentThreadSyncDto | null {
  const stored = row.syncStates[0];
  return stored
    ? {
        provider: CommentSyncProvider.Desktop,
        direction: CommentSyncDirection.Inbound,
        state: stored.state,
      }
    : null;
}
