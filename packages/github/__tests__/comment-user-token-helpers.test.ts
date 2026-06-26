import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateAppAuth,
  mockCreateIssueComment,
  mockCreateReplyForReviewComment,
  mockCreateReviewComment,
  mockDeleteIssueComment,
  mockDeleteReviewComment,
  mockGraphql,
  mockOctokitConstructor,
  mockUpdateIssueComment,
  mockUpdateReviewComment,
} = vi.hoisted(() => ({
  mockCreateAppAuth: vi.fn(),
  mockCreateIssueComment: vi.fn(),
  mockCreateReplyForReviewComment: vi.fn(),
  mockCreateReviewComment: vi.fn(),
  mockDeleteIssueComment: vi.fn(),
  mockDeleteReviewComment: vi.fn(),
  mockGraphql: vi.fn(),
  mockOctokitConstructor: vi.fn(),
  mockUpdateIssueComment: vi.fn(),
  mockUpdateReviewComment: vi.fn(),
}));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: mockCreateAppAuth,
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = {
      issues: {
        createComment: mockCreateIssueComment,
        updateComment: mockUpdateIssueComment,
        deleteComment: mockDeleteIssueComment,
      },
      pulls: {
        createReviewComment: mockCreateReviewComment,
        createReplyForReviewComment: mockCreateReplyForReviewComment,
        updateReviewComment: mockUpdateReviewComment,
        deleteReviewComment: mockDeleteReviewComment,
      },
    };

    graphql = mockGraphql;

    constructor(options: unknown) {
      mockOctokitConstructor(options);
    }
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  createPullRequestIssueCommentWithUserToken,
  createPullRequestReviewCommentWithUserToken,
  createReplyForReviewCommentWithUserToken,
  deletePullRequestIssueCommentWithUserToken,
  deletePullRequestReviewCommentWithUserToken,
  resolvePullRequestReviewThreadWithUserToken,
  unresolvePullRequestReviewThreadWithUserToken,
  updatePullRequestIssueCommentWithUserToken,
  updatePullRequestReviewCommentWithUserToken,
} from "../index";

const USER_ACCESS_TOKEN = "ghu_user_token";
const OWNER = "acme";
const REPO = "repo";
const PULL_NUMBER = 12;
const COMMENT_ID = 345;
const THREAD_ID = "PRRT_kwDOExample";

