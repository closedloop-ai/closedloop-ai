import "server-only";

import type { BranchViewComment } from "@repo/api/src/types/branch-view";
import { CommentKind } from "@repo/api/src/types/branch-view";
import { withDb } from "@repo/database";
import { replyToPullRequestReviewComment } from "@repo/github";
import { detectAuthorKind } from "@/app/branch-view/[externalLinkId]/comment-utils";
import type { PrContext } from "@/lib/resolve-pr-context";

export type ReplyToCommentResult =
  | { data: BranchViewComment; error: null }
  | { data: null; error: string };

/**
 * Reply to a PR review comment on GitHub and upsert the DB record.
 */
export async function replyToComment(
  ctx: PrContext,
  commentGithubId: number,
  body: string
): Promise<ReplyToCommentResult> {
  const { installationId, owner, repo, pullNumber, gitHubPullRequest } = ctx;

  // Post reply to GitHub
  const ghReply = await replyToPullRequestReviewComment(
    installationId,
    owner,
    repo,
    pullNumber,
    commentGithubId,
    body
  );

  const authorLogin = ghReply.user?.login ?? "unknown";
  const authorAvatarUrl = ghReply.user?.avatar_url ?? null;

  // Upsert DB record (idempotent with webhook delivery)
  if (gitHubPullRequest) {
    await withDb((db) =>
      db.gitHubPRReviewComment.upsert({
        where: { githubCommentId: String(ghReply.id) },
        create: {
          pullRequestId: gitHubPullRequest.id,
          githubCommentId: String(ghReply.id),
          inReplyToId: String(commentGithubId),
          reviewId: ghReply.pull_request_review_id
            ? String(ghReply.pull_request_review_id)
            : null,
          body: ghReply.body,
          path: ghReply.path,
          line: ghReply.line,
          authorLogin,
          authorAvatarUrl,
          state: "PENDING",
          htmlUrl: ghReply.html_url,
        },
        update: {
          body: ghReply.body,
        },
      })
    );
  }

  const comment: BranchViewComment = {
    id: String(ghReply.id),
    githubCommentId: String(ghReply.id),
    author: authorLogin,
    authorAvatar: authorAvatarUrl,
    authorKind: detectAuthorKind(authorLogin),
    body: ghReply.body,
    createdAt: ghReply.created_at,
    path: ghReply.path,
    line: ghReply.line,
    state: "PENDING",
    reviewId: ghReply.pull_request_review_id
      ? String(ghReply.pull_request_review_id)
      : null,
    htmlUrl: ghReply.html_url,
    inReplyToId: String(commentGithubId),
    kind: CommentKind.ReviewComment,
  };

  return { data: comment, error: null };
}
