/**
 * Unit tests for GitHub pull_request_review webhook handler.
 *
 * Tests the handlePullRequestReview function which processes PR review events:
 * - submitted (approved/changes_requested) → Upserts per-reviewer record, recomputes aggregate
 * - dismissed → Sets reviewer to DISMISSED, recomputes aggregate
 * - review summary bodies → one REVIEW_SUMMARY upsert through applyExternal
 *   on submitted and edited; a delete when an edit clears the body; none on
 *   dismissed, a blank submitted body, or a non-current pull request
 *   (PLN-2122 decision 6)
 * - Priority-based aggregate decision logic (CHANGES_REQUESTED > APPROVED > COMMENTED, DISMISSED filtered)
 * - Multi-reviewer scenarios (approval recovery, re-submit after dismissal)
 * - Missing repository/PR → Graceful early exit
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbTx as setupMockWithDbTx } from "../utils/db-helpers";

const reviewProjectionMocks = vi.hoisted(() => ({
  persistLatestGitHubPRReview: vi.fn(),
  applyExternal: vi.fn(),
}));

// Mock modules before importing
vi.mock("@/app/branches/branch-detail-signal", () => ({
  emitBranchDetailChanged: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withDb: vi.fn(),
}));

vi.mock("@/app/comments/service", () => ({
  commentsService: { applyExternal: reviewProjectionMocks.applyExternal },
}));

vi.mock("@/app/integrations/github/pr-review-projection", () => ({
  persistLatestGitHubPRReview:
    reviewProjectionMocks.persistLatestGitHubPRReview,
}));

vi.mock("@/app/webhooks/github/handlers/branch-activity-producer", () => ({
  GitHubBranchActivityEventName: {
    PullRequestReview: "pull_request_review",
  },
  persistGitHubBranchActivity: vi.fn().mockResolvedValue({
    status: "persisted",
    persistenceStatus: "inserted",
  }),
}));

// Import after mocking
import { CommentSyncProvider } from "@repo/api/src/types/comment-thread-dto";
import { GitHubCommentThreadKind } from "@repo/database";
import { GitHubExternalEventKind } from "@/app/comments/service/github/apply-external-events";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "@/app/webhooks/github/handlers/branch-activity-producer";
import { handlePullRequestReview } from "@/app/webhooks/github/handlers/pull-request-review-handler";
import {
  createPullRequest,
  createPullRequestReviewDismissedEvent,
  createPullRequestReviewEditedEvent,
  createPullRequestReviewSubmittedEvent,
  createRepository,
  createReview,
  createUser,
} from "../fixtures/github-webhook-fixtures";
import { makePrDetailRow } from "../utils/pr-detail-helpers";

// Mock database transaction client
let mockTx: ReturnType<typeof createReviewTx>;
const mockPersistGitHubBranchActivity =
  persistGitHubBranchActivity as ReturnType<typeof vi.fn>;

describe("handlePullRequestReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up transaction mock
    mockTx = createReviewTx();
    reviewProjectionMocks.persistLatestGitHubPRReview.mockResolvedValue(
      undefined
    );

    // Mock withDb.tx — all reads and writes happen in a single transaction
    setupMockWithDbTx(mockTx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("submitted action with APPROVED state", () => {
    it("updates reviewDecision to APPROVED without emitting a workstream event", async () => {
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

      const event = createPullRequestReviewSubmittedEvent(review, pullRequest, {
        repository,
      });

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        fullName: repository.full_name,
        installation: { organizationId: "org-uuid-123" },
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

      await handlePullRequestReview(event, {
        deliveryId: "review-delivery-1",
        observedAt: new Date("2026-08-12T14:00:00.000Z"),
      });

      expect(
        mockTx.gitHubInstallationRepository.findFirst
      ).toHaveBeenCalledWith({
        where: {
          githubRepoId: "789",
          fullName: repository.full_name,
          removedAt: null,
          installation: {
            installationId: "99",
            status: "ACTIVE",
          },
        },
        select: {
          id: true,
          fullName: true,
          installation: { select: { organizationId: true } },
        },
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

      // Verify per-reviewer persistence
      expect(
        reviewProjectionMocks.persistLatestGitHubPRReview
      ).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          pullRequestId: "artifact-pr-456",
          authorLogin: "reviewer",
          state: "APPROVED",
        })
      );

      // Aggregate PR detail update with APPROVED decision (via recomputeAndUpdateAggregate)
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { id: "artifact-pr-456" },
        data: { reviewDecision: "APPROVED" },
        // ISS-6322 narrowed this discarded write's RETURNING to the primary key.
        select: { id: true },
      });

      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
      expect(mockPersistGitHubBranchActivity).toHaveBeenCalledWith({
        eventName: GitHubBranchActivityEventName.PullRequestReview,
        deliveryId: "review-delivery-1",
        payload: event,
        attribution: {
          organizationId: "org-uuid-123",
          branchArtifactId: "artifact-pr-456",
          pullRequestDetailId: "artifact-pr-456",
        },
      });
    });
  });

  it("stores reviews under PullRequestDetail.id while using branch artifact linkage", async () => {
    const repository = createRepository(789);
    const pullRequest = createPullRequest({
      number: 42,
      title: "Add feature X",
    });
    const review = createReview({
      id: 12,
      state: "approved",
      body: "Ready",
    });

    const event = createPullRequestReviewSubmittedEvent(review, pullRequest, {
      repository,
      installation: null,
    });

    mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
      id: "repo-uuid-123",
    });
    mockTx.pullRequestDetail.findUnique.mockResolvedValue(
      makePrDetailRow({
        id: "pr-detail-current",
        artifactId: "legacy-pr-artifact",
        branchArtifactId: "branch-artifact-1",
        reviewDecision: null,
        workstreamId: "branch-workstream",
        branchTargetLinks: [
          { source: { id: "branch-doc", slug: "plan-feature-x" } },
        ],
      })
    );
    mockTx.gitHubPRReview.findMany.mockResolvedValue([{ state: "APPROVED" }]);

    await handlePullRequestReview(event);

    expect(
      reviewProjectionMocks.persistLatestGitHubPRReview
    ).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        pullRequestId: "pr-detail-current",
        authorLogin: "reviewer",
      })
    );
    expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
      where: { id: "pr-detail-current" },
      data: { reviewDecision: "APPROVED" },
      // ISS-6322 narrowed this discarded write's RETURNING to the primary key.
      select: { id: true },
    });
    expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
  });

  describe("submitted action with CHANGES_REQUESTED state", () => {
    it("updates reviewDecision to CHANGES_REQUESTED without emitting a workstream event", async () => {
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

      const event = createPullRequestReviewSubmittedEvent(review, pullRequest, {
        repository,
        installation: null,
      });

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
        where: { id: "artifact-pr-789" },
        data: { reviewDecision: "CHANGES_REQUESTED" },
        // ISS-6322 narrowed this discarded write's RETURNING to the primary key.
        select: { id: true },
      });

      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
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

      const event = createPullRequestReviewDismissedEvent(review, pullRequest, {
        repository,
        installation: null,
      });

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

      // Should persist per-reviewer record as DISMISSED
      expect(
        reviewProjectionMocks.persistLatestGitHubPRReview
      ).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          pullRequestId: "artifact-pr-dismiss",
          authorLogin: "reviewer",
          state: "DISMISSED",
        })
      );

      // Aggregate should be null (no active reviews after dismissal)
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { id: "artifact-pr-dismiss" },
        data: { reviewDecision: null },
        // ISS-6322 narrowed this discarded write's RETURNING to the primary key.
        select: { id: true },
      });

      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
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

      const event = createPullRequestReviewSubmittedEvent(review, pullRequest, {
        repository,
        installation: null,
      });

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

      // After persistence: reviewer-A has CHANGES_REQUESTED, reviewer (current) has COMMENTED
      mockTx.gitHubPRReview.findMany.mockResolvedValue([
        { state: "CHANGES_REQUESTED" },
        { state: "COMMENTED" },
      ]);
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReview(event);

      // Per-reviewer persistence happens
      expect(
        reviewProjectionMocks.persistLatestGitHubPRReview
      ).toHaveBeenCalled();

      // Aggregate should be CHANGES_REQUESTED (highest priority across all reviewers)
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { id: "artifact-pr-priority" },
        data: { reviewDecision: "CHANGES_REQUESTED" },
        // ISS-6322 narrowed this discarded write's RETURNING to the primary key.
        select: { id: true },
      });

      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
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

      const event = createPullRequestReviewDismissedEvent(review, pullRequest, {
        repository,
        installation: null,
      });

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
        where: { id: "artifact-pr-dismiss-priority" },
        data: { reviewDecision: "CHANGES_REQUESTED" },
        // ISS-6322 narrowed this discarded write's RETURNING to the primary key.
        select: { id: true },
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

      const event = createPullRequestReviewSubmittedEvent(review, pullRequest, {
        repository,
        installation: null,
      });

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

      expect(
        reviewProjectionMocks.persistLatestGitHubPRReview
      ).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          state: "CHANGES_REQUESTED",
        })
      );

      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { id: "artifact-pr-resubmit" },
        data: { reviewDecision: "CHANGES_REQUESTED" },
        // ISS-6322 narrowed this discarded write's RETURNING to the primary key.
        select: { id: true },
      });

      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
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

      const event = createPullRequestReviewSubmittedEvent(review, pullRequest, {
        repository,
        installation: null,
      });

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

      await handlePullRequestReview(event);

      expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
      expect(mockTx.pullRequestDetail.update).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
      expect(mockPersistGitHubBranchActivity).not.toHaveBeenCalled();
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

      const event = createPullRequestReviewSubmittedEvent(review, pullRequest, {
        repository,
        installation: null,
      });

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
        user: createUser({ login: "reviewer-b", id: 200 }),
      });

      const event = createPullRequestReviewSubmittedEvent(review, pullRequest, {
        repository,
        installation: null,
      });

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
        where: { id: "artifact-pr-multi2" },
        data: { reviewDecision: "APPROVED" },
        // ISS-6322 narrowed this discarded write's RETURNING to the primary key.
        select: { id: true },
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
        user: createUser({ login: "specific-reviewer", id: 400 }),
      });

      const event = createPullRequestReviewSubmittedEvent(review, pullRequest, {
        repository,
        installation: null,
      });

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

      expect(
        reviewProjectionMocks.persistLatestGitHubPRReview
      ).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          pullRequestId: "artifact-pr-upsert",
          authorLogin: "specific-reviewer",
          state: "APPROVED",
          githubReviewId: "23",
        })
      );
    });
  });

  describe("review summary thread (PLN-2122 decision 6)", () => {
    function reviewEvent(
      action: "submitted" | "edited" | "dismissed",
      body: string
    ) {
      const pullRequest = createPullRequest({ number: 42 });
      const envelope = { repository: createRepository(789) };
      switch (action) {
        case "submitted":
          return createPullRequestReviewSubmittedEvent(
            createReview({ id: 77, state: "commented", body }),
            pullRequest,
            envelope
          );
        case "edited":
          return createPullRequestReviewEditedEvent(
            createReview({ id: 77, state: "commented", body }),
            pullRequest,
            envelope,
            { body: { from: "old" } }
          );
        default:
          return createPullRequestReviewDismissedEvent(
            createReview({ id: 77, state: "dismissed", body }),
            pullRequest,
            envelope
          );
      }
    }

    function mockCurrentPullRequest(currentPullRequestDetailId: string | null) {
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        fullName: "owner/test-repo",
        installation: { organizationId: "org-uuid-123" },
      });
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "pr-detail-1",
          branchArtifactId: "branch-artifact-1",
          currentPullRequestDetailId,
          linkedDoc: null,
        })
      );
    }

    it("stores a submitted review's body as a summary thread keyed by the review id", async () => {
      mockCurrentPullRequest("pr-detail-1");

      await handlePullRequestReview(reviewEvent("submitted", "Summary body"));

      expect(reviewProjectionMocks.applyExternal).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: CommentSyncProvider.Github,
          organizationId: "org-uuid-123",
          branchArtifactId: "branch-artifact-1",
          pullRequestDetailId: "pr-detail-1",
          events: [
            expect.objectContaining({
              kind: GitHubExternalEventKind.ReviewSummaryUpsert,
              reviewId: 77,
              comment: expect.objectContaining({
                githubCommentId: 77,
                bodyMarkdown: "Summary body",
                providerUpdatedAt: new Date("2026-02-10T12:00:00Z"),
              }),
            }),
          ],
        })
      );
    });

    it("applies an edited review's body without rewriting the reviewer decision", async () => {
      mockCurrentPullRequest(null);

      await handlePullRequestReview(reviewEvent("edited", "Edited body"));

      expect(reviewProjectionMocks.applyExternal).toHaveBeenCalledTimes(1);
      expect(
        reviewProjectionMocks.persistLatestGitHubPRReview
      ).not.toHaveBeenCalled();
    });

    it("leaves the summary thread alone on a dismissal", async () => {
      mockCurrentPullRequest("pr-detail-1");

      await handlePullRequestReview(reviewEvent("dismissed", "Summary body"));

      expect(reviewProjectionMocks.applyExternal).not.toHaveBeenCalled();
      expect(
        reviewProjectionMocks.persistLatestGitHubPRReview
      ).toHaveBeenCalledTimes(1);
    });

    it("stores nothing for a blank review body", async () => {
      mockCurrentPullRequest("pr-detail-1");

      await handlePullRequestReview(reviewEvent("submitted", "   "));

      expect(reviewProjectionMocks.applyExternal).not.toHaveBeenCalled();
    });

    it("deletes the stored summary when an edit clears the review body", async () => {
      mockCurrentPullRequest("pr-detail-1");

      await handlePullRequestReview(reviewEvent("edited", "  "));

      expect(reviewProjectionMocks.applyExternal).toHaveBeenCalledWith(
        expect.objectContaining({
          pullRequestDetailId: "pr-detail-1",
          events: [
            {
              kind: GitHubExternalEventKind.CommentDelete,
              threadKind: GitHubCommentThreadKind.REVIEW_SUMMARY,
              githubCommentId: 77,
              providerUpdatedAt: new Date("2026-02-10T12:00:00Z"),
            },
          ],
        })
      );
    });

    it("stores nothing for a pull request that is not current for its branch", async () => {
      mockCurrentPullRequest("pr-detail-newer");

      await handlePullRequestReview(reviewEvent("submitted", "Summary body"));

      expect(reviewProjectionMocks.applyExternal).not.toHaveBeenCalled();
    });
  });
});

function createReviewTx() {
  return {
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
    // PLN-1034: a submitted review bumps branch_detail.last_activity_at.
    branchDetail: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    workstreamEvent: {
      create: vi.fn(),
    },
  };
}
