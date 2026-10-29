import type { ExternalGitHubUser } from "@/app/comments/external-authors";
import { normalizeGitHubDiffSide } from "@/app/comments/github-diff-side";
import type { GitHubExternalComment } from "./apply-external-events";
import type { GitHubReviewThreadPosition } from "./github-projection-contract";

/**
 * The fields GitHub sends for an issue or review comment, alike in a webhook
 * payload and a REST list, so the webhooks and the reconcile build the same
 * `applyExternal` comment from them.
 */
type GitHubProviderComment = {
  id: number;
  html_url: string;
  body: string;
  user: ExternalGitHubUser | null;
  created_at: string;
  updated_at: string;
};

type GitHubProviderReviewComment = GitHubProviderComment & {
  in_reply_to_id?: number | null;
  path: string;
  line: number | null;
  original_line?: number | null;
  side?: string | null;
  start_line?: number | null;
  start_side?: string | null;
  commit_id?: string | null;
};

export function gitHubExternalComment(
  comment: GitHubProviderComment
): GitHubExternalComment {
  return {
    githubCommentId: comment.id,
    htmlUrl: comment.html_url,
    bodyMarkdown: comment.body,
    author: comment.user,
    createdAt: new Date(comment.created_at),
    providerUpdatedAt: new Date(comment.updated_at),
  };
}

export function gitHubExternalReviewComment(
  comment: GitHubProviderReviewComment
): GitHubExternalComment {
  return {
    ...gitHubExternalComment(comment),
    githubInReplyToCommentId: comment.in_reply_to_id ?? null,
  };
}

export function gitHubReviewThreadPosition(
  comment: GitHubProviderReviewComment
): GitHubReviewThreadPosition {
  return {
    path: comment.path,
    line: comment.line,
    originalLine: comment.original_line ?? null,
    side: normalizeGitHubDiffSide(comment.side),
    startLine: comment.start_line ?? null,
    startSide: normalizeGitHubDiffSide(comment.start_side),
    commitSha: comment.commit_id ?? null,
  };
}
