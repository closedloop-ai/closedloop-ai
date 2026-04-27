/**
 * Unit tests for GitHub pull_request_review webhook handler.
 *
 * Tests the handlePullRequestReview function which processes PR review events:
 * - submitted (approved/changes_requested) → Upserts per-reviewer record, recomputes aggregate
 * - dismissed → Sets reviewer to DISMISSED, recomputes aggregate
 * - Priority-based aggregate decision logic (CHANGES_REQUESTED > APPROVED > COMMENTED, DISMISSED filtered)
 * - Multi-reviewer scenarios (approval recovery, re-submit after dismissal)
 * - Missing repository/PR → Graceful early exit
 */

import type {
  PullRequestReviewDismissedEvent,
  PullRequestReviewSubmittedEvent,
} from "@octokit/webhooks-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbTx as setupMockWithDbTx } from "../utils/db-helpers";

// Mock modules before importing
vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PULL_REQUEST: "PULL_REQUEST",
    DEPLOYMENT: "DEPLOYMENT",
  },
  withDb: vi.fn(),
}));

// Import after mocking
import { handlePullRequestReview } from "@/app/webhooks/github/handlers/pull-request-review-handler";
import {
  createPullRequest,
  createRepository,
  createReview,
  createSender,
} from "../fixtures/github-webhook-fixtures";
import { makePrDetailRow } from "../utils/pr-detail-helpers";

// Mock database transaction client
let mockTx: any;

