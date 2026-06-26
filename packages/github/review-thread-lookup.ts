import { parseError } from "@repo/observability/error";
import { getInstallationOctokit } from "./installation-auth";

type GraphqlClient = {
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
};

export const MAX_PR_METADATA_PAGES = 5;
export const REVIEW_THREAD_CONFIRMATION_TIMEOUT_MS = 5000;

type ReviewThreadLookupResponse = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: ReviewThreadNode[] | null;
      };
    } | null;
  } | null;
};

type ReviewThreadNode = {
  id: string;
  isResolved: boolean;
  comments: ReviewThreadCommentsConnection;
};

type ReviewThreadCommentsConnection = {
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  nodes: Array<{
    databaseId: number | null;
  }>;
};

type ReviewThreadCommentsResponse = {
  node: {
    comments: ReviewThreadCommentsConnection;
  } | null;
};

type ReviewThreadResolutionResponse = {
  node:
    | {
        __typename: "PullRequestReviewThread";
        isResolved: boolean;
      }
    | {
        __typename: string;
      }
    | null;
};

export const ReviewThreadResolutionResultStatus = {
  Ok: "ok",
  Terminal: "terminal",
  RetryableError: "retryable_error",
} as const;

export type ReviewThreadResolutionResultStatus =
  (typeof ReviewThreadResolutionResultStatus)[keyof typeof ReviewThreadResolutionResultStatus];

export const ReviewThreadResolutionTerminalReason = {
  NotFound: "not_found",
  TypeMismatch: "type_mismatch",
} as const;

export type ReviewThreadResolutionTerminalReason =
  (typeof ReviewThreadResolutionTerminalReason)[keyof typeof ReviewThreadResolutionTerminalReason];

export const ReviewThreadResolutionRetryableReason = {
  RateLimited: "rate_limited",
  ProviderUnavailable: "provider_unavailable",
  Timeout: "timeout",
  GraphqlError: "graphql_error",
} as const;

export type ReviewThreadResolutionRetryableReason =
  (typeof ReviewThreadResolutionRetryableReason)[keyof typeof ReviewThreadResolutionRetryableReason];

export type ReviewThreadResolutionResult =
  | {
      status: typeof ReviewThreadResolutionResultStatus.Ok;
      isResolved: boolean;
    }
  | {
      status: typeof ReviewThreadResolutionResultStatus.Terminal;
      reason: ReviewThreadResolutionTerminalReason;
    }
  | {
      status: typeof ReviewThreadResolutionResultStatus.RetryableError;
      reason: ReviewThreadResolutionRetryableReason;
      message?: string;
    };

/**
 * Confirms the current GitHub provider state for one PR review thread by node
 * id using installation auth. Installation auth and GraphQL are bounded by the
 * same deadline below the webhook route timeout so transient provider delay
 * becomes a retryable delivery.
 */
export async function fetchReviewThreadResolutionByNodeId(
  installationId: string,
  reviewThreadNodeId: string
): Promise<ReviewThreadResolutionResult> {
  const controller = new AbortController();
  const operation = fetchReviewThreadResolutionWithSignal(
    installationId,
    reviewThreadNodeId,
    controller.signal
  );

  try {
    return await withReviewThreadConfirmationTimeout(operation, controller);
  } catch (error) {
    return {
      status: ReviewThreadResolutionResultStatus.RetryableError,
      reason: classifyReviewThreadLookupError(error),
      message: parseError(error),
    };
  }
}

async function fetchReviewThreadResolutionWithSignal(
  installationId: string,
  reviewThreadNodeId: string,
  signal: AbortSignal
): Promise<ReviewThreadResolutionResult> {
  const octokit = await getInstallationOctokit(installationId);
  const response = await octokit.graphql<ReviewThreadResolutionResponse>(
    `
      query PullRequestReviewThreadResolution($threadId: ID!) {
        node(id: $threadId) {
          __typename
          ... on PullRequestReviewThread {
            isResolved
          }
        }
      }
    `,
    { threadId: reviewThreadNodeId, request: { signal } }
  );

  if (!response.node) {
    return {
      status: ReviewThreadResolutionResultStatus.Terminal,
      reason: ReviewThreadResolutionTerminalReason.NotFound,
    };
  }
  if (response.node.__typename !== "PullRequestReviewThread") {
    return {
      status: ReviewThreadResolutionResultStatus.Terminal,
      reason: ReviewThreadResolutionTerminalReason.TypeMismatch,
    };
  }
  const isResolved = Reflect.get(response.node, "isResolved");
  if (typeof isResolved !== "boolean") {
    return {
      status: ReviewThreadResolutionResultStatus.Terminal,
      reason: ReviewThreadResolutionTerminalReason.TypeMismatch,
    };
  }
  return {
    status: ReviewThreadResolutionResultStatus.Ok,
    isResolved,
  };
}

function withReviewThreadConfirmationTimeout<T>(
  operation: Promise<T>,
  controller: AbortController
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      controller.abort();
      reject(createReviewThreadConfirmationTimeoutError());
    }, REVIEW_THREAD_CONFIRMATION_TIMEOUT_MS);

    operation.then(resolve, reject).finally(() => {
      clearTimeout(timeout);
    });
  });
}

function createReviewThreadConfirmationTimeoutError(): Error {
  const error = new Error("GitHub review-thread confirmation timed out");
  error.name = "AbortError";
  return error;
}

