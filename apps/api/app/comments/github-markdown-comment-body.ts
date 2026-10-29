import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import type { Prisma } from "@repo/database";

/**
 * The stored body of a projected GitHub comment and its `bodyFormat`, written
 * together so a GitHub body is never stored under another format (ISS-11212).
 */
export function githubMarkdownCommentBodyFields(markdown: string): {
  body: Prisma.InputJsonObject;
  bodyFormat: typeof CommentBodyFormat.Markdown;
} {
  return {
    body: { type: "github_markdown", markdown },
    bodyFormat: CommentBodyFormat.Markdown,
  };
}