describe("handlePullRequestReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up transaction mock
    mockTx = {
      gitHubInstallationRepository: {
        findFirst: vi.fn(),
      },
      pullRequestDetail: {
        findUnique: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      gitHubPRReview: {
        upsert: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
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

  describe("submitted action with APPROVED state", () => {
    it("updates reviewDecision to APPROVED and creates GITHUB_PR_REVIEW_SUBMITTED event", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 42,
        title: "Add feature X",
      });
      const review = createReview({
        id: 1,
        state: "approved",
        body: "Looks good to me!",
      });

      const event: PullRequestReviewSubmittedEvent = {
        action: "submitted",
        review,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
      });

      // PR detail lookup with null reviewDecision initially
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-456",
          reviewDecision: null,
          workstreamId: "ws-uuid-789",
          linkedDoc: { id: "artifact-doc-123", slug: "plan-feature-x" },
        })
      );

      // Mock per-reviewer review query (after upsert, this reviewer's APPROVED is the only review)
      mockTx.gitHubPRReview.findMany.mockResolvedValue([{ state: "APPROVED" }]);

      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReview(event);

      expect(
        mockTx.gitHubInstallationRepository.findFirst
      ).toHaveBeenCalledWith({
        where: { githubRepoId: "789" },
        select: { id: true },
      });

      expect(mockTx.pullRequestDetail.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            repositoryId_number: {
              repositoryId: "repo-uuid-123",
              number: 42,
            },
          },
        })
      );

      // Verify per-reviewer upsert
      expect(mockTx.gitHubPRReview.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            pullRequestId_authorLogin: {
              pullRequestId: "artifact-pr-456",
              authorLogin: "reviewer",
            },
          },
          create: expect.objectContaining({
            pullRequestId: "artifact-pr-456",
            authorLogin: "reviewer",
            state: "APPROVED",
          }),
          update: expect.objectContaining({
            state: "APPROVED",
          }),
        })
      );

      // Aggregate PR detail update with APPROVED decision (via recomputeAndUpdateAggregate)
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { artifactId: "artifact-pr-456" },
        data: { reviewDecision: "APPROVED" },
      });

      // Verify workstream event creation
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: {
          workstreamId: "ws-uuid-789",
          type: "GITHUB_PR_REVIEW_SUBMITTED",
          actorType: "system",
          data: {
            reviewId: 1,
            reviewState: "approved",
            reviewDecision: "APPROVED",
            reviewerLogin: "reviewer",
            reviewBody: "Looks good to me!",
            prNumber: 42,
            prTitle: "Add feature X",
            prUrl: "https://github.com/owner/test-repo/pull/1",
            reviewUrl:
              "https://github.com/owner/test-repo/pull/1#pullrequestreview-1",
            documentId: "artifact-doc-123",
            documentSlug: "plan-feature-x",
          },
        },
      });
    });
  });

  describe("submitted action with CHANGES_REQUESTED state", () => {
    it("updates reviewDecision to CHANGES_REQUESTED and creates workstream event", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 43,
        title: "Fix bug Y",
      });
      const review = createReview({
        id: 2,
        state: "changes_requested",
        body: "Please fix the typo",
      });

      const event: PullRequestReviewSubmittedEvent = {
        action: "submitted",
        review,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-789",
          reviewDecision: null,
          workstreamId: "ws-uuid-abc",
          linkedDoc: null,
        })
      );

      mockTx.gitHubPRReview.findMany.mockResolvedValue([
        { state: "CHANGES_REQUESTED" },
      ]);
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReview(event);

      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { artifactId: "artifact-pr-789" },
        data: { reviewDecision: "CHANGES_REQUESTED" },
      });

      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: {
          workstreamId: "ws-uuid-abc",
          type: "GITHUB_PR_REVIEW_SUBMITTED",
          actorType: "system",
          data: {
            reviewId: 2,
            reviewState: "changes_requested",
            reviewDecision: "CHANGES_REQUESTED",
            reviewerLogin: "reviewer",
            reviewBody: "Please fix the typo",
            prNumber: 43,
            prTitle: "Fix bug Y",
            prUrl: "https://github.com/owner/test-repo/pull/1",
            reviewUrl:
              "https://github.com/owner/test-repo/pull/1#pullrequestreview-2",
            documentId: null,
            documentSlug: undefined,
          },
        },
      });
    });
  });

  describe("dismissed action", () => {
    it("sets reviewer to DISMISSED and recomputes aggregate from remaining active reviews", async () => {
      const repository = createRepository(123);
      const pullRequest = createPullRequest({
        number: 45,
        title: "Update docs",
      });
      const review = createReview({
        id: 4,
        state: "dismissed",
        body: "No longer relevant",
      });

      const event: PullRequestReviewDismissedEvent = {
        action: "dismissed",
        review,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-dismiss",
      });

      // PR detail has existing CHANGES_REQUESTED decision
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-dismiss",
          reviewDecision: "CHANGES_REQUESTED",
          workstreamId: "ws-uuid-dismiss",
          linkedDoc: { id: "artifact-doc-dismiss", slug: "plan-docs" },
        })
      );

      mockTx.gitHubPRReview.findMany.mockResolvedValue([
        { state: "DISMISSED" },
      ]);

      await handlePullRequestReview(event);

      // Should upsert per-reviewer record to DISMISSED
      expect(mockTx.gitHubPRReview.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            pullRequestId_authorLogin: {
              pullRequestId: "artifact-pr-dismiss",
              authorLogin: "reviewer",
            },
          },
          update: { state: "DISMISSED" },
        })
      );

      // Aggregate should be null (no active reviews after dismissal)
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { artifactId: "artifact-pr-dismiss" },
        data: { reviewDecision: null },
      });

      // Should create workstream event for dismissed review
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workstreamId: "ws-uuid-dismiss",
          type: "GITHUB_PR_REVIEW_SUBMITTED",
          data: expect.objectContaining({
            reviewState: "dismissed",
            reviewDecision: "DISMISSED",
            reviewerLogin: "reviewer",
          }),
        }),
      });
    });
  });

  describe("priority-based aggregate review decision logic", () => {
    it("aggregate should be CHANGES_REQUESTED when one reviewer has CHANGES_REQUESTED and another COMMENTED", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 46,
        title: "Test priority",
      });
      const review = createReview({
        id: 5,
        state: "commented",
        body: "Just a comment",
      });

      const event: PullRequestReviewSubmittedEvent = {
        action: "submitted",
        review,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-priority",
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-priority",
          reviewDecision: "CHANGES_REQUESTED",
          workstreamId: "ws-uuid-priority",
          linkedDoc: null,
        })
      );

      // After upsert: reviewer-A has CHANGES_REQUESTED, reviewer (current) has COMMENTED
      mockTx.gitHubPRReview.findMany.mockResolvedValue([
        { state: "CHANGES_REQUESTED" },
        { state: "COMMENTED" },
      ]);
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReview(event);

      // Per-reviewer upsert happens
      expect(mockTx.gitHubPRReview.upsert).toHaveBeenCalled();

      // Aggregate should be CHANGES_REQUESTED (highest priority across all reviewers)
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { artifactId: "artifact-pr-priority" },
        data: { reviewDecision: "CHANGES_REQUESTED" },
      });

      // Still creates workstream event
      expect(mockTx.workstreamEvent.create).toHaveBeenCalled();
    });

    it("dismissed review is excluded from aggregate, remaining reviewer's state wins", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 48,
        title: "Test dismissed filtering",
      });
      const review = createReview({
        id: 7,
        state: "dismissed",
        body: "Dismissed",
      });

      const event: PullRequestReviewDismissedEvent = {
        action: "dismissed",
        review,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-dismiss-priority",
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-dismiss-priority",
          reviewDecision: "CHANGES_REQUESTED",
          workstreamId: "ws-uuid-dismiss-priority",
          linkedDoc: null,
        })
      );

      mockTx.gitHubPRReview.findMany.mockResolvedValue([
        { state: "DISMISSED" },
        { state: "CHANGES_REQUESTED" },
      ]);

      await handlePullRequestReview(event);

      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { artifactId: "artifact-pr-dismiss-priority" },
        data: { reviewDecision: "CHANGES_REQUESTED" },
      });
    });

    it("re-submitted review after dismissal updates per-reviewer record and recomputes aggregate", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 49,
        title: "Test resubmit after dismiss",
      });
      const review = createReview({
        id: 8,
        state: "changes_requested",
        body: "Actually, changes needed",
      });

      const event: PullRequestReviewSubmittedEvent = {
        action: "submitted",
        review,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-resubmit",
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-resubmit",
          reviewDecision: "DISMISSED",
          workstreamId: "ws-uuid-resubmit",
          linkedDoc: null,
        })
      );

      mockTx.gitHubPRReview.findMany.mockResolvedValue([
        { state: "CHANGES_REQUESTED" },
      ]);
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReview(event);

      expect(mockTx.gitHubPRReview.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            state: "CHANGES_REQUESTED",
          }),
        })
      );

      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { artifactId: "artifact-pr-resubmit" },
        data: { reviewDecision: "CHANGES_REQUESTED" },
      });

      expect(mockTx.workstreamEvent.create).toHaveBeenCalled();
    });
  });

  describe("missing repository", () => {
    it("returns without error when repository is not found", async () => {
      const repository = createRepository(999);
      const pullRequest = createPullRequest({
        number: 50,
        title: "Unknown repo PR",
      });
      const review = createReview({
        id: 9,
        state: "approved",
      });

      const event: PullRequestReviewSubmittedEvent = {
        action: "submitted",
        review,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

      await handlePullRequestReview(event);

      expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
      expect(mockTx.pullRequestDetail.update).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });
  });

  describe("missing pull request", () => {
    it("returns without error when PR is not found in database", async () => {
      const repository = createRepository(333);
      const pullRequest = createPullRequest({
        number: 51,
        title: "Unknown PR",
      });
      const review = createReview({
        id: 10,
        state: "approved",
      });

      const event: PullRequestReviewSubmittedEvent = {
        action: "submitted",
        review,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-exists",
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);

      await handlePullRequestReview(event);

      expect(mockTx.pullRequestDetail.update).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });
  });

  describe("multi-reviewer scenarios", () => {
    it("Reviewer B then approves → aggregate = APPROVED (all approved)", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 61,
        title: "Multi-reviewer approval",
      });
      const review = createReview({
        id: 21,
        state: "approved",
        body: "Fixed, LGTM",
        user: { login: "reviewer-b", id: 200 },
      });

      const event: PullRequestReviewSubmittedEvent = {
        action: "submitted",
        review,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-multi2",
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-multi2",
          reviewDecision: "CHANGES_REQUESTED",
          workstreamId: "ws-uuid-multi2",
          linkedDoc: null,
        })
      );

      mockTx.gitHubPRReview.findMany.mockResolvedValue([
        { state: "APPROVED" },
        { state: "APPROVED" },
      ]);
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReview(event);

      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { artifactId: "artifact-pr-multi2" },
        data: { reviewDecision: "APPROVED" },
      });
    });

    it("upserts per-reviewer record with correct authorLogin", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 63,
        title: "Upsert key test",
      });
      const review = createReview({
        id: 23,
        state: "approved",
        body: "LGTM",
        user: { login: "specific-reviewer", id: 400 },
      });

      const event: PullRequestReviewSubmittedEvent = {
        action: "submitted",
        review,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-upsert",
      });

      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-upsert",
          reviewDecision: null,
          workstreamId: "ws-uuid-upsert",
          linkedDoc: null,
        })
      );

      mockTx.gitHubPRReview.findMany.mockResolvedValue([{ state: "APPROVED" }]);
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReview(event);

      expect(mockTx.gitHubPRReview.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            pullRequestId_authorLogin: {
              pullRequestId: "artifact-pr-upsert",
              authorLogin: "specific-reviewer",
            },
          },
          create: expect.objectContaining({
            pullRequestId: "artifact-pr-upsert",
            authorLogin: "specific-reviewer",
            state: "APPROVED",
            githubReviewId: "23",
          }),
          update: expect.objectContaining({
            state: "APPROVED",
            githubReviewId: "23",
          }),
        })
      );
    });
  });
});
