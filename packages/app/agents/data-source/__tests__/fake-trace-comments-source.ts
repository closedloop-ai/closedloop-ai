import type {
  TraceComment,
  TraceCommentDraft,
  TraceCommentTarget,
} from "@repo/api/src/types/comment";
import type { TraceCommentsDataSource } from "../trace-comments-data-source";

type FakeTraceCommentsSourceOptions = {
  commentsByTarget: Map<string, TraceComment[]>;
  makeTraceComment: (
    target: TraceCommentTarget,
    draft: TraceCommentDraft,
    index: number
  ) => TraceComment;
};

/** Build a mutable trace-comments data source for component tests. */
export function createFakeTraceCommentsSource({
  commentsByTarget,
  makeTraceComment,
}: FakeTraceCommentsSourceOptions): TraceCommentsDataSource {
  return {
    scope: "test",
    list: (target) =>
      Promise.resolve(
        commentsByTarget.get(traceCommentTargetKey(target)) ?? []
      ),
    create: (target, draft) => {
      const key = traceCommentTargetKey(target);
      const current = commentsByTarget.get(key) ?? [];
      const created = makeTraceComment(target, draft, current.length + 1);
      commentsByTarget.set(key, [...current, created]);
      return Promise.resolve(created);
    },
    reply: (target, commentId, draft) => {
      const key = traceCommentTargetKey(target);
      const current = commentsByTarget.get(key) ?? [];
      const updated = current.map((comment) =>
        comment.id === commentId
          ? (() => {
              const replies = comment.replies ?? [];
              return {
                ...comment,
                replies: [
                  ...replies,
                  {
                    id: `${comment.id}-reply-${replies.length + 1}`,
                    threadId: comment.threadId,
                    body: draft.body,
                    createdAt: comment.createdAt,
                    updatedAt: comment.createdAt,
                    editedAt: null,
                    authorId: "user-test",
                    authorName: "Test User",
                    authorAvatarUrl: null,
                    canEdit: true,
                    canDelete: true,
                  },
                ],
              };
            })()
          : comment
      );
      commentsByTarget.set(key, updated);
      const result = updated.find((comment) => comment.id === commentId);
      return result
        ? Promise.resolve(result)
        : Promise.reject(new Error("Trace comment not found."));
    },
    update: (target, commentId, update) => {
      const key = traceCommentTargetKey(target);
      const current = commentsByTarget.get(key) ?? [];
      const updated = current.map((comment) =>
        comment.id === commentId
          ? {
              ...comment,
              body: update.body,
              editedAt: comment.updatedAt,
            }
          : comment
      );
      commentsByTarget.set(key, updated);
      const result = updated.find((comment) => comment.id === commentId);
      return result
        ? Promise.resolve(result)
        : Promise.reject(new Error("Trace comment not found."));
    },
    delete: (target, commentId) => {
      const key = traceCommentTargetKey(target);
      const current = commentsByTarget.get(key) ?? [];
      commentsByTarget.set(
        key,
        current.filter((comment) => comment.id !== commentId)
      );
      return Promise.resolve({ deleted: true });
    },
  };
}

/** Stable key shared by tests that group comments by trace target. */
export function traceCommentTargetKey(target: TraceCommentTarget): string {
  return `${target.type}:${target.id}`;
}
