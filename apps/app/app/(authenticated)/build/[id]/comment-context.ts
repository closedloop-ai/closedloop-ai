import type { ArtifactChatPrCommentContext } from "@/components/artifact-editor/artifact-chat-panel";
import type { BranchViewComment } from "./types";

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
): ArtifactChatPrCommentContext {
  return {
    id: comment.id,
    filePath: comment.path ?? undefined,
    line: comment.line ?? undefined,
    body: comment.body,
  };
}
