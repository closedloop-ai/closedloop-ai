/**
 * Unit tests for GitHub pull_request_review_comment webhook handler.
 *
 * Tests the handlePullRequestReviewComment function which processes review comment events:
 * - created → Upserts unified GitHub projection + GITHUB_PR_COMMENT_ADDED workstream event (idempotent)
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

const {
  MockGitHubProjectionNoWriteError,
  mockSoftDeleteGitHubCommentByRemoteId,
  mockUpsertGitHubReviewCommentThread,
} = vi.hoisted(() => ({
  MockGitHubProjectionNoWriteError: class GitHubProjectionNoWriteError extends Error {
    readonly code: string;
    readonly details: Record<string, string | number | null>;

    constructor(code: string, details: Record<string, string | number | null>) {
      super(`GitHub comment projection no-write: ${code}`);
      this.name = "GitHubProjectionNoWriteError";
      this.code = code;
      this.details = details;
    }
  },
  mockSoftDeleteGitHubCommentByRemoteId: vi.fn(),
  mockUpsertGitHubReviewCommentThread: vi.fn(),
}));

// Mock modules before importing
vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  ExternalCommentProvider: { GITHUB: "GITHUB" },
  GitHubCommentThreadKind: {
    ISSUE_COMMENT: "ISSUE_COMMENT",
    REVIEW_THREAD: "REVIEW_THREAD",
  },
  GitHubInstallationStatus: {
    ACTIVE: "ACTIVE",
  },
  GitHubLegacyCommentState: {
    PENDING: "PENDING",
    ADDRESSED: "ADDRESSED",
    DISMISSED: "DISMISSED",
  },
  withDb: vi.fn(),
}));

vi.mock("@/app/comments/github-projection", () => ({
  GitHubProjectionNoWriteError: MockGitHubProjectionNoWriteError,
  softDeleteGitHubCommentByRemoteId: mockSoftDeleteGitHubCommentByRemoteId,
  upsertGitHubReviewCommentThread: mockUpsertGitHubReviewCommentThread,
}));

// Import after mocking
import { GitHubProjectionNoWriteError } from "@/app/comments/github-projection";
import { handlePullRequestReviewComment } from "@/app/webhooks/github/handlers/pull-request-review-comment-handler";
import {
  createPullRequest,
  createRepository,
  createReviewComment,
  createSender as createUserSender,
} from "../fixtures/github-webhook-fixtures";
import { makePrDetailRow } from "../utils/pr-detail-helpers";

// Mock database transaction client
let mockTx: any;

const REVIEWER_USER = {
  login: "reviewer",
  id: 99_999,
  avatar_url: "https://example.com/avatar.png",
};

// This handler's sender is the reviewer commenting on the PR, not the PR
// author. The fixture default sender is "test-user" (the PR author), so
// override with the reviewer identity at every call site.
function createSender() {
  return createUserSender(REVIEWER_USER);
}

const createComment = createReviewComment;

describe("handlePullRequestReviewComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up transaction mock
    mockTx = {
      gitHubInstallation: {
        findMany: vi.fn(),
      },
      gitHubInstallationRepository: {
        findMany: vi.fn(),
      },
      pullRequestDetail: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      gitHubCommentProjection: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      gitHubUserConnection: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      externalCommentAuthor: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn(),
      },
      user: {
        upsert: vi.fn(),
      },
      workstreamEvent: {
        create: vi.fn(),
      },
    };
    mockExternalAuthorResolution();
    mockUpsertGitHubReviewCommentThread.mockImplementation((_tx, input) =>
      Promise.resolve({
        threadId: "thread-1",
        commentIds: ["comment-1"],
        createdGithubCommentIds: input.comments.map((comment: any) =>
          String(comment.githubCommentId)
        ),
      })
    );
    mockSoftDeleteGitHubCommentByRemoteId.mockResolvedValue({
      comments: 1,
      threads: 1,
    });

    // Mock withDb.tx — all reads and writes happen in a single transaction
    setupMockWithDbTx(mockTx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("created action", () => {
    it("creates a unified review comment projection without emitting a workstream event", async () => {
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
        installation: { id: 99 },
      } as any;

      const prDetail = makePrDetailRow({
        artifactId: "artifact-pr-456",
        workstreamId: "ws-uuid-789",
        linkedDoc: { id: "artifact-doc-123", slug: "plan-feature-x" },
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-123",
        prDetail,
      });

      // Mock event creation
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReviewComment(event);

      expect(mockTx.gitHubInstallation.findMany).toHaveBeenCalledWith({
        where: { installationId: "99" },
        select: { id: true, organizationId: true, status: true },
        take: 2,
      });
      expect(mockTx.gitHubInstallationRepository.findMany).toHaveBeenCalledWith(
        {
          where: {
            installationId: "installation-uuid-99",
            githubRepoId: "789",
          },
          select: { id: true },
          take: 2,
        }
      );

      expect(mockTx.pullRequestDetail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            repositoryId: "repo-uuid-123",
            number: 42,
          },
        })
      );
      expect(mockTx.pullRequestDetail.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "artifact-pr-456" } })
      );

      expect(mockUpsertGitHubReviewCommentThread).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          organizationId: "org-uuid-123",
          branchArtifactId: "artifact-pr-456",
          pullRequestDetailId: "artifact-pr-456",
          rootCommentId: 123_456_789,
          reviewId: "555",
          path: "src/feature.ts",
          line: 15,
          comments: [
            expect.objectContaining({
              githubCommentId: 123_456_789,
              bodyMarkdown: "This looks good!",
              author: {
                userId: "shadow-99999",
                externalAuthorId: "external-author-99999",
              },
            }),
          ],
        })
      );

      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });

    it("dedupes duplicate created review comment deliveries via the upsert helper", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 42,
        title: "Add feature X",
      });
      const comment = createComment({
        id: 123_456_789,
        body: "This looks good!",
        path: "src/feature.ts",
        line: 15,
      });
      const event: PullRequestReviewCommentCreatedEvent = {
        action: "created",
        comment,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
        installation: { id: 99 },
      } as any;
      const prDetail = makePrDetailRow({
        artifactId: "artifact-pr-456",
        workstreamId: "ws-uuid-789",
        linkedDoc: { id: "artifact-doc-123", slug: "plan-feature-x" },
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-123",
        prDetail,
      });
      mockUpsertGitHubReviewCommentThread
        .mockResolvedValueOnce({
          threadId: "thread-1",
          commentIds: ["comment-1"],
          createdGithubCommentIds: ["123456789"],
        })
        .mockResolvedValueOnce({
          threadId: "thread-1",
          commentIds: ["comment-1"],
          createdGithubCommentIds: [],
        });

      await Promise.all([
        handlePullRequestReviewComment(event),
        handlePullRequestReviewComment(event),
      ]);

      expect(mockUpsertGitHubReviewCommentThread).toHaveBeenCalledTimes(2);
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });

    it("does not emit a workstream event when projection write reports an existing review comment", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 42,
        title: "Add feature X",
      });
      const comment = createComment({
        id: 123_456_789,
        body: "This looks good!",
        path: "src/feature.ts",
        line: 15,
      });
      const event: PullRequestReviewCommentCreatedEvent = {
        action: "created",
        comment,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
        installation: { id: 99 },
      } as any;
      const prDetail = makePrDetailRow({
        artifactId: "artifact-pr-456",
        workstreamId: "ws-uuid-789",
        linkedDoc: { id: "artifact-doc-123", slug: "plan-feature-x" },
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-123",
        prDetail,
      });
      mockUpsertGitHubReviewCommentThread.mockResolvedValueOnce({
        threadId: "thread-1",
        commentIds: ["comment-1"],
        createdGithubCommentIds: [],
      });

      await handlePullRequestReviewComment(event);

      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });

    it("bounds typed projection no-write errors without emitting a workstream event", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 42,
        title: "Add feature X",
      });
      const comment = createComment({
        id: 123_456_789,
        body: "This looks good!",
        path: "src/feature.ts",
        line: 15,
      });
      const event: PullRequestReviewCommentCreatedEvent = {
        action: "created",
        comment,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
        installation: { id: 99 },
      } as any;
      const prDetail = makePrDetailRow({
        artifactId: "artifact-pr-456",
        workstreamId: "ws-uuid-789",
        linkedDoc: { id: "artifact-doc-123", slug: "plan-feature-x" },
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-123",
        prDetail,
      });
      mockUpsertGitHubReviewCommentThread.mockRejectedValueOnce(
        new GitHubProjectionNoWriteError("ambiguous_thread_projection", {
          branchArtifactId: "artifact-pr-456",
          pullRequestDetailId: "artifact-pr-456",
          rootCommentId: 123_456_789,
          reviewThreadId: null,
        })
      );

      const response = await handlePullRequestReviewComment(event);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        message: "Event processed successfully",
      });
      expect(mockUpsertGitHubReviewCommentThread).toHaveBeenCalledTimes(1);
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });

    it("stores review comments under PullRequestDetail.id while using branch artifact linkage", async () => {
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
        installation: { id: 99 },
      } as any;

      const prDetail = makePrDetailRow({
        id: "pr-detail-current",
        artifactId: "legacy-pr-artifact",
        branchArtifactId: "branch-artifact-1",
        workstreamId: "branch-workstream",
        branchTargetLinks: [
          { source: { id: "branch-doc", slug: "plan-feature-x" } },
        ],
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-123",
        prDetail,
      });
      await handlePullRequestReviewComment(event);

      expect(mockUpsertGitHubReviewCommentThread).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          branchArtifactId: "branch-artifact-1",
          pullRequestDetailId: "pr-detail-current",
        })
      );
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
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
        installation: { id: 99 },
      } as any;

      const prDetail = makePrDetailRow({
        artifactId: "artifact-pr",
        workstreamId: "ws-uuid",
        linkedDoc: null,
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid",
        prDetail,
      });
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReviewComment(event);

      expect(mockUpsertGitHubReviewCommentThread).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          reviewId: null,
        })
      );
    });
  });

  describe("edited action", () => {
    it("updates the unified review comment projection matched by githubCommentId", async () => {
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
        installation: { id: 99 },
        changes: {
          body: {
            from: "Original comment text",
          },
        },
      } as any;

      const prDetail = makePrDetailRow({
        artifactId: "artifact-pr-789",
        workstreamId: "ws-uuid-abc",
        linkedDoc: null,
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-456",
        prDetail,
      });
      mockUpsertGitHubReviewCommentThread.mockResolvedValueOnce({
        threadId: "thread-1",
        commentIds: ["comment-1"],
        createdGithubCommentIds: [],
      });

      await handlePullRequestReviewComment(event);

      expect(mockUpsertGitHubReviewCommentThread).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          rootCommentId: 222_333_444,
          comments: [
            expect.objectContaining({
              githubCommentId: 222_333_444,
              bodyMarkdown: "Updated comment text",
            }),
          ],
        })
      );

      // No workstream event is created for edited action
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });

    it("bounds typed projection no-write errors without emitting a workstream event", async () => {
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
        installation: { id: 99 },
        changes: {
          body: {
            from: "Original comment text",
          },
        },
      } as any;
      const prDetail = makePrDetailRow({
        artifactId: "artifact-pr-789",
        workstreamId: "ws-uuid-abc",
        linkedDoc: null,
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-456",
        prDetail,
      });
      mockUpsertGitHubReviewCommentThread.mockRejectedValueOnce(
        new GitHubProjectionNoWriteError("external_id_conflict", {
          branchArtifactId: "artifact-pr-789",
          githubCommentId: 222_333_444,
          pullRequestDetailId: "artifact-pr-789",
        })
      );

      const response = await handlePullRequestReviewComment(event);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        message: "Event processed successfully",
      });
      expect(mockUpsertGitHubReviewCommentThread).toHaveBeenCalledTimes(1);
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });
  });

  describe("deleted action", () => {
    it("soft-deletes unified review comment projection matched by githubCommentId", async () => {
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
        installation: { id: 99 },
      } as any;

      const prDetail = makePrDetailRow({
        artifactId: "artifact-pr-delete",
        workstreamId: "ws-uuid-delete",
        linkedDoc: null,
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-delete",
        prDetail,
      });

      await handlePullRequestReviewComment(event);

      expect(mockSoftDeleteGitHubCommentByRemoteId).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          githubCommentId: 555_666_777,
        })
      );

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
        installation: { id: 99 },
      } as any;

      mockTx.gitHubInstallation.findMany.mockResolvedValue([
        {
          id: "installation-uuid-99",
          organizationId: "org-uuid-123",
          status: "ACTIVE",
        },
      ]);
      mockTx.gitHubInstallationRepository.findMany.mockResolvedValue([]);

      await handlePullRequestReviewComment(event);

      // Should not attempt to find PR or create comment
      expect(mockTx.pullRequestDetail.findMany).not.toHaveBeenCalled();
      expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });
  });

  describe("missing installation", () => {
    it("returns 400 before database reads or writes", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 53,
        title: "Missing installation PR",
      });
      const comment = createComment({
        id: 987,
        body: "Test comment",
      });

      const response = await handlePullRequestReviewComment({
        action: "created",
        comment,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any);

      expect(response.status).toBe(400);
      expect(mockTx.gitHubInstallation.findMany).not.toHaveBeenCalled();
      expect(
        mockTx.gitHubInstallationRepository.findMany
      ).not.toHaveBeenCalled();
      expect(mockTx.pullRequestDetail.findMany).not.toHaveBeenCalled();
      expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
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
        installation: { id: 99 },
      } as any;

      mockTx.gitHubInstallation.findMany.mockResolvedValue([
        {
          id: "installation-uuid-99",
          organizationId: "org-uuid-123",
          status: "ACTIVE",
        },
      ]);
      mockTx.gitHubInstallationRepository.findMany.mockResolvedValue([
        { id: "repo-uuid-exists" },
      ]);
      mockTx.pullRequestDetail.findMany.mockResolvedValue([]);

      await handlePullRequestReviewComment(event);

      // Should not attempt to create comment or event
      expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
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
        installation: { id: 99 },
      } as any;

      await handlePullRequestReviewComment(event);

      // Should not query DB at all
      expect(mockTx.gitHubInstallation.findMany).not.toHaveBeenCalled();
      expect(
        mockTx.gitHubInstallationRepository.findMany
      ).not.toHaveBeenCalled();
      expect(mockTx.pullRequestDetail.findMany).not.toHaveBeenCalled();
      expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });
  });
});

function mockOwnerResolutionSuccess({
  organizationId = "org-uuid-123",
  installationRecordId = "installation-uuid-99",
  repositoryRecordId = "repo-uuid-123",
  prDetail,
}: {
  organizationId?: string;
  installationRecordId?: string;
  repositoryRecordId?: string;
  prDetail: ReturnType<typeof makePrDetailRow>;
}) {
  mockTx.gitHubInstallation.findMany.mockResolvedValue([
    {
      id: installationRecordId,
      organizationId,
      status: "ACTIVE",
    },
  ]);
  mockTx.gitHubInstallationRepository.findMany.mockResolvedValue([
    { id: repositoryRecordId },
  ]);
  mockTx.pullRequestDetail.findMany.mockResolvedValue([
    {
      id: prDetail.id,
      branchArtifactId: prDetail.branchArtifactId,
      branchArtifact: { organizationId },
    },
  ]);
  mockTx.pullRequestDetail.findUnique.mockResolvedValue(prDetail);
}

function mockExternalAuthorResolution() {
  mockTx.user.upsert.mockResolvedValue({
    id: "shadow-99999",
    clerkId: "github-shadow:org-uuid-123:99999",
    organizationId: "org-uuid-123",
    active: false,
    email: "github-shadow+org-uuid-123+99999@invalid.closedloop.local",
    firstName: "reviewer",
    lastName: "GitHub",
    avatarUrl: "https://example.com/avatar.png",
    githubUsername: "reviewer",
  });
  mockTx.externalCommentAuthor.upsert.mockResolvedValue({
    id: "external-author-99999",
    organizationId: "org-uuid-123",
    provider: "GITHUB",
    providerUserId: "99999",
    providerNodeId: "U_99999",
    providerLogin: "reviewer",
    normalizedProviderLogin: "reviewer",
    displayName: "reviewer",
    avatarUrl: "https://example.com/avatar.png",
    profileUrl: "",
    userId: "shadow-99999",
    user: {
      id: "shadow-99999",
      clerkId: "github-shadow:org-uuid-123:99999",
      organizationId: "org-uuid-123",
      active: false,
      email: "github-shadow+org-uuid-123+99999@invalid.closedloop.local",
      firstName: "reviewer",
      lastName: "GitHub",
      avatarUrl: "https://example.com/avatar.png",
      githubUsername: "reviewer",
    },
  });
}
