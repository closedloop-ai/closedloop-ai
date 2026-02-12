/**
 * Unit tests for GitHub push webhook handler.
 *
 * Tests the handlePush function which processes push events:
 * - Updates lastPushedAt timestamp for tracked repositories via updateMany
 * - Silently skips unknown repositories (no matching installation repository)
 * - Uses githubRepoId for repository matching
 */

import type { PushEvent } from "@octokit/webhooks-types";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// Mock modules before importing
vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocking
import { withDb } from "@repo/database";
import { handlePush } from "@/app/webhooks/github/handlers/push-handler";

// Type aliases for mocked functions
const mockWithDb = withDb as unknown as Mock;

// Mock database client
const mockDb = {
  gitHubInstallationRepository: {
    updateMany: vi.fn(),
  },
};

/**
 * Helper to create minimal repository object for webhook events
 */
function createRepository(githubId: number, fullName: string) {
  return {
    id: githubId,
    node_id: `R_${githubId}`,
    name: fullName.split("/")[1] || fullName,
    full_name: fullName,
    private: false,
    owner: {
      login: fullName.split("/")[0] || "owner",
      id: 12_345,
      node_id: "U_12345",
      avatar_url: "",
      gravatar_id: "",
      url: "",
      html_url: "",
      followers_url: "",
      following_url: "",
      gists_url: "",
      starred_url: "",
      subscriptions_url: "",
      organizations_url: "",
      repos_url: "",
      events_url: "",
      received_events_url: "",
      type: "User" as const,
      site_admin: false,
    },
    html_url: "",
    description: null,
    fork: false,
    url: "",
    created_at: "2021-01-01T00:00:00Z",
    updated_at: "2021-01-01T00:00:00Z",
    pushed_at: "2024-06-15T10:30:00Z",
    git_url: "",
    ssh_url: "",
    clone_url: "",
    svn_url: "",
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: 0,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: "public" as const,
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: "main",
    stargazers: 0,
    master_branch: "main",
  };
}

/**
 * Helper to create minimal push event
 */
function createPushEvent(partial: {
  repositoryId: number;
  repositoryFullName: string;
  ref?: string;
  before?: string;
  after?: string;
  commitsCount?: number;
}): PushEvent {
  const {
    repositoryId,
    repositoryFullName,
    ref = "refs/heads/main",
    before = "abc123",
    after = "def456",
    commitsCount = 1,
  } = partial;

  const commits = Array.from({ length: commitsCount }, (_, i) => ({
    id: `commit${i}`,
    tree_id: `tree${i}`,
    distinct: true,
    message: `Commit message ${i}`,
    timestamp: "2021-01-01T00:00:00Z",
    url: "",
    author: {
      name: "Test User",
      email: "test@example.com",
      username: "testuser",
    },
    committer: {
      name: "Test User",
      email: "test@example.com",
      username: "testuser",
    },
    added: [],
    removed: [],
    modified: [],
  }));

  return {
    ref,
    before,
    after,
    repository: createRepository(repositoryId, repositoryFullName),
    pusher: {
      name: "testuser",
      email: "test@example.com",
    },
    sender: {
      login: "testuser",
      id: 1,
      node_id: "U_1",
      avatar_url: "",
      gravatar_id: "",
      url: "",
      html_url: "",
      followers_url: "",
      following_url: "",
      gists_url: "",
      starred_url: "",
      subscriptions_url: "",
      organizations_url: "",
      repos_url: "",
      events_url: "",
      received_events_url: "",
      type: "User",
      site_admin: false,
    },
    created: false,
    deleted: false,
    forced: false,
    base_ref: null,
    compare: "",
    commits,
    head_commit: commits[0] || null,
    installation: {
      id: 123_456,
      node_id: "I_123456",
    },
    organization: undefined,
  } as unknown as PushEvent;
}

