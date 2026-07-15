import { z } from "zod";
import type { JsonObject } from "./common.js";
import type { BasicUser } from "./user.js";

export const ThreadSource = {
  Native: "NATIVE",
  Liveblocks: "LIVEBLOCKS",
  /** Persisted/shared source for GitHub comment projection rows. */
  Github: "GITHUB",
} as const;
export type ThreadSource = (typeof ThreadSource)[keyof typeof ThreadSource];

export const ThreadStatus = {
  Open: "OPEN",
  Resolved: "RESOLVED",
} as const;
export type ThreadStatus = (typeof ThreadStatus)[keyof typeof ThreadStatus];

export type CommentThread = {
  id: string;
  organizationId: string;
  source: ThreadSource;
  externalId: string | null;
  roomId: string | null;
  artifactId: string | null;
  status: ThreadStatus;
  metadata: JsonObject | null;
  createdAtVersion: number | null;
  resolvedAt: Date | null;
  resolvedById: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CommentThreadWithComments = CommentThread & {
  comments: Comment[];
  resolvedBy: BasicUser | null;
  createdBy: BasicUser | null;
};

export type Comment = {
  id: string;
  threadId: string;
  authorId: string;
  body: JsonObject;
  plainText: string | null;
  externalId: string | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  author?: BasicUser | null;
  reactions?: CommentReaction[];
  attachments?: CommentAttachment[];
};

export type CommentReaction = {
  id: string;
  commentId: string;
  userId: string;
  emoji: string;
  createdAt: Date;
};

export type CommentAttachment = {
  id: string;
  commentId: string;
  externalId: string | null;
  name: string;
  size: number | null;
  mimeType: string | null;
  url: string | null;
  createdAt: Date;
};

export const TraceCommentTargetType = {
  Session: "session",
  Branch: "branch",
} as const;
export type TraceCommentTargetType =
  (typeof TraceCommentTargetType)[keyof typeof TraceCommentTargetType];

export const TraceCommentSurface = {
  SessionDetail: "session_detail",
  BranchDetail: "branch_detail",
} as const;
export type TraceCommentSurface =
  (typeof TraceCommentSurface)[keyof typeof TraceCommentSurface];

export const TRACE_COMMENT_METADATA_KIND = "trace_comment" as const;
export const TRACE_COMMENT_SCHEMA_VERSION = 1 as const;
export const TRACE_COMMENT_BODY_MAX_LENGTH = 10_000;
export const TRACE_COMMENT_ANCHOR_TEXT_MAX_LENGTH = 5000;
export const TRACE_COMMENT_ID_MAX_LENGTH = 500;
export const TRACE_COMMENT_REQUEST_MAX_BYTES = 32_768;
/** Raw request byte cap for POST /documents/:id/threads (anchored or unanchored). */
export const DOCUMENT_THREAD_REQUEST_MAX_BYTES = 32_768;

export type TraceCommentTarget = {
  type: TraceCommentTargetType;
  /**
   * Surface identity from the caller. Web session/branch routes normally pass a
   * cloud artifact id; desktop may pass a local external session id or encoded
   * branch id, which the API resolves to the same artifact before persistence.
   */
  id: string;
};

export type TraceTextAnchor = {
  /** Stable trace identity derived from the rendered producer and row. */
  traceId: string;
  /** Stable turn identity used to reject stale row-only highlight matches. */
  turnId: string;
  row: number;
  selectedText: string;
  sourceText: string;
  startOffset: number;
  endOffset: number;
  sessionId?: string | null;
  actor?: {
    name: string | null;
    human: string | null;
  } | null;
};

/** Draft emitted by the trace renderer when a selected passage is submitted. */
export type TraceCommentDraft = {
  anchor: TraceTextAnchor;
  body: string;
};

/** Body-only payload for replying to an anchored trace comment thread. */
export type TraceCommentReplyDraft = {
  body: string;
};

/** Body-only edit payload for an existing trace comment. */
export type TraceCommentUpdate = {
  body: string;
};

/** Delete response for a trace comment mutation. */
export type TraceCommentDeleteResult = {
  deleted: true;
};

/** Persisted reply in an anchored trace comment thread. */
export type TraceCommentReply = {
  id: string;
  threadId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  authorId: string;
  authorName: string | null;
  authorAvatarUrl: string | null;
  canEdit: boolean;
  canDelete: boolean;
};

/**
 * Persisted trace comment returned by the REST API. Anchor metadata lives on the
 * backing thread; the text body lives on the root comment, with replies stored
 * as subsequent native comments in the same thread.
 */
export type TraceComment = TraceCommentDraft & {
  id: string;
  threadId: string;
  target: TraceCommentTarget;
  artifactId: string;
  surface: TraceCommentSurface;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  authorId: string;
  authorName: string | null;
  authorAvatarUrl: string | null;
  canEdit: boolean;
  canDelete: boolean;
  /**
   * First-level replies. Older clients and cached payloads may omit this field,
   * so consumers must normalize missing replies to an empty array.
   */
  replies?: TraceCommentReply[];
};

/**
 * Shared target validator for trace comment transports. Keeping this beside the
 * wire type prevents web, API, and desktop IPC from accepting different target
 * discriminators or unbounded ids.
 */
export const traceCommentTargetSchema: z.ZodType<TraceCommentTarget> = z.object(
  {
    type: z.union([
      z.literal(TraceCommentTargetType.Session),
      z.literal(TraceCommentTargetType.Branch),
    ]),
    id: z.string().min(1).max(TRACE_COMMENT_ID_MAX_LENGTH),
  }
);

/**
 * Shared anchor validator for trace text selections persisted in comment
 * metadata. Bounds keep authenticated writes from storing arbitrarily large
 * trace excerpts while preserving enough context for highlight recovery.
 */
export const traceTextAnchorSchema: z.ZodType<TraceTextAnchor> = z
  .object({
    traceId: z.string().min(1).max(TRACE_COMMENT_ID_MAX_LENGTH),
    turnId: z.string().min(1).max(TRACE_COMMENT_ID_MAX_LENGTH),
    row: z.number().int().nonnegative(),
    selectedText: z.string().min(1).max(TRACE_COMMENT_ANCHOR_TEXT_MAX_LENGTH),
    sourceText: z.string().max(TRACE_COMMENT_ANCHOR_TEXT_MAX_LENGTH),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    sessionId: z
      .string()
      .max(TRACE_COMMENT_ID_MAX_LENGTH)
      .nullable()
      .optional(),
    actor: z
      .object({
        name: z.string().max(TRACE_COMMENT_ID_MAX_LENGTH).nullable(),
        human: z.string().max(TRACE_COMMENT_ID_MAX_LENGTH).nullable(),
      })
      .nullable()
      .optional(),
  })
  .refine((anchor) => anchor.endOffset >= anchor.startOffset, {
    message: "endOffset must be greater than or equal to startOffset",
    path: ["endOffset"],
  });

/** Validates a new root trace comment payload. */
export const traceCommentDraftSchema: z.ZodType<TraceCommentDraft> = z.object({
  anchor: traceTextAnchorSchema,
  body: z.string().min(1).max(TRACE_COMMENT_BODY_MAX_LENGTH),
});

/** Validates a trace comment reply payload. */
export const traceCommentReplyDraftSchema: z.ZodType<TraceCommentReplyDraft> =
  z.object({
    body: z.string().min(1).max(TRACE_COMMENT_BODY_MAX_LENGTH),
  });

/** Validates a trace comment edit payload. */
export const traceCommentUpdateSchema: z.ZodType<TraceCommentUpdate> = z.object(
  {
    body: z.string().min(1).max(TRACE_COMMENT_BODY_MAX_LENGTH),
  }
);

/** Canonical HTTP collection path for target-scoped trace comments. */
export function traceCommentsPath(target: TraceCommentTarget): string {
  const base =
    target.type === TraceCommentTargetType.Session
      ? "/agent-sessions"
      : "/branches";
  return `${base}/${encodeURIComponent(target.id)}/trace-comments`;
}

/** Canonical HTTP member path for a root comment or reply id. */
export function traceCommentPath(
  target: TraceCommentTarget,
  commentId: string
): string {
  return `${traceCommentsPath(target)}/${encodeURIComponent(commentId)}`;
}

/** Canonical HTTP path for creating first-level replies under a trace comment. */
export function traceCommentRepliesPath(
  target: TraceCommentTarget,
  commentId: string
): string {
  return `${traceCommentPath(target, commentId)}/replies`;
}
