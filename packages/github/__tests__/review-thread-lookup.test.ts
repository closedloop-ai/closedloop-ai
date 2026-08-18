import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchReviewThreadNodeIdByCommentId,
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

describe("fetchReviewThreadNodeIdByCommentId", () => {
  it("returns null when GraphQL lookup fails", async () => {
    const octokit = {
      graphql: vi.fn().mockRejectedValue(new Error("graphql unavailable")),
    };

    await expect(
      fetchReviewThreadNodeIdByCommentId(octokit, "acme", "repo", 12, 345)
    ).resolves.toBeNull();
  });

  it("uses the shared route-time metadata page cap", async () => {
    const octokit = {
      graphql: vi.fn().mockImplementation(() =>
        Promise.resolve({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: true, endCursor: "next" },
                nodes: [],
              },
            },
          },
        })
      ),
    };

    await expect(
      fetchReviewThreadNodeIdByCommentId(octokit, "acme", "repo", 12, 345)
    ).resolves.toBeNull();
    expect(octokit.graphql).toHaveBeenCalledTimes(MAX_PR_METADATA_PAGES);
  });
});

describe("fetchReviewThreadResolutionByNodeId", () => {
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
