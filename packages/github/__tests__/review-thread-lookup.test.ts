import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetInstallationOctokit } = vi.hoisted(() => ({
  mockGetInstallationOctokit: vi.fn(),
}));

vi.mock("../installation-auth", () => ({
  getInstallationOctokit: mockGetInstallationOctokit,
}));

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
    const graphql = vi.fn().mockResolvedValue({
      node: { __typename: "PullRequestReviewThread", isResolved: true },
    });
    mockGetInstallationOctokit.mockResolvedValue({ graphql });

    await expect(
      fetchReviewThreadResolutionByNodeId("123", "PRRT_node")
    ).resolves.toEqual({
      status: ReviewThreadResolutionResultStatus.Ok,
      isResolved: true,
    });
    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining("PullRequestReviewThreadResolution"),
      expect.objectContaining({
        threadId: "PRRT_node",
        request: { signal: expect.any(AbortSignal) },
      })
    );
  });

  it("returns unresolved provider state for a review-thread node", async () => {
    const graphql = vi.fn().mockResolvedValue({
      node: { __typename: "PullRequestReviewThread", isResolved: false },
    });
    mockGetInstallationOctokit.mockResolvedValue({ graphql });

    await expect(
      fetchReviewThreadResolutionByNodeId("123", "PRRT_node")
    ).resolves.toEqual({
      status: ReviewThreadResolutionResultStatus.Ok,
      isResolved: false,
    });
  });

  it("classifies missing and wrong node types as terminal", async () => {
    const graphql = vi.fn().mockResolvedValue({
      node: { __typename: "IssueComment" },
    });
    mockGetInstallationOctokit.mockResolvedValue({ graphql });

    await expect(
      fetchReviewThreadResolutionByNodeId("123", "wrong_node")
    ).resolves.toEqual({
      status: ReviewThreadResolutionResultStatus.Terminal,
      reason: ReviewThreadResolutionTerminalReason.TypeMismatch,
    });

    graphql.mockResolvedValueOnce({ node: null });
    await expect(
      fetchReviewThreadResolutionByNodeId("123", "missing_node")
    ).resolves.toEqual({
      status: ReviewThreadResolutionResultStatus.Terminal,
      reason: ReviewThreadResolutionTerminalReason.NotFound,
    });
  });

  it("uses the fixed route-timeout guard and classifies abort as retryable", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const graphql = vi.fn().mockRejectedValue(abortError);
    mockGetInstallationOctokit.mockResolvedValue({ graphql });

    expect(REVIEW_THREAD_CONFIRMATION_TIMEOUT_MS).toBe(5000);
    await expect(
      fetchReviewThreadResolutionByNodeId("123", "PRRT_node")
    ).resolves.toMatchObject({
      status: ReviewThreadResolutionResultStatus.RetryableError,
      reason: ReviewThreadResolutionRetryableReason.Timeout,
    });
  });

  it("bounds installation auth under the fixed provider confirmation timeout", async () => {
    vi.useFakeTimers();
    mockGetInstallationOctokit.mockReturnValue(new Promise(() => {}));

    const result = fetchReviewThreadResolutionByNodeId("123", "PRRT_node");

    expect(REVIEW_THREAD_CONFIRMATION_TIMEOUT_MS).toBe(5000);
    await vi.advanceTimersByTimeAsync(REVIEW_THREAD_CONFIRMATION_TIMEOUT_MS);
    await expect(result).resolves.toMatchObject({
      status: ReviewThreadResolutionResultStatus.RetryableError,
      reason: ReviewThreadResolutionRetryableReason.Timeout,
    });
  });

  it.each([
    [
      "rate limited installation auth",
      Object.assign(new Error("rate limited"), { status: 429 }),
      ReviewThreadResolutionRetryableReason.RateLimited,
    ],
    [
      "GitHub 5xx installation auth",
      Object.assign(new Error("bad gateway"), { status: 502 }),
      ReviewThreadResolutionRetryableReason.ProviderUnavailable,
    ],
    [
      "network installation auth",
      new Error("network unavailable"),
      ReviewThreadResolutionRetryableReason.GraphqlError,
    ],
  ])("classifies %s as retryable before GraphQL", async (_name, error, reason) => {
    mockGetInstallationOctokit.mockRejectedValue(error);

    await expect(
      fetchReviewThreadResolutionByNodeId("123", "PRRT_node")
    ).resolves.toMatchObject({
      status: ReviewThreadResolutionResultStatus.RetryableError,
      reason,
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
    const graphql = vi.fn().mockRejectedValue(error);
    mockGetInstallationOctokit.mockResolvedValue({ graphql });

    await expect(
      fetchReviewThreadResolutionByNodeId("123", "PRRT_node")
    ).resolves.toMatchObject({
      status: ReviewThreadResolutionResultStatus.RetryableError,
      reason,
    });
  });
});
