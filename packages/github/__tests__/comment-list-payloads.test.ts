import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const {
  mockCreateAppAuth,
  mockGraphql,
  mockListIssueComments,
  mockListReviewComments,
  mockOctokitConstructor,
} = vi.hoisted(() => ({
  mockCreateAppAuth: vi.fn(() => async () => ({ token: "installation-token" })),
  mockGraphql: vi.fn(),
  mockListIssueComments: vi.fn(),
  mockListReviewComments: vi.fn(),
  mockOctokitConstructor: vi.fn(),
}));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: mockCreateAppAuth,
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    pulls = {
      listReviewComments: mockListReviewComments,
    };

    issues = {
      listComments: mockListIssueComments,
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
  listPullRequestIssueComments,
  listPullRequestReviewComments,
} from "../index";

const INSTALLATION_ID = "123";
const OWNER = "acme";
const REPO = "repo";
const PULL_NUMBER = 12;
const ENV_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_DISPATCH_REPO",
  "WEBAPP_ENV",
] as const;
const originalEnv = new Map<string, string | undefined>();

describe("GitHub comment list payload mapping", () => {
  beforeAll(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
    }
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-key";
    process.env.GITHUB_APP_WEBHOOK_SECRET = "test-secret";
    process.env.GITHUB_APP_CLIENT_ID = "test-client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
    process.env.GITHUB_APP_DISPATCH_REPO = "owner/dispatch";
    process.env.WEBAPP_ENV = "stage";
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

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

    const comments = await listPullRequestIssueComments(
      INSTALLATION_ID,
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
    expect(comments).toEqual([
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

    const comments = await listPullRequestReviewComments(
      INSTALLATION_ID,
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
    expect(comments).toEqual([
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

    const comments = await listPullRequestReviewComments(
      INSTALLATION_ID,
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
    expect(comments?.[0]?.review_thread_node_id).toBe(
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
