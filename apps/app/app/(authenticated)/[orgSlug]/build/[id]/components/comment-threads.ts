import type { BranchViewComment } from "@repo/api/src/types/branch-view";
import { getBranchViewCommentUiId } from "../comment-context";

export type CommentThread = {
  root: BranchViewComment;
  replies: BranchViewComment[];
};

/**
 * Group flat comments into threads. Comments with inReplyToId are attached to
 * their parent by thread-local provider identity so optional source
 * serialization cannot split a valid GitHub reply from its parent. Orphans
 * become standalone roots. Shared by the PR comments list and the inline diff
 * comment cards.
 */
export function buildCommentThreads(
  comments: BranchViewComment[]
): CommentThread[] {
  const byProviderScopedId = new Map<string, BranchViewComment>();
  for (const comment of comments) {
    byProviderScopedId.set(getProviderScopedCommentId(comment), comment);
  }

  const threads = new Map<string, CommentThread>();

  for (const comment of comments) {
    if (!comment.inReplyToId) {
      threads.set(getBranchViewCommentUiId(comment), {
        root: comment,
        replies: [],
      });
    }
  }

  for (const comment of comments) {
    if (!comment.inReplyToId) {
      continue;
    }
    const parent = byProviderScopedId.get(
      getProviderScopedReplyParentId(comment)
    );
    const parentThread = parent
      ? threads.get(getBranchViewCommentUiId(parent))
      : undefined;
    if (parentThread) {
      parentThread.replies.push(comment);
    } else {
      threads.set(getBranchViewCommentUiId(comment), {
        root: comment,
        replies: [],
      });
    }
  }

  for (const thread of threads.values()) {
    thread.replies.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }

  return Array.from(threads.values()).sort(
    (a, b) =>
      new Date(a.root.createdAt).getTime() -
      new Date(b.root.createdAt).getTime()
  );
}

function getProviderScopedCommentId(comment: BranchViewComment): string {
  return [
    comment.threadId ?? "unknown-thread",
    comment.kind,
    comment.githubCommentId,
  ].join(":");
}

function getProviderScopedReplyParentId(comment: BranchViewComment): string {
  return [
    comment.threadId ?? "unknown-thread",
    comment.kind,
    comment.inReplyToId ?? "",
  ].join(":");
}
