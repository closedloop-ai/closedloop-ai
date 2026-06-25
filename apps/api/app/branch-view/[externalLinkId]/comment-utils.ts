import {
  type BranchViewComment,
  type BranchViewCommentSource,
  GITHUB_COMMENT_THREAD_KIND_TO_COMMENT_KIND,
  type GitHubCommentThreadKind,
  type GitHubDiffSide,
  getDefaultBranchViewGithubCommentCapabilities,
  PRReviewCommentState,
  type PrCommentAuthorKind,
  THREAD_SOURCE_TO_BRANCH_VIEW_COMMENT_SOURCE,
} from "@repo/api/src/types/branch-view";
import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { z } from "zod";

const githubMarkdownBodySchema = z.object({
  type: z.literal("github_markdown"),
  markdown: z.string(),
});

export type UnifiedBranchViewCommentInput = {
  thread: {
    id: string;
    source: ThreadSource;
    status: ThreadStatus;
    legacyState: PRReviewCommentState | null;
    threadKind: GitHubCommentThreadKind | null;
    reviewId: string | null;
    htmlUrl: string | null;
    path: string | null;
    line: number | null;
    commitSha: string | null;
    side: GitHubDiffSide | null;
    startLine: number | null;
    startSide: GitHubDiffSide | null;
    resolvable: boolean;
  };
  comment: {
    id: string;
    body: unknown;
    plainText: string | null;
    createdAt: Date;
    githubCommentId: string | null;
    githubInReplyToCommentId: string | null;
    githubHtmlUrl: string | null;
  };
  author: {
    login: string;
    avatarUrl: string | null;
    profileUrl: string | null;
  };
};

/**
 * Detect bot authors by GitHub's [bot] suffix convention.
 */
export function detectAuthorKind(login: string): PrCommentAuthorKind {
  return login.endsWith("[bot]") ? "bot" : "user";
}

/**
 * Map unified CommentThread/Comment projection rows into the stable
 * BranchViewComment contract. Missing remote GitHub ids are invalid for public
 * branch-view output and return null instead of falling back to local ids.
 */
export function toBranchViewComment(
  input: UnifiedBranchViewCommentInput
): BranchViewComment | null {
  const githubCommentId = input.comment.githubCommentId?.trim();
  if (!githubCommentId) {
    return null;
  }

  const kind = input.thread.threadKind
    ? GITHUB_COMMENT_THREAD_KIND_TO_COMMENT_KIND[input.thread.threadKind]
    : null;
  if (!kind) {
    return null;
  }

  return {
    id: githubCommentId,
    githubCommentId,
    source: branchViewCommentSource(input.thread.source),
    threadId: input.thread.id,
    commentId: input.comment.id,
    author: input.author.login,
    authorAvatar: input.author.avatarUrl,
    authorProfileUrl: input.author.profileUrl,
    authorKind: detectAuthorKind(input.author.login),
    body: branchViewCommentBody(input.comment.body, input.comment.plainText),
    createdAt: input.comment.createdAt.toISOString(),
    path: input.thread.path,
    line: input.thread.line,
    anchorCommitSha: input.thread.commitSha,
    side: input.thread.side,
    startLine: input.thread.startLine,
    startSide: input.thread.startSide,
    state: input.thread.legacyState ?? PRReviewCommentState.Pending,
    reviewId: input.thread.reviewId,
    htmlUrl: input.comment.githubHtmlUrl ?? input.thread.htmlUrl ?? "",
    inReplyToId: input.comment.githubInReplyToCommentId,
    kind,
    resolvable: input.thread.resolvable,
    resolved: input.thread.status === ThreadStatus.Resolved,
    ...getDefaultBranchViewGithubCommentCapabilities(),
  };
}

function branchViewCommentSource(
  source: ThreadSource
): BranchViewCommentSource | undefined {
  return source === ThreadSource.Github
    ? THREAD_SOURCE_TO_BRANCH_VIEW_COMMENT_SOURCE[ThreadSource.Github]
    : undefined;
}

function branchViewCommentBody(
  body: unknown,
  plainText: string | null
): string {
  const parsed = githubMarkdownBodySchema.safeParse(body);
  if (parsed.success) {
    return parsed.data.markdown;
  }

  return plainText ?? "";
}