describe("handlePush", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementation for withDb
    mockWithDb.mockImplementation((callback) => callback(mockDb));
  });

  describe("tracked repository", () => {
    it("updates lastPushedAt from payload timestamp when repository exists", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        commitsCount: 3,
      });

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json).toEqual({
        message: "Push event processed successfully",
        ok: true,
      });

      expect(
        mockDb.gitHubInstallationRepository.updateMany
      ).toHaveBeenCalledWith({
        where: {
          githubRepoId: 123,
          installation: { installationId: 123_456 },
        },
        data: { lastPushedAt: new Date("2024-06-15T10:30:00Z") },
      });
    });

    it("matches repository by githubRepoId and installationId from the push payload", async () => {
      const event = createPushEvent({
        repositoryId: 456,
        repositoryFullName: "org/my-repo",
        ref: "refs/heads/feature-branch",
      });

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      await handlePush(event);

      expect(
        mockDb.gitHubInstallationRepository.updateMany
      ).toHaveBeenCalledWith({
        where: {
          githubRepoId: 456,
          installation: { installationId: 123_456 },
        },
        data: { lastPushedAt: new Date("2024-06-15T10:30:00Z") },
      });
    });
  });

  describe("unknown repository", () => {
    it("returns success without error when repository not found", async () => {
      const event = createPushEvent({
        repositoryId: 999,
        repositoryFullName: "unknown/repo",
      });

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 0,
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json).toEqual({
        message: "Repository not tracked, ignoring push event",
        ok: true,
      });
    });
  });

  describe("multiple pushes", () => {
    it("uses payload timestamp so redeliveries preserve correct ordering", async () => {
      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      // First push — earlier payload timestamp
      const event1 = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        after: "abc123",
      });
      (event1.repository as any).pushed_at = "2024-06-15T10:00:00Z";
      await handlePush(event1);

      const firstCallTime = (
        mockDb.gitHubInstallationRepository.updateMany.mock.calls[0][0].data
          .lastPushedAt as Date
      ).getTime();

      // Second push — later payload timestamp
      const event2 = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        after: "def456",
      });
      (event2.repository as any).pushed_at = "2024-06-15T11:00:00Z";
      await handlePush(event2);

      const secondCallTime = (
        mockDb.gitHubInstallationRepository.updateMany.mock.calls[1][0].data
          .lastPushedAt as Date
      ).getTime();

      expect(secondCallTime).toBeGreaterThan(firstCallTime);
      expect(
        mockDb.gitHubInstallationRepository.updateMany
      ).toHaveBeenCalledTimes(2);
    });
  });

  describe("installation scoping", () => {
    it("scopes update to specific installation when installation ID is present", async () => {
      const event = createPushEvent({
        repositoryId: 789,
        repositoryFullName: "owner/repo",
      });

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      await handlePush(event);

      expect(
        mockDb.gitHubInstallationRepository.updateMany
      ).toHaveBeenCalledWith({
        where: {
          githubRepoId: 789,
          installation: { installationId: 123_456 },
        },
        data: { lastPushedAt: new Date("2024-06-15T10:30:00Z") },
      });
    });

    it("falls back to githubRepoId-only filtering when installation is missing", async () => {
      const event = createPushEvent({
        repositoryId: 789,
        repositoryFullName: "owner/repo",
      });

      // Remove installation field to test fallback
      (event as any).installation = undefined;

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      await handlePush(event);

      expect(
        mockDb.gitHubInstallationRepository.updateMany
      ).toHaveBeenCalledWith({
        where: { githubRepoId: 789 },
        data: { lastPushedAt: new Date("2024-06-15T10:30:00Z") },
      });
    });
  });

  describe("edge cases", () => {
    it("handles push with zero commits", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        commitsCount: 0,
      });

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json.ok).toBe(true);
      expect(mockDb.gitHubInstallationRepository.updateMany).toHaveBeenCalled();
    });

    it("handles push to non-main branch", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        ref: "refs/heads/feature/new-feature",
      });

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json.ok).toBe(true);
      expect(mockDb.gitHubInstallationRepository.updateMany).toHaveBeenCalled();
    });

    it("handles push with many commits", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        commitsCount: 50,
      });

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json.ok).toBe(true);
      expect(mockDb.gitHubInstallationRepository.updateMany).toHaveBeenCalled();
    });
  });
});
