/**
 * Unit tests for GitHub pull_request_review_comment webhook handler.
 *
 * Tests the handlePullRequestReviewComment function which processes review comment events:
 * - created / edited → one review-thread upsert event through applyExternal
 * - created with null reviewId → Handles missing pull_request_review_id
 * - deleted → one comment-delete event through applyExternal
 * - Unknown repository/PR → Graceful early exit
 * - Unsupported actions → Skips before DB queries
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverGitHubWebhook } from "../support/webhooks/github/github-webhook-route-delivery.test-helpers";
import { mockWithDbTx as setupMockWithDbTx } from "../utils/db-helpers";

const { mockApplyExternal, nextHeaders } = vi.hoisted(() => ({
  mockApplyExternal: vi.fn(),
  nextHeaders: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: nextHeaders }));

// Mock modules before importing
// The real enums: the unsupported-action and null-review-id cases go through
// the route, whose import graph reaches every handler's enums.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withDb: vi.fn(),
}));

vi.mock("@/app/comments/service", () => ({
  commentsService: { applyExternal: mockApplyExternal },
}));

vi.mock("@/app/webhooks/github/handlers/branch-activity-producer", () => ({
  GitHubBranchActivityEventName: {
    PullRequestReviewComment: "pull_request_review_comment",
  },
  persistGitHubBranchActivity: vi.fn().mockResolvedValue({
    status: "persisted",
    persistenceStatus: "inserted",
  }),
}));

// Import after mocking
import { CommentSyncProvider } from "@repo/api/src/types/comment-thread-dto";
import {
  ApplyExternalOutcome,
  GitHubExternalEventKind,
} from "@/app/comments/service/github/apply-external-events";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "@/app/webhooks/github/handlers/branch-activity-producer";
import { handlePullRequestReviewComment } from "@/app/webhooks/github/handlers/pull-request-review-comment-handler";
import {
  createPullRequest,
  createPullRequestReviewCommentCreatedEvent,
  createPullRequestReviewCommentDeletedEvent,
  createPullRequestReviewCommentEditedEvent,
  createRepository,
  createReviewComment,
  createSender as createUserSender,
} from "../fixtures/github-webhook-fixtures";
import { makePrDetailRow } from "../utils/pr-detail-helpers";

// Mock database transaction client
let mockTx: ReturnType<typeof createReviewCommentTx>;
const mockPersistGitHubBranchActivity =
  persistGitHubBranchActivity as ReturnType<typeof vi.fn>;

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
    mockTx = createReviewCommentTx();
    mockExternalAuthorResolution();
    mockApplyExternal.mockResolvedValue(applied(ApplyExternalOutcome.Applied));

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

      const event = createPullRequestReviewCommentCreatedEvent(
        comment,
        pullRequest,
        { repository, sender: createSender() }
      );

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

      await handlePullRequestReviewComment(event, {
        deliveryId: "review-comment-delivery-1",
        observedAt: new Date("2026-08-12T14:00:00.000Z"),
      });

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
            removedAt: null,
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

      expect(mockApplyExternal).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: CommentSyncProvider.Github,
          organizationId: "org-uuid-123",
          branchArtifactId: "artifact-pr-456",
          pullRequestDetailId: "artifact-pr-456",
        })
      );
      expect(appliedEvent()).not.toHaveProperty("threadFieldsFromReply");
      expect(appliedEvent()).not.toHaveProperty("legacyState");
      expect(appliedEvent()).not.toHaveProperty("resolutionStatus");
      expect(appliedEvent()).toEqual(
        expect.objectContaining({
          kind: GitHubExternalEventKind.ReviewThreadUpsert,
          reviewThreadId: null,
          rootCommentId: 123_456_789,
          reviewId: "555",
          position: expect.objectContaining({
            path: "src/feature.ts",
            line: 15,
          }),
          comments: [
            expect.objectContaining({
              githubCommentId: 123_456_789,
              bodyMarkdown: "This looks good!",
              author: expect.objectContaining({
                id: 99_999,
                login: "reviewer",
              }),
            }),
          ],
        })
      );

      expect(mockPersistGitHubBranchActivity).toHaveBeenCalledWith({
        eventName: GitHubBranchActivityEventName.PullRequestReviewComment,
        deliveryId: "review-comment-delivery-1",
        payload: event,
        attribution: {
          organizationId: "org-uuid-123",
          branchArtifactId: "artifact-pr-456",
          pullRequestDetailId: "artifact-pr-456",
        },
      });

      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });

    it("records activity but skips projection for a non-current associated PR", async () => {
      const event = createPullRequestReviewCommentCreatedEvent(
        createComment({
          id: 123_456_790,
          body: "Older PR comment",
          path: "src/feature.ts",
          line: 16,
          pull_request_review_id: 556,
        }),
        createPullRequest({ number: 42 }),
        { repository: createRepository(789), sender: createSender() }
      );
      const prDetail = makePrDetailRow({
        artifactId: "artifact-pr-older",
        branchArtifactId: "branch-artifact-1",
        currentPullRequestDetailId: "artifact-pr-current",
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-123",
        prDetail,
      });

      await handlePullRequestReviewComment(event, {
        deliveryId: "review-comment-older-associated-pr",
        observedAt: new Date("2026-08-12T14:00:00.000Z"),
      });

      expect(mockApplyExternal).not.toHaveBeenCalled();
      expect(mockPersistGitHubBranchActivity).toHaveBeenCalledWith({
        eventName: GitHubBranchActivityEventName.PullRequestReviewComment,
        deliveryId: "review-comment-older-associated-pr",
        payload: event,
        attribution: {
          organizationId: "org-uuid-123",
          branchArtifactId: "branch-artifact-1",
          pullRequestDetailId: "artifact-pr-older",
        },
      });
    });

    it("marks a reply delivery so its review id, URL and position never rewrite the root's", async () => {
      const comment = {
        ...createComment({
          id: 123_456_790,
          body: "Agreed",
          pull_request_review_id: 556,
        }),
        in_reply_to_id: 123_456_789,
      };
      const event = createPullRequestReviewCommentCreatedEvent(
        comment,
        createPullRequest({ number: 42 }),
        { repository: createRepository(789), sender: createSender() }
      );
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-123",
        prDetail: makePrDetailRow({
          artifactId: "artifact-pr-456",
          workstreamId: "ws-uuid-789",
          linkedDoc: null,
        }),
      });

      await handlePullRequestReviewComment(event);

      expect(appliedEvent()).toEqual(
        expect.objectContaining({
          kind: GitHubExternalEventKind.ReviewThreadUpsert,
          rootCommentId: 123_456_789,
          threadFieldsFromReply: true,
        })
      );
    });

    it("hands each duplicate created review comment delivery to applyExternal and emits no workstream event", async () => {
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
      const event = createPullRequestReviewCommentCreatedEvent(
        comment,
        pullRequest,
        { repository, sender: createSender() }
      );
      const prDetail = makePrDetailRow({
        artifactId: "artifact-pr-456",
        workstreamId: "ws-uuid-789",
        linkedDoc: { id: "artifact-doc-123", slug: "plan-feature-x" },
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-123",
        prDetail,
      });
      mockApplyExternal
        .mockResolvedValueOnce(applied(ApplyExternalOutcome.Applied))
        .mockResolvedValueOnce(applied(ApplyExternalOutcome.Unchanged));

      await Promise.all([
        handlePullRequestReviewComment(event),
        handlePullRequestReviewComment(event),
      ]);

      expect(mockApplyExternal).toHaveBeenCalledTimes(2);
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
      const event = createPullRequestReviewCommentCreatedEvent(
        comment,
        pullRequest,
        { repository, sender: createSender() }
      );
      const prDetail = makePrDetailRow({
        artifactId: "artifact-pr-456",
        workstreamId: "ws-uuid-789",
        linkedDoc: { id: "artifact-doc-123", slug: "plan-feature-x" },
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-123",
        prDetail,
      });
      mockApplyExternal.mockResolvedValueOnce(
        applied(ApplyExternalOutcome.Unchanged)
      );

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
      const event = createPullRequestReviewCommentCreatedEvent(
        comment,
        pullRequest,
        { repository, sender: createSender() }
      );
      const prDetail = makePrDetailRow({
        artifactId: "artifact-pr-456",
        workstreamId: "ws-uuid-789",
        linkedDoc: { id: "artifact-doc-123", slug: "plan-feature-x" },
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-123",
        prDetail,
      });
      mockApplyExternal.mockResolvedValueOnce(
        applied(ApplyExternalOutcome.NoWrite)
      );

      const response = await handlePullRequestReviewComment(event);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        message: "Event processed successfully",
      });
      expect(mockApplyExternal).toHaveBeenCalledTimes(1);
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

      const event = createPullRequestReviewCommentCreatedEvent(
        comment,
        pullRequest,
        { repository, sender: createSender() }
      );

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

      expect(mockApplyExternal).toHaveBeenCalledWith(
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
      });
      const event = createPullRequestReviewCommentCreatedEvent(
        comment,
        pullRequest,
        { repository, sender: createSender() }
      );

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

      // GitHub's REST schema declares the review id nullable; the Octokit type
      // does not, so the null arrives through the route's raw body.
      await deliverGitHubWebhook(nextHeaders, {
        eventType: "pull_request_review_comment",
        payload: {
          ...event,
          comment: { ...comment, pull_request_review_id: null },
        },
      });

      expect(appliedEvent()).toEqual(
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

      const event = createPullRequestReviewCommentEditedEvent(
        comment,
        pullRequest,
        { repository, sender: createSender() },
        {
          body: {
            from: "Original comment text",
          },
        }
      );

      const prDetail = makePrDetailRow({
        artifactId: "artifact-pr-789",
        workstreamId: "ws-uuid-abc",
        linkedDoc: null,
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-456",
        prDetail,
      });
      await handlePullRequestReviewComment(event);

      expect(appliedEvent()).toEqual(
        expect.objectContaining({
          kind: GitHubExternalEventKind.ReviewThreadUpsert,
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
      const event = createPullRequestReviewCommentEditedEvent(
        comment,
        pullRequest,
        { repository, sender: createSender() },
        {
          body: {
            from: "Original comment text",
          },
        }
      );
      const prDetail = makePrDetailRow({
        artifactId: "artifact-pr-789",
        workstreamId: "ws-uuid-abc",
        linkedDoc: null,
      });
      mockOwnerResolutionSuccess({
        repositoryRecordId: "repo-uuid-456",
        prDetail,
      });
      mockApplyExternal.mockResolvedValueOnce(
        applied(ApplyExternalOutcome.NoWrite)
      );

      const response = await handlePullRequestReviewComment(event);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        message: "Event processed successfully",
      });
      expect(mockApplyExternal).toHaveBeenCalledTimes(1);
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

      const event = createPullRequestReviewCommentDeletedEvent(
        comment,
        pullRequest,
        { repository, sender: createSender() }
      );

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

      expect(appliedEvent()).toEqual(
        expect.objectContaining({
          kind: GitHubExternalEventKind.CommentDelete,
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

      const event = createPullRequestReviewCommentCreatedEvent(
        comment,
        pullRequest,
        { repository, sender: createSender() }
      );

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
      expect(mockApplyExternal).not.toHaveBeenCalled();
      expect(mockPersistGitHubBranchActivity).not.toHaveBeenCalled();
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

      const response = await handlePullRequestReviewComment(
        createPullRequestReviewCommentCreatedEvent(comment, pullRequest, {
          repository,
          sender: createSender(),
          installation: null,
        })
      );

      expect(response.status).toBe(400);
      expect(mockTx.gitHubInstallation.findMany).not.toHaveBeenCalled();
      expect(
        mockTx.gitHubInstallationRepository.findMany
      ).not.toHaveBeenCalled();
      expect(mockTx.pullRequestDetail.findMany).not.toHaveBeenCalled();
      expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
      expect(mockApplyExternal).not.toHaveBeenCalled();
      expect(mockPersistGitHubBranchActivity).not.toHaveBeenCalled();
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

      const event = createPullRequestReviewCommentCreatedEvent(
        comment,
        pullRequest,
        { repository, sender: createSender() }
      );

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

      // An action outside the handler's event type, so it arrives the way any
      // delivery does: through the route, which takes the raw body.
      const response = await deliverGitHubWebhook(nextHeaders, {
        eventType: "pull_request_review_comment",
        payload: {
          ...createPullRequestReviewCommentCreatedEvent(comment, pullRequest, {
            repository,
            sender: createSender(),
          }),
          action: "resolved",
        },
      });

      // The handler's own skip answer, so a delivery the route refused cannot
      // pass the absence assertions below.
      await expect(response.json()).resolves.toEqual({
        message:
          "Ignoring unhandled pull_request_review_comment action: resolved",
        ok: true,
      });
      // Should not query DB at all
      expect(mockTx.gitHubInstallation.findMany).not.toHaveBeenCalled();
      expect(
        mockTx.gitHubInstallationRepository.findMany
      ).not.toHaveBeenCalled();
      expect(mockTx.pullRequestDetail.findMany).not.toHaveBeenCalled();
      expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
      expect(mockApplyExternal).not.toHaveBeenCalled();
      expect(mockPersistGitHubBranchActivity).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });
  });
});

function createReviewCommentTx() {
  return {
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
}

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

function applied(outcome: ApplyExternalOutcome) {
  return {
    outcomes: [outcome],
    changedThreadIds:
      outcome === ApplyExternalOutcome.Applied ? ["thread-1"] : [],
  };
}

/** The first event the handler handed to `applyExternal`. */
function appliedEvent() {
  return mockApplyExternal.mock.calls[0]?.[0].events[0];
}
