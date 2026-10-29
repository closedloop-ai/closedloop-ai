import type { Octokit } from "@octokit/rest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubProviderResultStatus } from "../provider-result";
import {
  listAllPullRequestIssueComments,
  listAllPullRequestReviewComments,
  listAllPullRequestReviews,
  MAX_COMPLETE_LIST_PAGES,
  MAX_REVIEW_THREAD_METADATA_REQUESTS,
} from "../pull-request-comment-lists";
import {
  makeIssueComments,
  makeReviewComments,
  makeReviews,
  servePages,
} from "./pull-request-comment-list-fixtures";

const mockOctokit = {
  graphql: vi.fn(),
  issues: { listComments: vi.fn() },
  pulls: { listReviewComments: vi.fn(), listReviews: vi.fn() },
};
const octokit = mockOctokit as unknown as Octokit;

const OWNER = "acme";
const REPO = "repo";
const PULL_NUMBER = 42;
const PAGE_SIZE = 100;

beforeEach(() => {
  vi.resetAllMocks();
  mockOctokit.graphql.mockResolvedValue(reviewThreadsPage([], false));
});

describe("listAllPullRequestIssueComments", () => {
  it("returns every row past the first page, in order", async () => {
    mockOctokit.issues.listComments.mockImplementation(
      servePages(makeIssueComments(130))
    );

    const result = await listAllPullRequestIssueComments(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual(successList(idsThrough(130), true));
    expect(pageCalls(mockOctokit.issues.listComments)).toEqual([
      { page: 1, perPage: PAGE_SIZE },
      { page: 2, perPage: PAGE_SIZE },
      { page: 1, perPage: PAGE_SIZE },
    ]);
  });

  it("is incomplete when a row deleted between page requests shifts a live row past the read", async () => {
    const rows = makeIssueComments(101);
    mockOctokit.issues.listComments.mockImplementation(
      deleteFirstRowAfterFirstPage(rows)
    );

    const result = await listAllPullRequestIssueComments(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: {
        items: idsThrough(100).map((id) => expect.objectContaining({ id })),
        complete: false,
        shifted: true,
      },
    });
  });

  it("reads one more page to prove a list of exactly 100 rows complete", async () => {
    mockOctokit.issues.listComments.mockImplementation(
      servePages(makeIssueComments(100))
    );

    const result = await listAllPullRequestIssueComments(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual(successList(idsThrough(100), true));
    expect(mockOctokit.issues.listComments).toHaveBeenCalledTimes(3);
  });

  it("returns a list of 101 rows complete", async () => {
    mockOctokit.issues.listComments.mockImplementation(
      servePages(makeIssueComments(101))
    );

    const result = await listAllPullRequestIssueComments(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual(successList(idsThrough(101), true));
  });

  it("returns the rows it read, incomplete, when the page ceiling stops it", async () => {
    const ceilingRows = MAX_COMPLETE_LIST_PAGES * PAGE_SIZE;
    mockOctokit.issues.listComments.mockImplementation(
      servePages(makeIssueComments(ceilingRows + 1))
    );

    const result = await listAllPullRequestIssueComments(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual(successList(idsThrough(ceilingRows), false));
    expect(mockOctokit.issues.listComments).toHaveBeenCalledTimes(
      MAX_COMPLETE_LIST_PAGES
    );
  });

  it("returns a provider failure as a value", async () => {
    mockOctokit.issues.listComments.mockRejectedValue(
      Object.assign(new Error("Service Unavailable"), { status: 503 })
    );

    await expect(
      listAllPullRequestIssueComments(octokit, OWNER, REPO, PULL_NUMBER)
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
  });
});

describe("listAllPullRequestReviewComments", () => {
  it("returns every row with its review thread, complete when both reads finish", async () => {
    mockOctokit.pulls.listReviewComments.mockImplementation(
      servePages(makeReviewComments(130))
    );
    mockOctokit.graphql.mockResolvedValue(
      reviewThreadsPage([{ id: "PRRT_1", isResolved: true, commentIds: [1] }])
    );

    const result = await listAllPullRequestReviewComments(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual(successList(idsThrough(130), true));
    const items =
      result.status === GitHubProviderResultStatus.Success
        ? result.value.items
        : [];
    expect(items[0]).toMatchObject({
      id: 1,
      review_thread_node_id: "PRRT_1",
      review_thread_is_resolved: true,
    });
    expect(items[1]).toMatchObject({
      id: 2,
      review_thread_node_id: null,
      review_thread_is_resolved: null,
    });
  });

  it("is incomplete when a review comment deleted mid-read shifts the pages", async () => {
    mockOctokit.pulls.listReviewComments.mockImplementation(
      deleteFirstRowAfterFirstPage(makeReviewComments(150))
    );

    const result = await listAllPullRequestReviewComments(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: GitHubProviderResultStatus.Success,
      value: { complete: false, shifted: true },
    });
  });

  it("is incomplete when the review-thread read hits the page ceiling", async () => {
    mockOctokit.pulls.listReviewComments.mockImplementation(
      servePages(makeReviewComments(3))
    );
    mockOctokit.graphql.mockResolvedValue(reviewThreadsPage([], true));

    const result = await listAllPullRequestReviewComments(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual(successList(idsThrough(3), false));
    expect(mockOctokit.graphql).toHaveBeenCalledTimes(
      MAX_REVIEW_THREAD_METADATA_REQUESTS
    );
  });

  it("spends one request budget across thread pages and per-thread comment pages", async () => {
    mockOctokit.pulls.listReviewComments.mockImplementation(
      servePages(makeReviewComments(3))
    );
    mockOctokit.graphql.mockImplementation((query: string) =>
      Promise.resolve(
        query.includes("PullRequestReviewThreadMoreCommentIds")
          ? { node: { comments: threadComments([3], true) } }
          : reviewThreadsPage([
              {
                id: "PRRT_1",
                isResolved: false,
                commentIds: [1],
                moreComments: true,
              },
              {
                id: "PRRT_2",
                isResolved: false,
                commentIds: [2],
                moreComments: true,
              },
            ])
      )
    );

    const result = await listAllPullRequestReviewComments(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual(successList(idsThrough(3), false));
    expect(mockOctokit.graphql).toHaveBeenCalledTimes(
      MAX_REVIEW_THREAD_METADATA_REQUESTS
    );
  });

  it("is complete when the last comment page arrives on the final budgeted request", async () => {
    mockOctokit.pulls.listReviewComments.mockImplementation(
      servePages(makeReviewComments(3))
    );
    let commentPages = 0;
    mockOctokit.graphql.mockImplementation((query: string) => {
      if (!query.includes("PullRequestReviewThreadMoreCommentIds")) {
        return Promise.resolve(
          reviewThreadsPage([
            {
              id: "PRRT_1",
              isResolved: false,
              commentIds: [1],
              moreComments: true,
            },
          ])
        );
      }
      commentPages += 1;
      const hasNextPage =
        commentPages < MAX_REVIEW_THREAD_METADATA_REQUESTS - 1;
      return Promise.resolve({
        node: { comments: threadComments([commentPages + 1], hasNextPage) },
      });
    });

    const result = await listAllPullRequestReviewComments(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual(successList(idsThrough(3), true));
    expect(mockOctokit.graphql).toHaveBeenCalledTimes(
      MAX_REVIEW_THREAD_METADATA_REQUESTS
    );
  });
});

describe("listAllPullRequestReviews", () => {
  it("returns every review past the first page", async () => {
    mockOctokit.pulls.listReviews.mockImplementation(
      servePages(makeReviews(130))
    );

    const result = await listAllPullRequestReviews(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual(successList(idsThrough(130), true));
    expect(pageCalls(mockOctokit.pulls.listReviews)).toEqual([
      { page: 1, perPage: PAGE_SIZE },
      { page: 2, perPage: PAGE_SIZE },
      { page: 1, perPage: PAGE_SIZE },
    ]);
  });

  it("is incomplete when a review deleted mid-read shifts the pages", async () => {
    mockOctokit.pulls.listReviews.mockImplementation(
      deleteFirstRowAfterFirstPage(makeReviews(150))
    );

    const result = await listAllPullRequestReviews(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: GitHubProviderResultStatus.Success,
      value: { complete: false, shifted: true },
    });
  });

  it("is incomplete when the page ceiling stops it", async () => {
    mockOctokit.pulls.listReviews.mockImplementation(
      servePages(makeReviews(MAX_COMPLETE_LIST_PAGES * PAGE_SIZE + 1))
    );

    const result = await listAllPullRequestReviews(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: GitHubProviderResultStatus.Success,
      value: { complete: false },
    });
  });
});

function pageCalls(
  mock: ReturnType<typeof vi.fn>
): { page: number; perPage: number }[] {
  return mock.mock.calls.map(([params]) => ({
    page: params.page,
    perPage: params.per_page,
  }));
}

/** A list endpoint whose first row is deleted once the first page is served. */
function deleteFirstRowAfterFirstPage<T>(rows: T[]) {
  const current = [...rows];
  const serve = servePages(current);
  let served = 0;
  return async (params: { page: number; per_page: number }) => {
    const response = await serve(params);
    served += 1;
    if (served === 1) {
      current.shift();
    }
    return response;
  };
}

function idsThrough(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

function successList(ids: number[], complete: boolean) {
  return {
    status: GitHubProviderResultStatus.Success,
    value: {
      items: ids.map((id) => expect.objectContaining({ id })),
      complete,
    },
  };
}

function threadComments(commentIds: number[], hasNextPage: boolean) {
  return {
    pageInfo: { hasNextPage, endCursor: hasNextPage ? "comments-next" : null },
    nodes: commentIds.map((databaseId) => ({ databaseId })),
  };
}

function reviewThreadsPage(
  threads: Array<{
    id: string;
    isResolved: boolean;
    commentIds: number[];
    moreComments?: boolean;
  }>,
  hasNextPage = false
) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: {
            hasNextPage,
            endCursor: hasNextPage ? "threads-next" : null,
          },
          nodes: threads.map((thread) => ({
            id: thread.id,
            isResolved: thread.isResolved,
            comments: threadComments(
              thread.commentIds,
              thread.moreComments ?? false
            ),
          })),
        },
      },
    },
  };
}