describe("GitHub comment user-token helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateIssueComment.mockResolvedValue({ data: makeIssueComment() });
    mockUpdateIssueComment.mockResolvedValue({
      data: makeIssueComment({
        body: "updated issue",
        updated_at: "2026-01-02T00:00:00Z",
      }),
    });
    mockDeleteIssueComment.mockResolvedValue({ status: 204 });
    mockCreateReviewComment.mockResolvedValue({ data: makeReviewComment() });
    mockCreateReplyForReviewComment.mockResolvedValue({
      data: makeReviewComment({ id: 346, in_reply_to_id: COMMENT_ID }),
    });
    mockUpdateReviewComment.mockResolvedValue({
      data: makeReviewComment({
        body: "updated review",
        updated_at: "2026-01-02T00:00:00Z",
      }),
    });
    mockDeleteReviewComment.mockResolvedValue({ status: 204 });
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("reviewThreads")) {
        return Promise.resolve({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: THREAD_ID,
                    comments: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [{ databaseId: COMMENT_ID }, { databaseId: 346 }],
                    },
                  },
                ],
              },
            },
          },
        });
      }
      if (query.includes("unresolveReviewThread")) {
        return Promise.resolve({
          unresolveReviewThread: {
            thread: { id: THREAD_ID, isResolved: false },
          },
        });
      }
      if (query.includes("resolveReviewThread")) {
        return Promise.resolve({
          resolveReviewThread: {
            thread: { id: THREAD_ID, isResolved: true },
          },
        });
      }
      return Promise.resolve({});
    });
  });

  it("uses raw user-token Octokit instances and never creates installation auth", async () => {
    await createPullRequestIssueCommentWithUserToken(
      USER_ACCESS_TOKEN,
      OWNER,
      REPO,
      PULL_NUMBER,
      "issue body"
    );
    await updatePullRequestIssueCommentWithUserToken(
      USER_ACCESS_TOKEN,
      OWNER,
      REPO,
      COMMENT_ID,
      "updated issue"
    );
    await deletePullRequestIssueCommentWithUserToken(
      USER_ACCESS_TOKEN,
      OWNER,
      REPO,
      COMMENT_ID
    );
    await createPullRequestReviewCommentWithUserToken(
      USER_ACCESS_TOKEN,
      OWNER,
      REPO,
      PULL_NUMBER,
      {
        body: "review body",
        commitId: "abc123",
        path: "src/index.ts",
        line: 20,
        side: "RIGHT",
        startLine: 18,
        startSide: "RIGHT",
      }
    );
    await createReplyForReviewCommentWithUserToken(
      USER_ACCESS_TOKEN,
      OWNER,
      REPO,
      PULL_NUMBER,
      COMMENT_ID,
      "reply body"
    );
    await updatePullRequestReviewCommentWithUserToken(
      USER_ACCESS_TOKEN,
      OWNER,
      REPO,
      COMMENT_ID,
      "updated review"
    );
    await deletePullRequestReviewCommentWithUserToken(
      USER_ACCESS_TOKEN,
      OWNER,
      REPO,
      COMMENT_ID
    );
    await resolvePullRequestReviewThreadWithUserToken(
      USER_ACCESS_TOKEN,
      THREAD_ID
    );
    await unresolvePullRequestReviewThreadWithUserToken(
      USER_ACCESS_TOKEN,
      THREAD_ID
    );

    expect(mockCreateAppAuth).not.toHaveBeenCalled();
    expect(mockOctokitConstructor).toHaveBeenCalledTimes(9);
    for (const call of mockOctokitConstructor.mock.calls) {
      expect(call[0]).toEqual({ auth: USER_ACCESS_TOKEN });
    }
  });

  it("threads REST and GraphQL payloads through the user-token helpers", async () => {
    await createPullRequestIssueCommentWithUserToken(
      USER_ACCESS_TOKEN,
      OWNER,
      REPO,
      PULL_NUMBER,
      "issue body"
    );
    await updatePullRequestIssueCommentWithUserToken(
      USER_ACCESS_TOKEN,
      OWNER,
      REPO,
      COMMENT_ID,
      "updated issue"
    );
    await deletePullRequestIssueCommentWithUserToken(
      USER_ACCESS_TOKEN,
      OWNER,
      REPO,
      COMMENT_ID
    );
    await createPullRequestReviewCommentWithUserToken(
      USER_ACCESS_TOKEN,
      OWNER,
      REPO,
      PULL_NUMBER,
      {
        body: "review body",
        commitId: "abc123",
        path: "src/index.ts",
        line: 20,
        side: "RIGHT",
      }
    );
    await createReplyForReviewCommentWithUserToken(
      USER_ACCESS_TOKEN,
      OWNER,
      REPO,
      PULL_NUMBER,
      COMMENT_ID,
      "reply body"
    );
    await updatePullRequestReviewCommentWithUserToken(
      USER_ACCESS_TOKEN,
      OWNER,
      REPO,
      COMMENT_ID,
      "updated review"
    );
    await deletePullRequestReviewCommentWithUserToken(
      USER_ACCESS_TOKEN,
      OWNER,
      REPO,
      COMMENT_ID
    );
    await resolvePullRequestReviewThreadWithUserToken(
      USER_ACCESS_TOKEN,
      THREAD_ID
    );
    await unresolvePullRequestReviewThreadWithUserToken(
      USER_ACCESS_TOKEN,
      THREAD_ID
    );

    expect(mockCreateIssueComment).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      issue_number: PULL_NUMBER,
      body: "issue body",
    });
    expect(mockUpdateIssueComment).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      comment_id: COMMENT_ID,
      body: "updated issue",
    });
    expect(mockDeleteIssueComment).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      comment_id: COMMENT_ID,
    });
    expect(mockCreateReviewComment).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: PULL_NUMBER,
      body: "review body",
      commit_id: "abc123",
      path: "src/index.ts",
      line: 20,
      side: "RIGHT",
      start_line: undefined,
      start_side: undefined,
    });
    expect(mockCreateReplyForReviewComment).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: PULL_NUMBER,
      comment_id: COMMENT_ID,
      body: "reply body",
    });
    expect(mockUpdateReviewComment).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      comment_id: COMMENT_ID,
      body: "updated review",
    });
    expect(mockDeleteReviewComment).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      comment_id: COMMENT_ID,
    });
    expect(mockGraphql).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("reviewThreads"),
      {
        owner: OWNER,
        repo: REPO,
        pullNumber: PULL_NUMBER,
        cursor: null,
      }
    );
    expect(mockGraphql).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("reviewThreads"),
      {
        owner: OWNER,
        repo: REPO,
        pullNumber: PULL_NUMBER,
        cursor: null,
      }
    );
    expect(mockGraphql).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("resolveReviewThread"),
      { threadId: THREAD_ID }
    );
    expect(mockGraphql).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("unresolveReviewThread"),
      { threadId: THREAD_ID }
    );
  });
});

function makeIssueComment(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMENT_ID,
    node_id: "IC_kwDOExample",
    user: {
      id: 99,
      login: "octocat",
      node_id: "U_kwDOExample",
      avatar_url: "https://avatars.githubusercontent.com/u/99",
    },
    body: "issue body",
    author_association: "MEMBER",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/acme/repo/pull/12#issuecomment-345",
    ...overrides,
  };
}

function makeReviewComment(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMENT_ID,
    node_id: "PRRC_kwDOExample",
    path: "src/index.ts",
    line: 20,
    side: "RIGHT",
    start_line: null,
    start_side: null,
    original_line: 20,
    original_start_line: null,
    body: "review body",
    user: {
      id: 99,
      login: "octocat",
      node_id: "U_kwDOExample",
      avatar_url: "https://avatars.githubusercontent.com/u/99",
    },
    author_association: "MEMBER",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/acme/repo/pull/12#discussion_r345",
    commit_id: "abc123",
    pull_request_review_id: 456,
    in_reply_to_id: null,
    ...overrides,
  };
}
