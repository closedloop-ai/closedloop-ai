/**
 * Stable subset of a GitHub user payload used by PR comment sync and webhook
 * projection. `id` is the numeric GitHub database id when REST provides it.
 */
export type GitHubCommentAuthor = {
  id: number | null;
  login: string;
  node_id: string | null;
  avatar_url: string;
};

/**
 * REST issue-comment shape normalized for PR conversation comments.
 */
export type GitHubPullRequestIssueComment = {
  id: number;
  node_id: string | null;
  user: GitHubCommentAuthor | null;
  body: string;
  author_association: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  deleted_at: string | null;
  is_deleted: boolean;
  is_updated: boolean;
};

/**
 * REST review-comment shape normalized for inline PR comments, enriched with a
 * GraphQL review-thread node id and resolved state when available.
 */
export type GitHubPullRequestReviewComment = {
  id: number;
  node_id: string | null;
  path: string;
  line: number | null;
  side: string | null;
  start_line: number | null;
  start_side: string | null;
  original_line: number | null;
  original_start_line: number | null;
  body: string;
  user: GitHubCommentAuthor | null;
  author_association: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  commit_id: string | null;
  pull_request_review_id: number | null;
  review_thread_node_id: string | null;
  review_thread_is_resolved: boolean | null;
  in_reply_to_id: number | null;
  deleted_at: string | null;
  is_deleted: boolean;
  is_updated: boolean;
};

export type CreatePullRequestReviewCommentWithUserTokenInput = {
  body: string;
  commitId: string;
  path: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
};

type GitHubCommentAuthorPayload = {
  id?: number | null;
  login: string;
  node_id?: string | null;
  avatar_url: string;
} | null;

/**
 * Normalize optional GitHub REST author payloads into the app's stable comment
 * author shape.
 */
export function mapGitHubCommentAuthor(
  user: GitHubCommentAuthorPayload
): GitHubCommentAuthor | null {
  if (!user) {
    return null;
  }

  return {
    id: user.id ?? null,
    login: user.login,
    node_id: user.node_id ?? null,
    avatar_url: user.avatar_url,
  };
}

/**
 * Normalize a GitHub issue comment from the PR conversation tab.
 */
export function mapPullRequestIssueComment(comment: {
  id: number;
  node_id?: string | null;
  user: GitHubCommentAuthorPayload;
  body?: string | null;
  author_association?: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}): GitHubPullRequestIssueComment {
  return {
    id: comment.id,
    node_id: comment.node_id ?? null,
    user: mapGitHubCommentAuthor(comment.user),
    body: comment.body ?? "",
    author_association: comment.author_association ?? null,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: comment.html_url,
    deleted_at: null,
    is_deleted: false,
    is_updated: comment.updated_at !== comment.created_at,
  };
}

/**
 * Normalize a GitHub inline review comment and attach its review-thread node id
 * when GraphQL lookup data is available.
 */
export function mapPullRequestReviewComment(
  comment: {
    id: number;
    node_id?: string | null;
    path: string;
    line?: number | null;
    side?: string | null;
    start_line?: number | null;
    start_side?: string | null;
    original_line?: number | null;
    original_start_line?: number | null;
    body: string;
    user: GitHubCommentAuthorPayload;
    author_association?: string | null;
    created_at: string;
    updated_at: string;
    html_url: string;
    commit_id?: string | null;
    pull_request_review_id?: number | null;
    in_reply_to_id?: number | null;
  },
  reviewThreadNodeId: string | null = null,
  reviewThreadIsResolved: boolean | null = null
): GitHubPullRequestReviewComment {
  return {
    id: comment.id,
    node_id: comment.node_id ?? null,
    path: comment.path,
    line: comment.line ?? comment.original_line ?? null,
    side: comment.side ?? null,
    start_line: comment.start_line ?? null,
    start_side: comment.start_side ?? null,
    original_line: comment.original_line ?? null,
    original_start_line: comment.original_start_line ?? null,
    body: comment.body,
    user: mapGitHubCommentAuthor(comment.user),
    author_association: comment.author_association ?? null,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: comment.html_url,
    commit_id: comment.commit_id ?? null,
    pull_request_review_id: comment.pull_request_review_id ?? null,
    review_thread_node_id: reviewThreadNodeId,
    review_thread_is_resolved: reviewThreadIsResolved,
    in_reply_to_id: comment.in_reply_to_id ?? null,
    deleted_at: null,
    is_deleted: false,
    is_updated: comment.updated_at !== comment.created_at,
  };
}
