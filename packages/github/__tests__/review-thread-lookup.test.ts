import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchReviewThreadMetadataByCommentId,
  fetchReviewThreadResolutionByNodeId,
  MAX_PR_METADATA_PAGES,
  REVIEW_THREAD_CONFIRMATION_TIMEOUT_MS,
  ReviewThreadResolutionResultStatus,
  ReviewThreadResolutionRetryableReason,
  ReviewThreadResolutionTerminalReason,
} from "../review-thread-lookup";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

function threadsPage(
  nodes: unknown[] | null,
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
) {
  return {
    repository: { pullRequest: { reviewThreads: { pageInfo, nodes } } },
  };
}

function commentsConnection(
  databaseIds: Array<number | null>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
) {
  return {
    pageInfo,
    nodes: databaseIds.map((databaseId) => ({ databaseId })),
  };
}

const NO_NEXT_PAGE = { hasNextPage: false, endCursor: null };

describe("fetchReviewThreadMetadataByCommentId", () => {
  it("maps comment ids to their thread, skipping comments without a numeric database id", async () => {
    const octokit = {
      graphql: vi.fn().mockResolvedValue(
        threadsPage(
          [
            {
              id: "PRRT_a",
              isResolved: true,
              comments: commentsConnection([1, null], NO_NEXT_PAGE),
            },
            {
              id: "PRRT_b",
              isResolved: false,
              comments: commentsConnection([2], NO_NEXT_PAGE),
            },
          ],
          NO_NEXT_PAGE
        )
      ),
    };

    const result = await fetchReviewThreadMetadataByCommentId(
      octokit,
      "acme",
      "repo",
      12,
      MAX_PR_METADATA_PAGES
    );

    expect([...result.entries()]).toEqual([
      [1, { id: "PRRT_a", isResolved: true }],
      [2, { id: "PRRT_b", isResolved: false }],
    ]);
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });

  it("follows the thread cursor until hasNextPage is false", async () => {
    const octokit = {
      graphql: vi
        .fn()
        .mockResolvedValueOnce(
          threadsPage(
            [
              {
                id: "PRRT_a",
                isResolved: false,
                comments: commentsConnection([1], NO_NEXT_PAGE),
              },
            ],
            { hasNextPage: true, endCursor: "cursor-1" }
          )
        )
        .mockResolvedValueOnce(
          threadsPage(
            [
              {
                id: "PRRT_b",
                isResolved: true,
                comments: commentsConnection([2], NO_NEXT_PAGE),
              },
            ],
            NO_NEXT_PAGE
          )
        ),
    };

    const result = await fetchReviewThreadMetadataByCommentId(
      octokit,
      "acme",
      "repo",
      12,
      MAX_PR_METADATA_PAGES
    );

    expect(octokit.graphql).toHaveBeenCalledTimes(2);
    expect(octokit.graphql.mock.calls[0]?.[1]).toEqual({
      owner: "acme",
      repo: "repo",
      pullNumber: 12,
      cursor: null,
    });
    expect(octokit.graphql.mock.calls[1]?.[1]).toMatchObject({
      cursor: "cursor-1",
    });
    expect(result.get(1)).toEqual({ id: "PRRT_a", isResolved: false });
    expect(result.get(2)).toEqual({ id: "PRRT_b", isResolved: true });
  });

  it("returns an empty map after one call when the repository or pull request is missing", async () => {
    const octokit = {
      graphql: vi.fn().mockResolvedValue({ repository: { pullRequest: null } }),
    };

    const result = await fetchReviewThreadMetadataByCommentId(
      octokit,
      "acme",
      "repo",
      12,
      MAX_PR_METADATA_PAGES
    );

    expect(result.size).toBe(0);
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });

  it("treats a null thread node list as empty and stops without hasNextPage", async () => {
    const octokit = {
      graphql: vi.fn().mockResolvedValue(threadsPage(null, NO_NEXT_PAGE)),
    };

    const result = await fetchReviewThreadMetadataByCommentId(
      octokit,
      "acme",
      "repo",
      12,
      MAX_PR_METADATA_PAGES
    );

    expect(result.size).toBe(0);
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });

  it("pages a thread's remaining comments using the previous cursor", async () => {
    const octokit = {
      graphql: vi
        .fn()
        .mockResolvedValueOnce(
          threadsPage(
            [
              {
                id: "PRRT_a",
                isResolved: true,
                comments: commentsConnection([1], {
                  hasNextPage: true,
                  endCursor: "c1",
                }),
              },
            ],
            NO_NEXT_PAGE
          )
        )
        .mockResolvedValueOnce({
          node: {
            comments: commentsConnection([2], {
              hasNextPage: true,
              endCursor: "c2",
            }),
          },
        })
        .mockResolvedValueOnce({
          node: { comments: commentsConnection([3], NO_NEXT_PAGE) },
        }),
    };

    const result = await fetchReviewThreadMetadataByCommentId(
      octokit,
      "acme",
      "repo",
      12,
      MAX_PR_METADATA_PAGES
    );

    expect(octokit.graphql).toHaveBeenCalledTimes(3);
    expect(octokit.graphql.mock.calls[1]?.[1]).toEqual({
      threadId: "PRRT_a",
      cursor: "c1",
    });
    expect(octokit.graphql.mock.calls[2]?.[1]).toEqual({
      threadId: "PRRT_a",
      cursor: "c2",
    });
    expect([...result.keys()]).toEqual([1, 2, 3]);
    expect(result.get(3)).toEqual({ id: "PRRT_a", isResolved: true });
  });

  it("stops paging a thread's comments once maxPages is reached", async () => {
    const octokit = {
      graphql: vi
        .fn()
        .mockResolvedValueOnce(
          threadsPage(
            [
              {
                id: "PRRT_a",
                isResolved: false,
                comments: commentsConnection([1], {
                  hasNextPage: true,
                  endCursor: "c1",
                }),
              },
            ],
            NO_NEXT_PAGE
          )
        )
        .mockResolvedValue({
          node: {
            comments: commentsConnection([2], {
              hasNextPage: true,
              endCursor: "more",
            }),
          },
        }),
    };

    const result = await fetchReviewThreadMetadataByCommentId(
      octokit,
      "acme",
      "repo",
      12,
      2
    );

    // One threads call plus a single comments page: page 2 is the last allowed.
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
    expect([...result.keys()]).toEqual([1, 2]);
  });

  it("keeps recorded comments and stops when a thread comments page returns no node", async () => {
    const octokit = {
      graphql: vi
        .fn()
        .mockResolvedValueOnce(
          threadsPage(
            [
              {
                id: "PRRT_a",
                isResolved: false,
                comments: commentsConnection([1], {
                  hasNextPage: true,
                  endCursor: "c1",
                }),
              },
            ],
            NO_NEXT_PAGE
          )
        )
        .mockResolvedValueOnce({ node: null }),
    };

    const result = await fetchReviewThreadMetadataByCommentId(
      octokit,
      "acme",
      "repo",
      12,
      MAX_PR_METADATA_PAGES
    );

    expect(octokit.graphql).toHaveBeenCalledTimes(2);
    expect([...result.keys()]).toEqual([1]);
  });
});

