import type { BranchViewComment } from "./types";

export type PrCommentContext = {
  id: string;
  filePath?: string;
  line?: number;
  body: string;
};

export function findCommentById(
  comments: BranchViewComment[],
  id: string | null
): BranchViewComment | null {
  if (!id) {
    return null;
  }
  return (
    comments.find((comment) => getBranchViewCommentUiId(comment) === id) ??
    comments.find((comment) => comment.id === id) ??
    null
  );
}

export function buildPrCommentChatContext(
  comment: BranchViewComment
): PrCommentContext {
  return {
    id: getBranchViewCommentUiId(comment),
    filePath: comment.path ?? undefined,
    line: comment.line ?? undefined,
    body: comment.body,
  };
}

/**
 * Build a Branch View UI identity that cannot collide when GitHub issue and
 * review comments share the same raw provider id.
 */
export function getBranchViewCommentUiId(comment: BranchViewComment): string {
  if (comment.commentId) {
    return `comment:${comment.commentId}`;
  }
  if (comment.threadId) {
    return `thread:${comment.threadId}:${comment.kind}:github:${comment.githubCommentId}`;
  }
  return `${comment.source ?? "unknown"}:${comment.kind}:github:${comment.githubCommentId}`;
}
