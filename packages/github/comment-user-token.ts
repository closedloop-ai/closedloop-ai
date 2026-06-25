import { Octokit } from "@octokit/rest";
import {
  type CreatePullRequestReviewCommentWithUserTokenInput,
  type GitHubPullRequestIssueComment,
  type GitHubPullRequestReviewComment,
  mapPullRequestIssueComment,
  mapPullRequestReviewComment,
} from "./comment-payloads";
import { fetchReviewThreadNodeIdByCommentId } from "./review-thread-lookup";

function getUserTokenOctokit(userAccessToken: string): Octokit {
  return new Octokit({
    auth: userAccessToken,
  });
}

/**
 * Create a general pull request conversation comment as the authenticated user.
 */
export async function createPullRequestIssueCommentWithUserToken(
  userAccessToken: string,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string
): Promise<GitHubPullRequestIssueComment> {
  const octokit = getUserTokenOctokit(userAccessToken);
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
  userAccessToken: string,
  owner: string,
  repo: string,
  commentId: number,
  body: string
): Promise<GitHubPullRequestIssueComment> {
  const octokit = getUserTokenOctokit(userAccessToken);
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
  userAccessToken: string,
  owner: string,
  repo: string,
  commentId: number
): Promise<void> {
  const octokit = getUserTokenOctokit(userAccessToken);
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
  userAccessToken: string,
  owner: string,
  repo: string,
  pullNumber: number,
  input: CreatePullRequestReviewCommentWithUserTokenInput
): Promise<GitHubPullRequestReviewComment> {
  const octokit = getUserTokenOctokit(userAccessToken);
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
  userAccessToken: string,
  owner: string,
  repo: string,
  pullNumber: number,
  commentId: number,
  body: string
): Promise<GitHubPullRequestReviewComment> {
  const octokit = getUserTokenOctokit(userAccessToken);
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
  userAccessToken: string,
  owner: string,
  repo: string,
  commentId: number,
  body: string
): Promise<GitHubPullRequestReviewComment> {
  const octokit = getUserTokenOctokit(userAccessToken);
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
  userAccessToken: string,
  owner: string,
  repo: string,
  commentId: number
): Promise<void> {
  const octokit = getUserTokenOctokit(userAccessToken);
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
  userAccessToken: string,
  threadId: string
): Promise<{ id: string; isResolved: boolean }> {
  const octokit = getUserTokenOctokit(userAccessToken);
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
  userAccessToken: string,
  threadId: string
): Promise<{ id: string; isResolved: boolean }> {
  const octokit = getUserTokenOctokit(userAccessToken);
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