function classifyReviewThreadLookupError(
  error: unknown
): ReviewThreadResolutionRetryableReason {
  if (error instanceof Error && error.name === "AbortError") {
    return ReviewThreadResolutionRetryableReason.Timeout;
  }

  const status = githubErrorStatus(error);
  if (status === 403 || status === 429) {
    return ReviewThreadResolutionRetryableReason.RateLimited;
  }
  if (typeof status === "number" && status >= 500) {
    return ReviewThreadResolutionRetryableReason.ProviderUnavailable;
  }
  return ReviewThreadResolutionRetryableReason.GraphqlError;
}

function githubErrorStatus(error: unknown): number | null {
  if (!(error && typeof error === "object")) {
    return null;
  }
  const status = Reflect.get(error, "status");
  return typeof status === "number" ? status : null;
}

/**
 * Looks up GitHub review-thread node ids for REST review-comment database ids.
 * Both thread pages and per-thread comment pages are paginated so replies past
 * the first nested GraphQL page can still be resolved later.
 */
export async function fetchReviewThreadNodeIdsByCommentId(
  octokit: GraphqlClient,
  owner: string,
  repo: string,
  pullNumber: number,
  maxPages: number
): Promise<Map<number, string>> {
  const metadataByCommentId = await fetchReviewThreadMetadataByCommentId(
    octokit,
    owner,
    repo,
    pullNumber,
    maxPages
  );
  return new Map(
    [...metadataByCommentId.entries()].map(([commentId, metadata]) => [
      commentId,
      metadata.id,
    ])
  );
}

/**
 * Looks up GitHub review-thread ids and resolved state for REST review-comment
 * database ids so Branch View can reconcile local state to GitHub thread truth.
 */
export async function fetchReviewThreadMetadataByCommentId(
  octokit: GraphqlClient,
  owner: string,
  repo: string,
  pullNumber: number,
  maxPages: number
): Promise<Map<number, { id: string; isResolved: boolean }>> {
  const threadIdsByCommentId = new Map<
    number,
    { id: string; isResolved: boolean }
  >();
  let cursor: string | null = null;

  for (let page = 1; page <= maxPages; page++) {
    const response: ReviewThreadLookupResponse =
      await octokit.graphql<ReviewThreadLookupResponse>(
        `
        query PullRequestReviewThreadCommentIds(
          $owner: String!
          $repo: String!
          $pullNumber: Int!
          $cursor: String
        ) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $pullNumber) {
              reviewThreads(first: 100, after: $cursor) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  id
                  isResolved
                  comments(first: 100) {
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                    nodes {
                      databaseId
                    }
                  }
                }
              }
            }
          }
        }
      `,
        { owner, repo, pullNumber, cursor }
      );

    const reviewThreads =
      response.repository?.pullRequest?.reviewThreads ?? null;
    for (const thread of reviewThreads?.nodes ?? []) {
      recordThreadCommentIds(threadIdsByCommentId, thread, thread.comments);
      await fetchRemainingThreadCommentPages(
        octokit,
        threadIdsByCommentId,
        thread,
        maxPages
      );
    }

    if (!reviewThreads?.pageInfo.hasNextPage) {
      break;
    }
    cursor = reviewThreads.pageInfo.endCursor;
  }

  return threadIdsByCommentId;
}

async function fetchRemainingThreadCommentPages(
  octokit: GraphqlClient,
  threadIdsByCommentId: Map<number, { id: string; isResolved: boolean }>,
  thread: ReviewThreadNode,
  maxPages: number
): Promise<void> {
  let cursor = thread.comments.pageInfo.endCursor;

  for (
    let page = 2;
    page <= maxPages && thread.comments.pageInfo.hasNextPage;
    page++
  ) {
    const response = await octokit.graphql<ReviewThreadCommentsResponse>(
      `
      query PullRequestReviewThreadMoreCommentIds(
        $threadId: ID!
        $cursor: String
      ) {
        node(id: $threadId) {
          ... on PullRequestReviewThread {
            comments(first: 100, after: $cursor) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                databaseId
              }
            }
          }
        }
      }
    `,
      { threadId: thread.id, cursor }
    );

    const comments = response.node?.comments;
    if (!comments) {
      return;
    }
    recordThreadCommentIds(threadIdsByCommentId, thread, comments);
    thread.comments = comments;
    cursor = comments.pageInfo.endCursor;
  }
}

function recordThreadCommentIds(
  threadIdsByCommentId: Map<number, { id: string; isResolved: boolean }>,
  thread: ReviewThreadNode,
  comments: ReviewThreadCommentsConnection
) {
  for (const comment of comments.nodes) {
    if (typeof comment.databaseId === "number") {
      threadIdsByCommentId.set(comment.databaseId, {
        id: thread.id,
        isResolved: thread.isResolved,
      });
    }
  }
}

/**
 * Resolve a single review-thread node id for a REST review-comment database id.
 * Lookup failures and pagination-cap misses intentionally return null so
 * route-time comment writes do not retry or convert a successful REST write
 * into a provider failure.
 */
export async function fetchReviewThreadNodeIdByCommentId(
  octokit: GraphqlClient,
  owner: string,
  repo: string,
  pullNumber: number,
  commentId: number
): Promise<string | null> {
  try {
    const threadIdsByCommentId = await fetchReviewThreadNodeIdsByCommentId(
      octokit,
      owner,
      repo,
      pullNumber,
      MAX_PR_METADATA_PAGES
    );
    return threadIdsByCommentId.get(commentId) ?? null;
  } catch {
    return null;
  }
}
