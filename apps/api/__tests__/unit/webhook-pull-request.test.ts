/**
 * Unit tests for GitHub pull_request webhook handler.
 *
 * Tests the handlePullRequest function which processes PR lifecycle events:
 * - closed (merged=true) → Updates state to MERGED, sets mergedAt and mergeCommitSha
 * - closed (merged=false) → Updates state to CLOSED
 * - reopened → Updates state to OPEN
 * - synchronize → Updates headSha
 * - converted_to_draft → Sets isDraft=true
 * - ready_for_review → Sets isDraft=false
 * - Unknown PR/Repository → Returns without error
 * - Unsupported actions → Skips without DB queries
 */

import type {
  PullRequestClosedEvent,
  PullRequestConvertedToDraftEvent,
  PullRequestReadyForReviewEvent,
  PullRequestReopenedEvent,
  PullRequestSynchronizeEvent,
} from "@octokit/webhooks-types";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

// Mock modules before importing
vi.mock("@repo/database", () => {
  const mockWithDb: any = vi.fn();
  mockWithDb.tx = vi.fn();
  return {
    GitHubPRState: {
      OPEN: "OPEN",
      MERGED: "MERGED",
      CLOSED: "CLOSED",
    },
    withDb: mockWithDb,
  };
});

// Import after mocking
import { withDb } from "@repo/database";
import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";

// Type aliases for mocked functions
const mockWithDb = withDb as unknown as Mock;
const mockWithDbTx = withDb.tx as unknown as Mock;

// Mock database transaction client
let mockTx: any;

/**
 * Helper to create minimal repository object for webhook events
 */
