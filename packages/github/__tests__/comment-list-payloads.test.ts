import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import type { Octokit } from "@octokit/rest";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
  listPullRequestIssueCommentsWithProviderResult,
  listPullRequestReviewCommentsWithProviderResult,
  listPullRequestReviewsWithProviderResult,
} from "../index";

const OWNER = "acme";
const REPO = "repo";
const PULL_NUMBER = 12;

// The list functions are credential-agnostic (PLN-1525 step 4): callers inject
// the Octokit, so the tests do too — no App env, no auth mocking.
const mockGraphql = vi.fn();
const mockListIssueComments = vi.fn();
const mockListReviewComments = vi.fn();
const mockListReviews = vi.fn();

const octokit = {
  issues: { listComments: mockListIssueComments },
  pulls: {
    listReviewComments: mockListReviewComments,
    listReviews: mockListReviews,
  },
  graphql: mockGraphql,
} as unknown as Octokit;

describe("GitHub comment list payload mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGraphql.mockResolvedValue({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PRRT_kwDOThread",
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ databaseId: 222 }],
                },
              },
            ],
          },
        },
      },
    });
  });

  it("exposes nullable authors and metadata for issue comments", async () => {
    mockListIssueComments.mockResolvedValueOnce({
      data: [
        makeIssueComment({
          id: 111,
          node_id: "IC_kwDONode",
          user: null,
          body: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        }),
      ],
    });

    const result = await listPullRequestIssueCommentsWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(mockListIssueComments).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      issue_number: PULL_NUMBER,
      per_page: 100,
      page: 1,
    });
    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    expect(unwrapSuccess(result)).toEqual([
      {
        id: 111,
        node_id: "IC_kwDONode",
        user: null,
        body: "",
        author_association: "CONTRIBUTOR",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        html_url: "https://github.com/acme/repo/pull/12#issuecomment-111",
        deleted_at: null,
        is_deleted: false,
        is_updated: true,
      },
    ]);
  });

  it("retains actor type for issue-comment authors", async () => {
    mockListIssueComments.mockResolvedValueOnce({
      data: [
        makeIssueComment({
          user: {
            id: 99,
            login: "octocat",
            node_id: "U_kwDOExample",
            avatar_url: "https://avatars.githubusercontent.com/u/99",
            type: GitHubActorType.User,
          },
        }),
      ],
    });

    const result = await listPullRequestIssueCommentsWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(unwrapSuccess(result)[0]?.user).toMatchObject({
      login: "octocat",
      actorType: GitHubActorType.User,
    });
  });

  it("normalizes omitted issue-comment author and comment fields", async () => {
    mockListIssueComments.mockResolvedValueOnce({
      data: [
        makeIssueComment({
          node_id: undefined,
          user: {
            login: "octocat",
            avatar_url: "https://avatars.githubusercontent.com/u/99",
          },
          body: undefined,
          author_association: undefined,
        }),
      ],
    });

    const result = await listPullRequestIssueCommentsWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(unwrapSuccess(result)[0]).toMatchObject({
      node_id: null,
      user: {
        id: null,
        login: "octocat",
        node_id: null,
        avatar_url: "https://avatars.githubusercontent.com/u/99",
      },
      body: "",
      author_association: null,
      is_updated: false,
    });
    expect(unwrapSuccess(result)[0]?.user).not.toHaveProperty("actorType");
  });

  it("exposes author ids, review metadata, thread ids, and update markers", async () => {
    mockListReviewComments.mockResolvedValueOnce({
      data: [
        makeReviewComment({
          id: 222,
          node_id: "PRRC_kwDONode",
          user: {
            id: 99,
            login: "octocat",
            node_id: "U_kwDONode",
            avatar_url: "https://avatars.githubusercontent.com/u/99",
            type: GitHubActorType.Bot,
          },
          line: null,
          original_line: 30,
          start_line: 24,
          start_side: "RIGHT",
          original_start_line: 25,
          updated_at: "2026-01-02T00:00:00Z",
        }),
      ],
    });

    const result = await listPullRequestReviewCommentsWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(mockListReviewComments).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: PULL_NUMBER,
      per_page: 100,
      page: 1,
    });
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("reviewThreads"),
      {
        owner: OWNER,
        repo: REPO,
        pullNumber: PULL_NUMBER,
        cursor: null,
      }
    );
    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    expect(unwrapSuccess(result)).toEqual([
      {
        id: 222,
        node_id: "PRRC_kwDONode",
        path: "src/index.ts",
        line: 30,
        side: "RIGHT",
        start_line: 24,
        start_side: "RIGHT",
        original_line: 30,
        original_start_line: 25,
        body: "review body",
        user: {
          id: 99,
          login: "octocat",
          node_id: "U_kwDONode",
          avatar_url: "https://avatars.githubusercontent.com/u/99",
          actorType: GitHubActorType.Bot,
        },
        author_association: "MEMBER",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        html_url: "https://github.com/acme/repo/pull/12#discussion_r222",
        commit_id: "abc123",
        pull_request_review_id: 456,
        review_thread_is_resolved: null,
        review_thread_node_id: "PRRT_kwDOThread",
        in_reply_to_id: 111,
        deleted_at: null,
        is_deleted: false,
        is_updated: true,
      },
    ]);
  });

  it("retains actor type for review-body authors without changing the request", async () => {
    mockListReviews.mockResolvedValueOnce({
      data: [
        {
          id: 333,
          user: {
            id: 88,
            login: "acme",
            node_id: "O_kwDOExample",
            avatar_url: "https://avatars.githubusercontent.com/u/88",
            type: GitHubActorType.Organization,
          },
          state: "COMMENTED",
          body: "review body",
          submitted_at: "2026-01-01T00:00:00Z",
          html_url:
            "https://github.com/acme/repo/pull/12#pullrequestreview-333",
        },
      ],
    });

    const result = await listPullRequestReviewsWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(mockListReviews).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: PULL_NUMBER,
      per_page: 100,
      page: 1,
    });
    expect(unwrapSuccess(result)[0]?.user).toEqual({
      login: "acme",
      avatar_url: "https://avatars.githubusercontent.com/u/88",
      actorType: GitHubActorType.Organization,
    });
  });

  it("omits actor type for review-body authors when the provider omits it", async () => {
    mockListReviews.mockResolvedValueOnce({
      data: [
        {
          id: 333,
          user: {
            login: "octocat",
            avatar_url: "https://avatars.githubusercontent.com/u/99",
          },
          state: "COMMENTED",
          body: null,
          submitted_at: null,
          html_url:
            "https://github.com/acme/repo/pull/12#pullrequestreview-333",
        },
      ],
    });

    const result = await listPullRequestReviewsWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(unwrapSuccess(result)[0]?.user).toEqual({
      login: "octocat",
      avatar_url: "https://avatars.githubusercontent.com/u/99",
    });
  });

  it("normalizes omitted optional inline-review fields", async () => {
    mockListReviewComments.mockResolvedValueOnce({
      data: [
        makeReviewComment({
          id: 444,
          node_id: undefined,
          line: undefined,
          side: undefined,
          start_line: undefined,
          start_side: undefined,
          original_line: undefined,
          original_start_line: undefined,
          author_association: undefined,
          commit_id: undefined,
          pull_request_review_id: undefined,
          in_reply_to_id: undefined,
        }),
      ],
    });

    const result = await listPullRequestReviewCommentsWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(unwrapSuccess(result)[0]).toMatchObject({
      id: 444,
      node_id: null,
      line: null,
      side: null,
      start_line: null,
      start_side: null,
      original_line: null,
      original_start_line: null,
      author_association: null,
      commit_id: null,
      pull_request_review_id: null,
      review_thread_node_id: null,
      review_thread_is_resolved: null,
      in_reply_to_id: null,
      is_updated: false,
    });
  });

  it("paginates nested review-thread comments past the first GraphQL page", async () => {
    mockGraphql
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "PRRT_kwDOPaginatedThread",
                  isResolved: false,
                  comments: {
                    pageInfo: { hasNextPage: true, endCursor: "cursor-100" },
                    nodes: [{ databaseId: 222 }],
                  },
                },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        node: {
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ databaseId: 333 }],
          },
        },
      });
    mockListReviewComments.mockResolvedValueOnce({
      data: [makeReviewComment({ id: 333 })],
    });

    const result = await listPullRequestReviewCommentsWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(mockGraphql).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("PullRequestReviewThreadMoreCommentIds"),
      {
        threadId: "PRRT_kwDOPaginatedThread",
        cursor: "cursor-100",
      }
    );
    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    expect(unwrapSuccess(result)[0]?.review_thread_node_id).toBe(
      "PRRT_kwDOPaginatedThread"
    );
  });
});

function makeIssueComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 111,
    node_id: "IC_kwDOExample",
    user: {
      id: 99,
      login: "octocat",
      node_id: "U_kwDOExample",
      avatar_url: "https://avatars.githubusercontent.com/u/99",
    },
    body: "issue body",
    author_association: "CONTRIBUTOR",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/acme/repo/pull/12#issuecomment-111",
    ...overrides,
  };
}

function makeReviewComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 222,
    node_id: "PRRC_kwDOExample",
    path: "src/index.ts",
    line: 20,
    side: "RIGHT",
    start_line: null,
    start_side: null,
    original_line: 20,
    original_start_line: null,
    body: "review body",
    user: null,
    author_association: "MEMBER",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/acme/repo/pull/12#discussion_r222",
    commit_id: "abc123",
    pull_request_review_id: 456,
    in_reply_to_id: 111,
    ...overrides,
  };
}

function unwrapSuccess<T>(result: GitHubProviderResult<T>): T {
  if (result.status !== GitHubProviderResultStatus.Success) {
    throw new Error(`expected success provider result, got ${result.status}`);
  }
  return result.value;
}
