import type {
  TraceComment,
  TraceCommentDeleteResult,
  TraceCommentDraft,
  TraceCommentReplyDraft,
  TraceCommentTarget,
  TraceCommentUpdate,
} from "@repo/api/src/types/comment";

export const SHARED_TRACE_COMMENTS_IPC_CHANNELS = {
  list: "desktop:shared-trace-comments:list",
  create: "desktop:shared-trace-comments:create",
  reply: "desktop:shared-trace-comments:reply",
  update: "desktop:shared-trace-comments:update",
  delete: "desktop:shared-trace-comments:delete",
} as const;

export const SHARED_TRACE_COMMENTS_IPC_CHANNEL_LIST = [
  SHARED_TRACE_COMMENTS_IPC_CHANNELS.list,
  SHARED_TRACE_COMMENTS_IPC_CHANNELS.create,
  SHARED_TRACE_COMMENTS_IPC_CHANNELS.reply,
  SHARED_TRACE_COMMENTS_IPC_CHANNELS.update,
  SHARED_TRACE_COMMENTS_IPC_CHANNELS.delete,
] as const;

export type SharedTraceCommentsIpcChannel =
  (typeof SHARED_TRACE_COMMENTS_IPC_CHANNEL_LIST)[number];

export type SharedTraceCommentTarget = TraceCommentTarget;
export type SharedTraceCommentDraft = TraceCommentDraft;
export type SharedTraceCommentReplyDraft = TraceCommentReplyDraft;
export type SharedTraceCommentUpdate = TraceCommentUpdate;
export type SharedTraceComment = TraceComment;
export type SharedTraceCommentDeleteResult = TraceCommentDeleteResult;