function createRepository(githubId: number) {
  return {
    id: githubId,
    node_id: `R_${githubId}`,
    name: "test-repo",
    full_name: "owner/test-repo",
    private: false,
    owner: {
      login: "owner",
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
    // ... other required fields omitted for brevity
  };
}

/**
 * Helper to create minimal pull request object
 */
function createPullRequest(partial: {
  number: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  closed_at?: string | null;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  head?: { sha: string };
}) {
  return {
    id: 1,
    node_id: "PR_1",
    number: partial.number,
    title: partial.title ?? "Test PR",
    user: {
      login: "test-user",
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
      type: "User" as const,
      site_admin: false,
    },
    state: partial.state ?? "open",
    draft: partial.draft ?? false,
    merged: partial.merged ?? false,
    closed_at: partial.closed_at ?? null,
    merged_at: partial.merged_at ?? null,
    merge_commit_sha: partial.merge_commit_sha ?? null,
    head: partial.head ?? { sha: "abc123" },
    // Required fields for webhook type
    url: "",
    html_url: "https://github.com/owner/test-repo/pull/1",
    diff_url: "",
    patch_url: "",
    issue_url: "",
    commits_url: "",
    review_comments_url: "",
    review_comment_url: "",
    comments_url: "",
    statuses_url: "",
    created_at: "2026-02-10T00:00:00Z",
    updated_at: "2026-02-10T00:00:00Z",
  } as any;
}

/**
 * Helper to create minimal sender object
 */
function createSender() {
  return {
    login: "test-user",
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
    type: "User" as const,
    site_admin: false,
  };
}

describe("handlePullRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up transaction mock
    mockTx = {
      repository: {
        findUnique: vi.fn(),
      },
      gitHubPullRequest: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      workstreamEvent: {
        create: vi.fn(),
      },
    };

    // Mock withDb.tx — all reads and writes happen in a single transaction
    mockWithDbTx.mockImplementation((callback: any) => {
      return callback(mockTx);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("closed action with merged=true", () => {
    it("updates state to MERGED and sets mergedAt, mergeCommitSha, creates GITHUB_PR_MERGED event", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 42,
        title: "Add feature X",
        state: "closed",
        merged: true,
        closed_at: "2026-02-10T12:00:00Z",
        merged_at: "2026-02-10T12:00:00Z",
        merge_commit_sha: "def456",
      });

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      // Mock repository lookup
      mockTx.repository.findUnique.mockResolvedValue({
        id: "repo-uuid-123",
      });

      // Mock PR lookup (includes artifact via relation)
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-456",
        workstreamId: "ws-uuid-789",
        artifactId: "artifact-uuid-123",
        artifact: { slug: "plan-feature-x" },
      });

      // Mock update
      mockTx.gitHubPullRequest.update.mockResolvedValue({});

      // Mock event creation
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequest(event);

      // Verify repository lookup
      expect(mockTx.repository.findUnique).toHaveBeenCalledWith({
        where: { githubId: 789 },
        select: { id: true },
      });

      // Verify PR lookup (includes artifact via relation)
      expect(mockTx.gitHubPullRequest.findUnique).toHaveBeenCalledWith({
        where: {
          repositoryId_number: {
            repositoryId: "repo-uuid-123",
            number: 42,
          },
        },
        select: {
          id: true,
          workstreamId: true,
          artifactId: true,
          artifact: { select: { slug: true } },
        },
      });

      // Verify PR update
      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-456" },
        data: {
          state: "MERGED",
          closedAt: new Date("2026-02-10T12:00:00Z"),
          mergedAt: new Date("2026-02-10T12:00:00Z"),
          mergeCommitSha: "def456",
        },
      });

      // Verify workstream event creation with artifactId and slug
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: {
          workstreamId: "ws-uuid-789",
          type: "GITHUB_PR_MERGED",
          actorType: "system",
          data: {
            prNumber: 42,
            prTitle: "Add feature X",
            prUrl: "https://github.com/owner/test-repo/pull/1",
            artifactId: "artifact-uuid-123",
            slug: "plan-feature-x",
            mergedAt: "2026-02-10T12:00:00Z",
            mergeCommitSha: "def456",
          },
        },
      });
    });
  });

  describe("closed action with merged=false", () => {
    it("updates state to CLOSED and creates GITHUB_PR_CLOSED event", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 43,
        title: "Feature rejected",
        state: "closed",
        merged: false,
        closed_at: "2026-02-10T13:00:00Z",
        merged_at: null,
        merge_commit_sha: null,
      });

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.repository.findUnique.mockResolvedValue({
        id: "repo-uuid-123",
      });

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-789",
        workstreamId: "ws-uuid-abc",
        artifactId: null,
        artifact: null,
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-789" },
        data: {
          state: "CLOSED",
          closedAt: new Date("2026-02-10T13:00:00Z"),
          mergedAt: null,
          mergeCommitSha: null,
        },
      });

      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: {
          workstreamId: "ws-uuid-abc",
          type: "GITHUB_PR_CLOSED",
          actorType: "system",
          data: {
            prNumber: 43,
            prTitle: "Feature rejected",
            prUrl: "https://github.com/owner/test-repo/pull/1",
            artifactId: null,
            slug: undefined,
          },
        },
      });
    });
  });

  describe("reopened action", () => {
    it("updates state to OPEN and clears closedAt", async () => {
      const repository = createRepository(123);
      const pullRequest = createPullRequest({
        number: 44,
        title: "Reopened PR",
        state: "open",
      });

      const event: PullRequestReopenedEvent = {
        action: "reopened",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.repository.findUnique.mockResolvedValue({
        id: "repo-uuid-456",
      });

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-reopen",
        workstreamId: "ws-uuid-def",
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-reopen" },
        data: {
          state: "OPEN",
          closedAt: null,
        },
      });
    });
  });

  describe("synchronize action", () => {
    it("updates headSha when PR is synchronized with new commits", async () => {
      const repository = createRepository(456);
      const pullRequest = createPullRequest({
        number: 45,
        title: "Updated PR",
        head: { sha: "new-sha-xyz" },
      });

      const event: PullRequestSynchronizeEvent = {
        action: "synchronize",
        number: pullRequest.number,
        before: "old-sha-abc",
        after: "new-sha-xyz",
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.repository.findUnique.mockResolvedValue({
        id: "repo-uuid-sync",
      });

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-sync",
        workstreamId: "ws-uuid-sync",
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-sync" },
        data: {
          headSha: "new-sha-xyz",
        },
      });
    });
  });

  describe("converted_to_draft action", () => {
    it("sets isDraft to true", async () => {
      const repository = createRepository(111);
      const pullRequest = createPullRequest({
        number: 46,
        title: "Draft PR",
        draft: true,
      });

      const event: PullRequestConvertedToDraftEvent = {
        action: "converted_to_draft",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.repository.findUnique.mockResolvedValue({
        id: "repo-uuid-draft",
      });

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-draft",
        workstreamId: "ws-uuid-draft",
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-draft" },
        data: {
          isDraft: true,
        },
      });
    });
  });

  describe("ready_for_review action", () => {
    it("sets isDraft to false", async () => {
      const repository = createRepository(222);
      const pullRequest = createPullRequest({
        number: 47,
        title: "Ready for review",
        draft: false,
      });

      const event: PullRequestReadyForReviewEvent = {
        action: "ready_for_review",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.repository.findUnique.mockResolvedValue({
        id: "repo-uuid-ready",
      });

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-ready",
        workstreamId: "ws-uuid-ready",
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-ready" },
        data: {
          isDraft: false,
        },
      });
    });
  });

  describe("unknown repository", () => {
    it("returns without error when repository is not found", async () => {
      const repository = createRepository(999);
      const pullRequest = createPullRequest({
        number: 50,
        title: "Unknown repo PR",
      });

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      // Mock repository not found
      mockTx.repository.findUnique.mockResolvedValue(null);

      await handlePullRequest(event);

      // Should not attempt to find PR or update
      expect(mockTx.gitHubPullRequest.findUnique).not.toHaveBeenCalled();
      expect(mockTx.gitHubPullRequest.update).not.toHaveBeenCalled();
    });
  });

  describe("unknown pull request", () => {
    it("returns without error when PR is not found in database", async () => {
      const repository = createRepository(333);
      const pullRequest = createPullRequest({
        number: 51,
        title: "Unknown PR",
      });

      const event: PullRequestReopenedEvent = {
        action: "reopened",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      // Repository exists
      mockTx.repository.findUnique.mockResolvedValue({
        id: "repo-uuid-exists",
      });

      // PR not found
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue(null);

      await handlePullRequest(event);

      // Should not attempt update
      expect(mockTx.gitHubPullRequest.update).not.toHaveBeenCalled();
    });
  });

  describe("unsupported actions", () => {
    it("skips DB queries for unsupported action types", async () => {
      const repository = createRepository(444);
      const pullRequest = createPullRequest({
        number: 52,
        title: "Edited PR",
      });

      // Create an event with unsupported action
      const event = {
        action: "edited",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      await handlePullRequest(event);

      // Should not query DB at all
      expect(mockTx.repository.findUnique).not.toHaveBeenCalled();
      expect(mockTx.gitHubPullRequest.findUnique).not.toHaveBeenCalled();
      expect(mockTx.gitHubPullRequest.update).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });
  });

  describe("transaction behavior", () => {
    it("executes all reads and writes within a single transaction", async () => {
      const repository = createRepository(555);
      const pullRequest = createPullRequest({
        number: 53,
        title: "Transaction test",
        state: "closed",
        merged: true,
        closed_at: "2026-02-10T14:00:00Z",
        merged_at: "2026-02-10T14:00:00Z",
        merge_commit_sha: "commit-sha",
      });

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.repository.findUnique.mockResolvedValue({
        id: "repo-uuid-tx",
      });

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-tx",
        workstreamId: "ws-uuid-tx",
        artifactId: "artifact-uuid-tx",
        artifact: { slug: "plan-tx" },
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequest(event);

      // Verify all operations in single transaction
      expect(mockWithDbTx).toHaveBeenCalledTimes(1);
      expect(mockWithDb).not.toHaveBeenCalled();

      // Verify lookups and mutations all occurred within the transaction
      expect(mockTx.repository.findUnique).toHaveBeenCalled();
      expect(mockTx.gitHubPullRequest.findUnique).toHaveBeenCalled();
      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).toHaveBeenCalled();
    });
  });
});
