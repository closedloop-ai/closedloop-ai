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
  GitHubProviderResultStatus,
  GitHubUserTokenProviderResultStatus,
  getSinglePullRequest,
  getSinglePullRequestWithProviderResult,
} from "../index";

// The functions are credential-agnostic (PLN-1525 step 4): callers inject the
// Octokit, so the tests do too — no App env, no auth mocking.
const mockPullsGet = vi.fn();

const octokit = {
  rest: {
    pulls: { get: mockPullsGet },
  },
} as unknown as Octokit;

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
    updated_at: string;
    merge_commit_sha: string | null;
    additions: number | null;
    deletions: number | null;
    changed_files: number | null;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    user: { login: string; id?: number; type?: string } | null;
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
  beforeEach(() => {
    mockPullsGet.mockReset();
  });

  it("returns mapped PR data for an open pull request", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: makePrData({ state: "open" }),
    });

    const result = await getSinglePullRequest(
      octokit,
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
      createdAt: null,
      mergedAt: null,
      closedAt: null,
      mergeCommitSha: null,
      additions: 33,
      deletions: 7,
      changedFiles: 4,
    });

    expect(mockPullsGet).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: OWNER,
        repo: REPO,
        pull_number: PULL_NUMBER,
      })
    );
  });

  // ISS-12344: a Branch refresh re-files a PR only when its read is no older
  // than the stored row, which it can tell only from GitHub's updated_at.
  it("carries GitHub's updated_at on the mapped read", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: makePrData({ updated_at: "2026-10-09T21:00:00Z" }),
    });

    const result = await getSinglePullRequest(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result?.updatedAt).toBe("2026-10-09T21:00:00Z");
  });

  it("omits PR LOC fields when the REST response does not include them", async () => {
    const data = makePrData();
    Reflect.deleteProperty(data, "additions");
    Reflect.deleteProperty(data, "deletions");
    Reflect.deleteProperty(data, "changed_files");
    mockPullsGet.mockResolvedValueOnce({ data });

    const result = await getSinglePullRequest(
      octokit,
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
      octokit,
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
      octokit,
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
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toBeNull();
  });

  it("returns null on any unexpected error from the API", async () => {
    mockPullsGet.mockRejectedValueOnce(new Error("Network timeout"));

    const result = await getSinglePullRequest(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toBeNull();
  });
});

describe("getSinglePullRequestWithProviderResult", () => {
  beforeEach(() => {
    mockPullsGet.mockReset();
  });

  it("returns a Success result with mapped PR data", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: makePrData({
        user: { login: "octocat", id: 123, type: GitHubActorType.User },
      }),
    });

    const result = await getSinglePullRequestWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: expect.objectContaining({
        githubId: "11111",
        authorLogin: "octocat",
        authorProviderUserId: "123",
        authorActorType: GitHubActorType.User,
        state: "OPEN",
        additions: 33,
        deletions: 7,
        changedFiles: 4,
      }),
    });
    expect(mockPullsGet).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: OWNER,
        repo: REPO,
        pull_number: PULL_NUMBER,
      })
    );
  });

  it("marks an unknown provider actor type as untrusted", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: makePrData({
        user: { login: "mystery", id: 456, type: "FutureKind" },
      }),
    });

    const result = await getSinglePullRequestWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result.status).toBe(GitHubProviderResultStatus.Success);
    if (result.status !== GitHubProviderResultStatus.Success) {
      throw new Error("expected provider success");
    }
    expect(result.value.authorProviderUserId).toBe("456");
    expect(result.value.authorActorType).toBe(GitHubActorType.Unknown);
  });

  it("reports isDraft false when GitHub omits the draft field", async () => {
    const { draft: _omitted, ...withoutDraft } = makePrData();
    mockPullsGet.mockResolvedValueOnce({ data: withoutDraft });

    const result = await getSinglePullRequestWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: expect.objectContaining({ isDraft: false }),
    });
  });

  it("classifies 401 responses as unauthorized credentials", async () => {
    mockPullsGet.mockRejectedValueOnce(
      Object.assign(new Error("Bad credentials"), { status: 401 })
    );

    const result = await getSinglePullRequestWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: GitHubUserTokenProviderResultStatus.CredentialUnauthorized,
    });
  });

  it("classifies non-rate-limit 403 responses as insufficient scope", async () => {
    mockPullsGet.mockRejectedValueOnce(
      Object.assign(new Error("Resource not accessible by token"), {
        status: 403,
      })
    );

    const result = await getSinglePullRequestWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: GitHubUserTokenProviderResultStatus.CredentialInsufficientScope,
    });
  });

  it("classifies rate-limited 403 responses as provider rate limits, not scope faults", async () => {
    mockPullsGet.mockRejectedValueOnce(
      Object.assign(new Error("API rate limit exceeded"), { status: 403 })
    );

    const result = await getSinglePullRequestWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: null,
    });
  });

  it("returns provider_unavailable for other errors", async () => {
    mockPullsGet.mockRejectedValueOnce(new Error("Network timeout"));

    const result = await getSinglePullRequestWithProviderResult(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
  });
});
