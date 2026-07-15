import type {
  TraceComment,
  TraceCommentDeleteResult,
  TraceCommentDraft,
  TraceCommentReplyDraft,
  TraceCommentTarget,
  TraceCommentUpdate,
} from "@repo/api/src/types/comment";
import {
  traceCommentPath,
  traceCommentRepliesPath,
  traceCommentsPath,
} from "@repo/api/src/types/comment";

/**
 * Data-source port for persisted trace comments. Web uses the HTTP
 * implementation; desktop injects an IPC bridge backed by the local SQLite
 * store, with main-process cloud sync when available.
 */
export type TraceCommentsDataSource = {
  scope: string;
  list(target: TraceCommentTarget): Promise<TraceComment[]>;
  create(
    target: TraceCommentTarget,
    draft: TraceCommentDraft
  ): Promise<TraceComment>;
  reply(
    target: TraceCommentTarget,
    commentId: string,
    draft: TraceCommentReplyDraft
  ): Promise<TraceComment>;
  update(
    target: TraceCommentTarget,
    commentId: string,
    update: TraceCommentUpdate
  ): Promise<TraceComment>;
  delete(
    target: TraceCommentTarget,
    commentId: string
  ): Promise<TraceCommentDeleteResult>;
};

type TraceCommentsHttpClient = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
  post<T>(path: string, data: unknown): Promise<T>;
  patch<T>(path: string, data: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
};

export function createHttpTraceCommentsDataSource(
  api: TraceCommentsHttpClient
): TraceCommentsDataSource {
  return {
    scope: "http",
    list: (target) =>
      api.get<TraceComment[]>(traceCommentsPath(target), { cache: "no-store" }),
    create: (target, draft) =>
      api.post<TraceComment>(traceCommentsPath(target), draft),
    reply: (target, commentId, draft) =>
      api.post<TraceComment>(traceCommentRepliesPath(target, commentId), draft),
    update: (target, commentId, update) =>
      api.patch<TraceComment>(traceCommentPath(target, commentId), update),
    delete: (target, commentId) =>
      api.delete<TraceCommentDeleteResult>(traceCommentPath(target, commentId)),
  };
}
