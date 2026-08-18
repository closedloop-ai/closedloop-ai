import type { Octokit } from "@octokit/rest";
import {
  type CreatePullRequestReviewCommentWithUserTokenInput,
  type GitHubPullRequestIssueComment,
  type GitHubPullRequestReviewComment,
  mapPullRequestIssueComment,
  mapPullRequestReviewComment,
} from "./comment-payloads";
import { fetchReviewThreadNodeIdByCommentId } from "./review-thread-lookup";

/**
 * User-authored pull-request comment writes.
 *
 * Every function here takes the caller's Octokit (PLN-1525), so one client is
 * resolved per request instead of one per write, and the resolver's timeout,
 * rate-limit accounting, and 401-observation apply to writes as they already do
 * to reads.
 *
 * `WithUserToken` names the CREDENTIAL FAMILY, and it is a hard contract: the
 * comment must be attributed to the human who wrote it, so the client passed in
 * must be a user client (`GitHubAccessIntent.WriteAsUser`), never an
 * installation client. The parameter type cannot express that — passing an
 * installation Octokit here would compile and would silently post as the app.
 * `apps/api/app/comments/github-identity.ts` is the only sanctioned source.
 */

/**
 * Create a general pull request conversation comment as the authenticated user.
 */
export async function createPullRequestIssueCommentWithUserToken(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string
): Promise<GitHubPullRequestIssueComment> {
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body,
  });

  return mapPullRequestIssueComment(data);
}

/**
 * Update a general pull request conversation comment as the authenticated user.
 */
export async function updatePullRequestIssueCommentWithUserToken(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  body: string
): Promise<GitHubPullRequestIssueComment> {
  const { data } = await octokit.rest.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body,
  });

  return mapPullRequestIssueComment(data);
}

/**
 * Delete a general pull request conversation comment as the authenticated user.
 */
export async function deletePullRequestIssueCommentWithUserToken(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number
): Promise<void> {
  await octokit.rest.issues.deleteComment({
    owner,
    repo,
    comment_id: commentId,
  });
}

/**
 * Create an inline pull request review comment as the authenticated user.
 */
export async function createPullRequestReviewCommentWithUserToken(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  input: CreatePullRequestReviewCommentWithUserTokenInput
): Promise<GitHubPullRequestReviewComment> {
  const { data } = await octokit.rest.pulls.createReviewComment({
    owner,
    repo,
    pull_number: pullNumber,
    body: input.body,
    commit_id: input.commitId,
    path: input.path,
    line: input.line,
    side: input.side,
    start_line: input.startLine,
    start_side: input.startSide,
  });

  return mapPullRequestReviewComment(
    data,
    await fetchReviewThreadNodeIdByCommentId(
      octokit,
      owner,
      repo,
      pullNumber,
      data.id
    )
  );
}

/**
 * Reply to an existing pull request review comment as the authenticated user.
 */
export async function createReplyForReviewCommentWithUserToken(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  commentId: number,
  body: string
): Promise<GitHubPullRequestReviewComment> {
  const { data } = await octokit.rest.pulls.createReplyForReviewComment({
    owner,
    repo,
    pull_number: pullNumber,
    comment_id: commentId,
    body,
  });

  return mapPullRequestReviewComment(
    data,
    await fetchReviewThreadNodeIdByCommentId(
      octokit,
      owner,
      repo,
      pullNumber,
      data.id
    )
  );
}

/**
 * Update an inline pull request review comment as the authenticated user.
 */
export async function updatePullRequestReviewCommentWithUserToken(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  body: string
): Promise<GitHubPullRequestReviewComment> {
  const { data } = await octokit.rest.pulls.updateReviewComment({
    owner,
    repo,
    comment_id: commentId,
    body,
  });

  return mapPullRequestReviewComment(data);
}

/**
 * Delete an inline pull request review comment as the authenticated user.
 */
export async function deletePullRequestReviewCommentWithUserToken(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number
): Promise<void> {
  await octokit.rest.pulls.deleteReviewComment({
    owner,
    repo,
    comment_id: commentId,
  });
}

/**
 * Resolve a GitHub pull request review thread as the authenticated user.
 */
export async function resolvePullRequestReviewThreadWithUserToken(
  octokit: Octokit,
  threadId: string
): Promise<{ id: string; isResolved: boolean }> {
  const response = await octokit.graphql<{
    resolveReviewThread: { thread: { id: string; isResolved: boolean } };
  }>(
    `
      mutation ResolveReviewThread($threadId: ID!) {
        resolveReviewThread(input: {threadId: $threadId}) {
          thread {
            id
            isResolved
          }
        }
      }
    `,
    { threadId }
  );

  return response.resolveReviewThread.thread;
}

/**
 * Reopen a GitHub pull request review thread as the authenticated user.
 */
export async function unresolvePullRequestReviewThreadWithUserToken(
  octokit: Octokit,
  threadId: string
): Promise<{ id: string; isResolved: boolean }> {
  const response = await octokit.graphql<{
    unresolveReviewThread: { thread: { id: string; isResolved: boolean } };
  }>(
    `
      mutation UnresolveReviewThread($threadId: ID!) {
        unresolveReviewThread(input: {threadId: $threadId}) {
          thread {
            id
            isResolved
          }
        }
      }
    `,
    { threadId }
  );

  return response.unresolveReviewThread.thread;
}
