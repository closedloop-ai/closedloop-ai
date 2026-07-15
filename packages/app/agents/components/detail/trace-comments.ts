import type {
  TraceComment,
  TraceCommentReply,
} from "@repo/api/src/types/comment";

export type {
  TraceCommentDraft,
  TraceTextAnchor,
} from "@repo/api/src/types/comment";

/**
 * Trace comment item displayed in session and branch rails. The selected quote
 * is canonical for display; row/offset metadata is best-effort jump context and
 * may degrade after trace refreshes.
 */
export type TraceCommentItem = Omit<TraceComment, "replies"> & {
  createdAtLabel: string;
  replies: TraceCommentReplyItem[];
};

/** Display model for a reply nested under an anchored trace comment. */
export type TraceCommentReplyItem = TraceCommentReply & {
  createdAtLabel: string;
};
