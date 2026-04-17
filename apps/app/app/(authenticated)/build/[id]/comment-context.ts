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
  return comments.find((c) => c.id === id) ?? null;
}

export function buildPrCommentChatContext(
  comment: BranchViewComment
): PrCommentContext {
  return {
    id: comment.id,
    filePath: comment.path ?? undefined,
    line: comment.line ?? undefined,
    body: comment.body,
  };
}