describe("fetchReviewThreadResolutionByNodeId", () => {
  it("classifies a thread node whose isResolved is not a boolean as a terminal type mismatch", async () => {
    const octokit = {
      graphql: vi.fn().mockResolvedValue({
        node: { __typename: "PullRequestReviewThread", isResolved: "yes" },
      }),
    };

    await expect(
      fetchReviewThreadResolutionByNodeId(octokit, "PRRT_node")
    ).resolves.toEqual({
      status: ReviewThreadResolutionResultStatus.Terminal,
      reason: ReviewThreadResolutionTerminalReason.TypeMismatch,
    });
  });

  it("classifies a 403 as rate limited", async () => {
    const octokit = {
      graphql: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("forbidden"), { status: 403 })
        ),
    };

    await expect(
      fetchReviewThreadResolutionByNodeId(octokit, "PRRT_node")
    ).resolves.toMatchObject({
      status: ReviewThreadResolutionResultStatus.RetryableError,
      reason: ReviewThreadResolutionRetryableReason.RateLimited,
    });
  });

  it("classifies a non-object rejection as a generic GraphQL error", async () => {
    const octokit = { graphql: vi.fn().mockRejectedValue("plain failure") };

    await expect(
      fetchReviewThreadResolutionByNodeId(octokit, "PRRT_node")
    ).resolves.toMatchObject({
      status: ReviewThreadResolutionResultStatus.RetryableError,
      reason: ReviewThreadResolutionRetryableReason.GraphqlError,
    });
  });

  it("classifies an error with a non-numeric status as a generic GraphQL error", async () => {
    const octokit = {
      graphql: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("odd"), { status: "503" })),
    };

    await expect(
      fetchReviewThreadResolutionByNodeId(octokit, "PRRT_node")
    ).resolves.toMatchObject({
      status: ReviewThreadResolutionResultStatus.RetryableError,
      reason: ReviewThreadResolutionRetryableReason.GraphqlError,
    });
  });

  it("returns current provider resolution for a review-thread node", async () => {
    const octokit = {
      graphql: vi.fn().mockResolvedValue({
        node: { __typename: "PullRequestReviewThread", isResolved: true },
      }),
    };

    await expect(
      fetchReviewThreadResolutionByNodeId(octokit, "PRRT_node")
    ).resolves.toEqual({
      status: ReviewThreadResolutionResultStatus.Ok,
      isResolved: true,
    });
    expect(octokit.graphql).toHaveBeenCalledWith(
      expect.stringContaining("PullRequestReviewThreadResolution"),
      expect.objectContaining({
        threadId: "PRRT_node",
        request: { signal: expect.any(AbortSignal) },
      })
    );
  });

  it("returns unresolved provider state for a review-thread node", async () => {
    const octokit = {
      graphql: vi.fn().mockResolvedValue({
        node: { __typename: "PullRequestReviewThread", isResolved: false },
      }),
    };

    await expect(
      fetchReviewThreadResolutionByNodeId(octokit, "PRRT_node")
    ).resolves.toEqual({
      status: ReviewThreadResolutionResultStatus.Ok,
      isResolved: false,
    });
  });

  it("classifies missing and wrong node types as terminal", async () => {
    const octokit = {
      graphql: vi.fn().mockResolvedValue({
        node: { __typename: "IssueComment" },
      }),
    };

    await expect(
      fetchReviewThreadResolutionByNodeId(octokit, "wrong_node")
    ).resolves.toEqual({
      status: ReviewThreadResolutionResultStatus.Terminal,
      reason: ReviewThreadResolutionTerminalReason.TypeMismatch,
    });

    octokit.graphql.mockResolvedValueOnce({ node: null });
    await expect(
      fetchReviewThreadResolutionByNodeId(octokit, "missing_node")
    ).resolves.toEqual({
      status: ReviewThreadResolutionResultStatus.Terminal,
      reason: ReviewThreadResolutionTerminalReason.NotFound,
    });
  });

  it("uses the fixed route-timeout guard and classifies abort as retryable", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const octokit = { graphql: vi.fn().mockRejectedValue(abortError) };

    expect(REVIEW_THREAD_CONFIRMATION_TIMEOUT_MS).toBe(5000);
    await expect(
      fetchReviewThreadResolutionByNodeId(octokit, "PRRT_node")
    ).resolves.toMatchObject({
      status: ReviewThreadResolutionResultStatus.RetryableError,
      reason: ReviewThreadResolutionRetryableReason.Timeout,
    });
  });

  it("bounds a hung provider read under the fixed confirmation timeout", async () => {
    vi.useFakeTimers();
    const octokit = {
      graphql: vi.fn().mockReturnValue(new Promise(() => {})),
    };

    const result = fetchReviewThreadResolutionByNodeId(octokit, "PRRT_node");

    expect(REVIEW_THREAD_CONFIRMATION_TIMEOUT_MS).toBe(5000);
    await vi.advanceTimersByTimeAsync(REVIEW_THREAD_CONFIRMATION_TIMEOUT_MS);
    await expect(result).resolves.toMatchObject({
      status: ReviewThreadResolutionResultStatus.RetryableError,
      reason: ReviewThreadResolutionRetryableReason.Timeout,
    });
  });

  it("bounds a hung client acquisition under the same confirmation timeout", async () => {
    vi.useFakeTimers();
    const neverResolvingClient = new Promise<{ graphql: () => never }>(
      () => undefined
    );

    const result = fetchReviewThreadResolutionByNodeId(
      neverResolvingClient,
      "PRRT_node"
    );

    await vi.advanceTimersByTimeAsync(REVIEW_THREAD_CONFIRMATION_TIMEOUT_MS);
    await expect(result).resolves.toMatchObject({
      status: ReviewThreadResolutionResultStatus.RetryableError,
      reason: ReviewThreadResolutionRetryableReason.Timeout,
    });
  });

  it("classifies a failed client acquisition as retryable", async () => {
    const failedClient = Promise.reject(
      Object.assign(new Error("token exchange failed"), { status: 502 })
    );

    await expect(
      fetchReviewThreadResolutionByNodeId(failedClient, "PRRT_node")
    ).resolves.toMatchObject({
      status: ReviewThreadResolutionResultStatus.RetryableError,
      reason: ReviewThreadResolutionRetryableReason.ProviderUnavailable,
    });
  });

  it.each([
    [
      "rate limit",
      Object.assign(new Error("rate limited"), { status: 429 }),
      ReviewThreadResolutionRetryableReason.RateLimited,
    ],
    [
      "GitHub 5xx",
      Object.assign(new Error("bad gateway"), { status: 502 }),
      ReviewThreadResolutionRetryableReason.ProviderUnavailable,
    ],
    [
      "network error",
      new Error("network unavailable"),
      ReviewThreadResolutionRetryableReason.GraphqlError,
    ],
    [
      "GraphQL error",
      Object.assign(new Error("graphql errors"), {
        errors: [{ message: "x" }],
      }),
      ReviewThreadResolutionRetryableReason.GraphqlError,
    ],
  ])("classifies %s as retryable", async (_name, error, reason) => {
    const octokit = { graphql: vi.fn().mockRejectedValue(error) };

    await expect(
      fetchReviewThreadResolutionByNodeId(octokit, "PRRT_node")
    ).resolves.toMatchObject({
      status: ReviewThreadResolutionResultStatus.RetryableError,
      reason,
    });
  });
});
