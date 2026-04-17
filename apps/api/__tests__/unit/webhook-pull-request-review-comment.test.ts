/**
 * Unit tests for GitHub pull_request_review_comment webhook handler.
 *
 * Tests the handlePullRequestReviewComment function which processes review comment events:
 * - created → Upserts GitHubPRReviewComment record + GITHUB_PR_COMMENT_ADDED workstream event (idempotent)
 * - created with null reviewId → Handles missing pull_request_review_id
 * - edited → Updates body field via updateMany with String key
 * - deleted → Deletes record via deleteMany with String key
 * - Unknown repository/PR → Graceful early exit
 * - Unsupported actions → Skips before DB queries
 */

import type {
  PullRequestReviewCommentCreatedEvent,
  PullRequestReviewCommentDeletedEvent,
  PullRequestReviewCommentEditedEvent,
} from "@octokit/webhooks-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbTx as setupMockWithDbTx } from "../utils/db-helpers";

// Mock modules before importing
vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

// Import after mocking
import { handlePullRequestReviewComment } from "@/app/webhooks/github/handlers/pull-request-review-comment-handler";

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
  html_url?: string;
}) {
  return {
    id: 1,
    node_id: "PR_1",
    number: partial.number,
    title: partial.title ?? "Test PR",
    html_url: partial.html_url ?? "https://github.com/owner/test-repo/pull/1",
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
    state: "open",
    // Required fields for webhook type
    url: "",
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
 * Helper to create minimal review comment object
 */
function createComment(partial: {
  id: number;
  body: string;
  path?: string;
  line?: number;
  pull_request_review_id?: number;
}) {
  return {
    id: partial.id,
    node_id: `PRRC_${partial.id}`,
    diff_hunk: "@@ -1,1 +1,1 @@",
    path: partial.path ?? "src/file.ts",
    line: partial.line ?? 42,
    body: partial.body,
    pull_request_review_id: partial.pull_request_review_id ?? null,
    user: {
      login: "reviewer",
      id: 99_999,
      node_id: "U_99999",
      avatar_url: "https://example.com/avatar.png",
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
    created_at: "2026-02-10T12:00:00Z",
    updated_at: "2026-02-10T12:00:00Z",
    html_url: `https://github.com/owner/test-repo/pull/1#discussion_r${partial.id}`,
    pull_request_url: "",
    author_association: "CONTRIBUTOR" as const,
    url: "",
    _links: {
      self: { href: "" },
      html: { href: "" },
      pull_request: { href: "" },
    },
  } as any;
}

/**
 * Helper to create minimal sender object
 */
function createSender() {
  return {
    login: "reviewer",
    id: 99_999,
    node_id: "U_99999",
    avatar_url: "https://example.com/avatar.png",
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

describe("handlePullRequestReviewComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up transaction mock
    mockTx = {
      gitHubInstallationRepository: {
        findFirst: vi.fn(),
      },
      gitHubPullRequest: {
        findUnique: vi.fn(),
      },
      gitHubPRReviewComment: {
        upsert: vi.fn(),
        updateMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      workstreamEvent: {
        create: vi.fn(),
      },
    };

    // Mock withDb.tx — all reads and writes happen in a single transaction
    setupMockWithDbTx(mockTx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("created action", () => {
    it("creates GitHubPRReviewComment with String for githubCommentId and creates GITHUB_PR_COMMENT_ADDED event", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 42,
        title: "Add feature X",
        html_url: "https://github.com/owner/test-repo/pull/42",
      });
      const comment = createComment({
        id: 123_456_789,
        body: "This looks good!",
        path: "src/feature.ts",
        line: 15,
        pull_request_review_id: 555,
      });

      const event: PullRequestReviewCommentCreatedEvent = {
        action: "created",
        comment,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      // Mock repository lookup
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
      });

      // Mock PR lookup
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-456",
        workstreamId: "ws-uuid-789",
        documentId: "artifact-uuid-123",
        document: { slug: "plan-feature-x" },
      });

      // Mock comment upsert (idempotent for webhook retries)
      mockTx.gitHubPRReviewComment.upsert.mockResolvedValue({});

      // Mock event creation
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReviewComment(event);

      // Verify repository lookup
      expect(
        mockTx.gitHubInstallationRepository.findFirst
      ).toHaveBeenCalledWith({
        where: { githubRepoId: "789" },
        select: { id: true },
      });

      // Verify PR lookup
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
          documentId: true,
          document: { select: { slug: true } },
        },
      });

      // Verify comment upsert with String (idempotent for webhook retries)
      expect(mockTx.gitHubPRReviewComment.upsert).toHaveBeenCalledWith({
        where: { githubCommentId: String(123_456_789) },
        create: {
          pullRequestId: "pr-uuid-456",
          githubCommentId: String(123_456_789),
          inReplyToId: null,
          reviewId: "555",
          body: "This looks good!",
          path: "src/feature.ts",
          line: 15,
          authorLogin: "reviewer",
          authorAvatarUrl: "https://example.com/avatar.png",
          state: "PENDING",
          htmlUrl:
            "https://github.com/owner/test-repo/pull/1#discussion_r123456789",
        },
        update: {
          body: "This looks good!",
          path: "src/feature.ts",
          line: 15,
          reviewId: "555",
        },
      });

      // Verify workstream event creation
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: {
          workstreamId: "ws-uuid-789",
          type: "GITHUB_PR_COMMENT_ADDED",
          actorType: "system",
          data: {
            commentId: 123_456_789,
            commentBody: "This looks good!",
            commentPath: "src/feature.ts",
            commentLine: 15,
            authorLogin: "reviewer",
            prNumber: 42,
            prTitle: "Add feature X",
            prUrl: "https://github.com/owner/test-repo/pull/42",
            commentUrl:
              "https://github.com/owner/test-repo/pull/1#discussion_r123456789",
            documentId: "artifact-uuid-123",
            documentSlug: "plan-feature-x",
          },
        },
      });
    });

    it("creates comment with null reviewId when pull_request_review_id is null", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 43,
        title: "Test PR",
      });
      const comment = createComment({
        id: 111,
        body: "Single comment without review",
        path: "README.md",
        line: 10,
        pull_request_review_id: undefined,
      });

      const event: PullRequestReviewCommentCreatedEvent = {
        action: "created",
        comment: { ...comment, pull_request_review_id: null },
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid",
      });
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid",
        workstreamId: "ws-uuid",
        documentId: null,
        document: null,
      });
      mockTx.gitHubPRReviewComment.upsert.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReviewComment(event);

      expect(mockTx.gitHubPRReviewComment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            reviewId: null,
          }),
        })
      );
    });
  });

  describe("edited action", () => {
    it("updates body field on existing GitHubPRReviewComment matched by githubCommentId", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 44,
        title: "Updated PR",
      });
      const comment = createComment({
        id: 222_333_444,
        body: "Updated comment text",
        path: "src/updated.ts",
        line: 20,
      });

      const event: PullRequestReviewCommentEditedEvent = {
        action: "edited",
        comment,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
        changes: {
          body: {
            from: "Original comment text",
          },
        },
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-456",
      });

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-789",
        workstreamId: "ws-uuid-abc",
      });

      // Mock updateMany returns count of updated records
      mockTx.gitHubPRReviewComment.updateMany.mockResolvedValue({ count: 1 });

      await handlePullRequestReviewComment(event);

      // Verify updateMany was called with String githubCommentId
      expect(mockTx.gitHubPRReviewComment.updateMany).toHaveBeenCalledWith({
        where: {
          githubCommentId: String(222_333_444),
        },
        data: {
          body: "Updated comment text",
        },
      });

      // No workstream event is created for edited action
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });
  });

  describe("deleted action", () => {
    it("deletes GitHubPRReviewComment matched by githubCommentId", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 46,
        title: "Deleted comment PR",
      });
      const comment = createComment({
        id: 555_666_777,
        body: "This comment will be deleted",
        path: "src/delete.ts",
        line: 30,
      });

      const event: PullRequestReviewCommentDeletedEvent = {
        action: "deleted",
        comment,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-delete",
      });

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-delete",
        workstreamId: "ws-uuid-delete",
      });

      // Mock deleteMany returns count of deleted records
      mockTx.gitHubPRReviewComment.deleteMany.mockResolvedValue({ count: 1 });

      await handlePullRequestReviewComment(event);

      // Verify deleteMany was called with String githubCommentId
      expect(mockTx.gitHubPRReviewComment.deleteMany).toHaveBeenCalledWith({
        where: {
          githubCommentId: String(555_666_777),
        },
      });

      // No workstream event is created for deleted action
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });
  });

  describe("unknown repository", () => {
    it("returns without error when repository is not found", async () => {
      const repository = createRepository(999);
      const pullRequest = createPullRequest({
        number: 50,
        title: "Unknown repo PR",
      });
      const comment = createComment({
        id: 123,
        body: "Test comment",
      });

      const event: PullRequestReviewCommentCreatedEvent = {
        action: "created",
        comment,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      // Mock repository not found
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

      await handlePullRequestReviewComment(event);

      // Should not attempt to find PR or create comment
      expect(mockTx.gitHubPullRequest.findUnique).not.toHaveBeenCalled();
      expect(mockTx.gitHubPRReviewComment.upsert).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });
  });

  describe("unknown pull request", () => {
    it("returns without error when PR is not found in database", async () => {
      const repository = createRepository(333);
      const pullRequest = createPullRequest({
        number: 51,
        title: "Unknown PR",
      });
      const comment = createComment({
        id: 456,
        body: "Test comment",
      });

      const event: PullRequestReviewCommentCreatedEvent = {
        action: "created",
        comment,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      // Repository exists
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-exists",
      });

      // PR not found
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue(null);

      await handlePullRequestReviewComment(event);

      // Should not attempt to create comment or event
      expect(mockTx.gitHubPRReviewComment.upsert).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });
  });

  describe("unsupported actions", () => {
    it("skips DB queries for unsupported action types", async () => {
      const repository = createRepository(444);
      const pullRequest = createPullRequest({
        number: 52,
        title: "Test PR",
      });
      const comment = createComment({
        id: 789,
        body: "Test comment",
      });

      // Create an event with unsupported action
      const event = {
        action: "resolved",
        comment,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      await handlePullRequestReviewComment(event);

      // Should not query DB at all
      expect(
        mockTx.gitHubInstallationRepository.findFirst
      ).not.toHaveBeenCalled();
      expect(mockTx.gitHubPullRequest.findUnique).not.toHaveBeenCalled();
      expect(mockTx.gitHubPRReviewComment.upsert).not.toHaveBeenCalled();
      expect(mockTx.gitHubPRReviewComment.updateMany).not.toHaveBeenCalled();
      expect(mockTx.gitHubPRReviewComment.deleteMany).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });
  });
});
