import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockPullsGet = vi.fn();
const mockOctokitAuthOptions: unknown[] = [];

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(() => async (_opts: unknown) => ({
    token: "test-token",
  })),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    constructor(options?: unknown) {
      mockOctokitAuthOptions.push(options);
    }

    rest = {
      pulls: {
        get: mockPullsGet,
      },
    };
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
  GitHubProviderResultStatus,
  GitHubUserTokenProviderResultStatus,
  getSinglePullRequest,
  getSinglePullRequestWithUserTokenProviderResult,
} from "../index";

const INSTALLATION_ID = "12345";
const OWNER = "acme";
const REPO = "my-repo";
const PULL_NUMBER = 42;

function makePrData(
  overrides: Partial<{
    id: number;
    number: number;
    title: string;
    html_url: string;
    state: string;
    draft: boolean;
    merged_at: string | null;
    closed_at: string | null;
    merge_commit_sha: string | null;
    additions: number | null;
    deletions: number | null;
    changed_files: number | null;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    user: { login: string } | null;
  }> = {}
) {
  return {
    id: 11_111,
    number: PULL_NUMBER,
    title: "Add feature X",
    html_url: "https://github.com/acme/my-repo/pull/42",
    state: "open",
    draft: false,
    merged_at: null,
    closed_at: null,
    merge_commit_sha: null,
    additions: 33,
    deletions: 7,
    changed_files: 4,
    head: { ref: "feature-x", sha: "abc123" },
    base: { ref: "main", sha: "def456" },
    user: null,
    ...overrides,
  };
}

describe("getSinglePullRequest", () => {
  beforeAll(() => {
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-key";
    process.env.GITHUB_APP_WEBHOOK_SECRET = "test-secret";
    process.env.GITHUB_APP_CLIENT_ID = "test-client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
    process.env.GITHUB_APP_DISPATCH_REPO = "owner/dispatch";
    process.env.WEBAPP_ENV = "stage";
  });

  beforeEach(() => {
    mockPullsGet.mockReset();
    mockOctokitAuthOptions.length = 0;
  });

  it("returns mapped PR data for an open pull request", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: makePrData({ state: "open" }),
    });

    const result = await getSinglePullRequest(
      INSTALLATION_ID,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      githubId: "11111",
      number: PULL_NUMBER,
      title: "Add feature X",
      htmlUrl: "https://github.com/acme/my-repo/pull/42",
      headBranch: "feature-x",
      baseBranch: "main",
      headSha: "abc123",
      baseSha: "def456",
      state: "OPEN",
      isDraft: false,
      authorLogin: null,
      mergedAt: null,
      closedAt: null,
      mergeCommitSha: null,
      additions: 33,
      deletions: 7,
      changedFiles: 4,
    });

    expect(mockPullsGet).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: PULL_NUMBER,
    });
  });

  it("omits PR LOC fields when the REST response does not include them", async () => {
    const data = makePrData();
    Reflect.deleteProperty(data, "additions");
    Reflect.deleteProperty(data, "deletions");
    Reflect.deleteProperty(data, "changed_files");
    mockPullsGet.mockResolvedValueOnce({ data });

    const result = await getSinglePullRequest(
      INSTALLATION_ID,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).not.toHaveProperty("additions");
    expect(result).not.toHaveProperty("deletions");
    expect(result).not.toHaveProperty("changedFiles");
  });

  it("returns MERGED state when merged_at is set", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: makePrData({
        state: "closed",
        merged_at: "2026-03-01T12:00:00Z",
        closed_at: "2026-03-01T12:00:00Z",
        merge_commit_sha: "merge-sha-123",
      }),
    });

    const result = await getSinglePullRequest(
      INSTALLATION_ID,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result?.state).toBe("MERGED");
    expect(result?.mergedAt).toBe("2026-03-01T12:00:00Z");
    expect(result?.closedAt).toBe("2026-03-01T12:00:00Z");
    expect(result?.mergeCommitSha).toBe("merge-sha-123");
  });

  it("returns CLOSED state when PR is closed without merge", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: makePrData({
        state: "closed",
        merged_at: null,
        closed_at: "2026-03-15T08:00:00Z",
      }),
    });

    const result = await getSinglePullRequest(
      INSTALLATION_ID,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result?.state).toBe("CLOSED");
    expect(result?.mergedAt).toBeNull();
    expect(result?.closedAt).toBe("2026-03-15T08:00:00Z");
  });

  it("returns null when the API throws (PR not found or permission denied)", async () => {
    mockPullsGet.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const result = await getSinglePullRequest(
      INSTALLATION_ID,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toBeNull();
  });

  it("returns null on any unexpected error from the API", async () => {
    mockPullsGet.mockRejectedValueOnce(new Error("Network timeout"));

    const result = await getSinglePullRequest(
      INSTALLATION_ID,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toBeNull();
  });

  it("fetches a single pull request with a user OAuth token", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: makePrData({ user: { login: "octocat" } }),
    });

    const result = await getSinglePullRequestWithUserTokenProviderResult(
      "user-token-1",
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: expect.objectContaining({
        githubId: "11111",
        authorLogin: "octocat",
        state: "OPEN",
        additions: 33,
        deletions: 7,
        changedFiles: 4,
      }),
    });
    expect(mockOctokitAuthOptions.at(-1)).toEqual({ auth: "user-token-1" });
    expect(mockPullsGet).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: PULL_NUMBER,
    });
  });

  it("classifies user OAuth 401 responses as unauthorized credentials", async () => {
    mockPullsGet.mockRejectedValueOnce(
      Object.assign(new Error("Bad credentials"), { status: 401 })
    );

    const result = await getSinglePullRequestWithUserTokenProviderResult(
      "user-token-1",
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: GitHubUserTokenProviderResultStatus.CredentialUnauthorized,
    });
  });

  it("classifies non-rate-limit user OAuth 403 responses as insufficient scope", async () => {
    mockPullsGet.mockRejectedValueOnce(
      Object.assign(new Error("Resource not accessible by token"), {
        status: 403,
      })
    );

    const result = await getSinglePullRequestWithUserTokenProviderResult(
      "user-token-1",
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: GitHubUserTokenProviderResultStatus.CredentialInsufficientScope,
    });
  });
});
