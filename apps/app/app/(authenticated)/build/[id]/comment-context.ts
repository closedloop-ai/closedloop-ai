import type { ArtifactChatPrCommentContext } from "@/components/artifact-editor/artifact-chat-panel";
import type { StubPrComment } from "./types";

export function findCommentById(
  comments: StubPrComment[],
  id: string | null
): StubPrComment | null {
  if (!id) {
    return null;
  }
  for (const c of comments) {
    if (c.id === id) {
      return c;
    }
    const inReplies = findCommentById(c.replies, id);
    if (inReplies) {
      return inReplies;
    }
  }
  return null;
}

export function buildPrCommentChatContext(
  comment: StubPrComment
): ArtifactChatPrCommentContext {
  return {
    id: comment.id,
    filePath: comment.path,
    line: comment.line,
    body: comment.body,
  };
}
