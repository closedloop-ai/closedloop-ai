import { parseError } from "@repo/observability/error";

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
 * id with the caller's client. Client acquisition AND the GraphQL read are
 * bounded together by a deadline below the webhook route timeout, so transient
 * provider delay becomes a retryable delivery instead of a blown route budget.
 *
 * Callers pass the client itself when they already hold one, or the unawaited
 * promise from their own credential resolution when they do not — the promise
 * is awaited inside the raced operation, which is what keeps a slow token
 * exchange under the same deadline as the read.
 */
export async function fetchReviewThreadResolutionByNodeId(
  octokit: GraphqlClient | Promise<GraphqlClient>,
  reviewThreadNodeId: string
): Promise<ReviewThreadResolutionResult> {
  const controller = new AbortController();
  const operation = fetchReviewThreadResolutionWithSignal(
    octokit,
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
  octokit: GraphqlClient | Promise<GraphqlClient>,
  reviewThreadNodeId: string,
  signal: AbortSignal
): Promise<ReviewThreadResolutionResult> {
  const client = await octokit;
  const response = await client.graphql<ReviewThreadResolutionResponse>(
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
  const { metadataByCommentId } = await readReviewThreadMetadata(
    octokit,
    owner,
    repo,
    pullNumber,
    { maxPagesPerConnection: maxPages, maxRequests: Number.POSITIVE_INFINITY }
  );
  return metadataByCommentId;
}

async function fetchRemainingThreadCommentPages(
  octokit: GraphqlClient,
  threadIdsByCommentId: Map<number, { id: string; isResolved: boolean }>,
  thread: ReviewThreadNode,
  maxPages: number,
  budget: ReviewThreadRequestBudget
): Promise<boolean> {
  let cursor = thread.comments.pageInfo.endCursor;

  for (
    let page = 2;
    page <= maxPages &&
    thread.comments.pageInfo.hasNextPage &&
    budget.remainingRequests > 0;
    page++
  ) {
    budget.remainingRequests -= 1;
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
      return false;
    }
    recordThreadCommentIds(threadIdsByCommentId, thread, comments);
    thread.comments = comments;
    cursor = comments.pageInfo.endCursor;
  }
  return !thread.comments.pageInfo.hasNextPage;
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
 * `fetchReviewThreadMetadataByCommentId` plus whether the read reached the last
 * thread page and every thread's last comment page within `bounds`.
 */
export async function readReviewThreadMetadata(
  octokit: GraphqlClient,
  owner: string,
  repo: string,
  pullNumber: number,
  bounds: ReviewThreadReadBounds
): Promise<ReviewThreadMetadataRead> {
  const threadIdsByCommentId = new Map<
    number,
    { id: string; isResolved: boolean }
  >();
  const budget: ReviewThreadRequestBudget = {
    remainingRequests: bounds.maxRequests,
  };
  let threadCommentsComplete = true;
  let cursor: string | null = null;

  for (
    let page = 1;
    page <= bounds.maxPagesPerConnection && budget.remainingRequests > 0;
    page++
  ) {
    budget.remainingRequests -= 1;
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
      const threadComplete = await fetchRemainingThreadCommentPages(
        octokit,
        threadIdsByCommentId,
        thread,
        bounds.maxPagesPerConnection,
        budget
      );
      threadCommentsComplete &&= threadComplete;
    }

    if (!reviewThreads?.pageInfo.hasNextPage) {
      return {
        metadataByCommentId: threadIdsByCommentId,
        complete: reviewThreads !== null && threadCommentsComplete,
      };
    }
    cursor = reviewThreads.pageInfo.endCursor;
  }

  return { metadataByCommentId: threadIdsByCommentId, complete: false };
}

export type ReviewThreadMetadataRead = {
  metadataByCommentId: Map<number, { id: string; isResolved: boolean }>;
  complete: boolean;
};

/**
 * `maxPagesPerConnection` caps the thread pages and, separately, each thread's
 * comment pages; `maxRequests` caps every GraphQL request of the read.
 */
export type ReviewThreadReadBounds = {
  maxPagesPerConnection: number;
  maxRequests: number;
};

type ReviewThreadRequestBudget = { remainingRequests: number };
