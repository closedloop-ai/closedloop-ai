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
  withDb: vi.fn(),
}));

// Import after mocking
import { handlePullRequestReview } from "@/app/webhooks/github/handlers/pull-request-review-handler";

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
  };
}

/**
 * Helper to create minimal pull request object
 */
function createPullRequest(partial: {
  number: number;
  title?: string;
  state?: string;
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
    draft: false,
    merged: false,
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
 * Helper to create minimal review object
 */
function createReview(partial: {
  id: number;
  state: string;
  body?: string;
  user?: { login: string; id: number };
}) {
  return {
    id: partial.id,
    node_id: `PRR_${partial.id}`,
    user: partial.user ?? {
      login: "reviewer",
      id: 999,
      node_id: "U_999",
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
    body: partial.body ?? "Review comment",
    state: partial.state,
    html_url: `https://github.com/owner/test-repo/pull/1#pullrequestreview-${partial.id}`,
    submitted_at: "2026-02-10T12:00:00Z",
    commit_id: "abc123",
    author_association: "MEMBER" as const,
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

describe("handlePullRequestReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up transaction mock
    mockTx = {
      gitHubInstallationRepository: {
        findFirst: vi.fn(),
      },
      gitHubPullRequest: {
        findUnique: vi.fn(),
        update: vi.fn(),
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

      // Mock repository lookup
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
      });

      // Mock PR lookup with null reviewDecision
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-456",
        workstreamId: "ws-uuid-789",
        artifactId: "artifact-uuid-123",
        reviewDecision: null,
        artifact: { slug: "plan-feature-x" },
      });

      // Mock update
      mockTx.gitHubPullRequest.update.mockResolvedValue({});

      // Mock per-reviewer review query (after upsert, this reviewer's APPROVED is the only review)
      mockTx.gitHubPRReview.findMany.mockResolvedValue([{ state: "APPROVED" }]);

      // Mock event creation
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReview(event);

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
          artifactId: true,
          reviewDecision: true,
          artifact: { select: { slug: true } },
        },
      });

      // Verify per-reviewer upsert
      expect(mockTx.gitHubPRReview.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            pullRequestId_authorLogin: {
              pullRequestId: "pr-uuid-456",
              authorLogin: "reviewer",
            },
          },
          create: expect.objectContaining({
            pullRequestId: "pr-uuid-456",
            authorLogin: "reviewer",
            state: "APPROVED",
          }),
          update: expect.objectContaining({
            state: "APPROVED",
          }),
        })
      );

      // Verify aggregate PR update with APPROVED decision
      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-456" },
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
            artifactId: "artifact-uuid-123",
            artifactSlug: "plan-feature-x",
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

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-789",
        workstreamId: "ws-uuid-abc",
        artifactId: null,
        reviewDecision: null,
        artifact: null,
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      mockTx.gitHubPRReview.findMany.mockResolvedValue([
        { state: "CHANGES_REQUESTED" },
      ]);
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReview(event);

      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-789" },
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
            artifactId: null,
            artifactSlug: undefined,
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

      // PR has existing CHANGES_REQUESTED decision
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-dismiss",
        workstreamId: "ws-uuid-dismiss",
        artifactId: "artifact-uuid-dismiss",
        reviewDecision: "CHANGES_REQUESTED",
        artifact: { slug: "plan-docs" },
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      mockTx.gitHubPRReview.findMany.mockResolvedValue([
        { state: "DISMISSED" },
      ]);

      await handlePullRequestReview(event);

      // Should upsert per-reviewer record to DISMISSED
      expect(mockTx.gitHubPRReview.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            pullRequestId_authorLogin: {
              pullRequestId: "pr-uuid-dismiss",
              authorLogin: "reviewer",
            },
          },
          update: { state: "DISMISSED" },
        })
      );

      // Aggregate should be null (no active reviews after dismissal)
      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-dismiss" },
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

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-priority",
        workstreamId: "ws-uuid-priority",
        artifactId: null,
        reviewDecision: "CHANGES_REQUESTED",
        artifact: null,
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});
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
      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-priority" },
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

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-dismiss-priority",
        workstreamId: "ws-uuid-dismiss-priority",
        artifactId: null,
        reviewDecision: "CHANGES_REQUESTED",
        artifact: null,
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      // After upsert: reviewer-A dismissed, reviewer-B still has CHANGES_REQUESTED
      mockTx.gitHubPRReview.findMany.mockResolvedValue([
        { state: "DISMISSED" },
        { state: "CHANGES_REQUESTED" },
      ]);

      await handlePullRequestReview(event);

      // Aggregate should be CHANGES_REQUESTED (DISMISSED is filtered out)
      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-dismiss-priority" },
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

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-resubmit",
        workstreamId: "ws-uuid-resubmit",
        artifactId: null,
        reviewDecision: "DISMISSED",
        artifact: null,
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      // After upsert, this reviewer's record is now CHANGES_REQUESTED (overwrites their old DISMISSED)
      mockTx.gitHubPRReview.findMany.mockResolvedValue([
        { state: "CHANGES_REQUESTED" },
      ]);
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReview(event);

      // Per-reviewer upsert should set CHANGES_REQUESTED
      expect(mockTx.gitHubPRReview.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            state: "CHANGES_REQUESTED",
          }),
        })
      );

      // Aggregate recomputed from all reviews = CHANGES_REQUESTED
      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-resubmit" },
        data: { reviewDecision: "CHANGES_REQUESTED" },
      });

      // Still creates workstream event
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

      // Mock repository not found
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

      await handlePullRequestReview(event);

      // Should not attempt to find PR or update
      expect(mockTx.gitHubPullRequest.findUnique).not.toHaveBeenCalled();
      expect(mockTx.gitHubPullRequest.update).not.toHaveBeenCalled();
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

      // Repository exists
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-exists",
      });

      // PR not found
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue(null);

      await handlePullRequestReview(event);

      // Should not attempt update or create event
      expect(mockTx.gitHubPullRequest.update).not.toHaveBeenCalled();
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

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-multi2",
        workstreamId: "ws-uuid-multi2",
        artifactId: null,
        reviewDecision: "CHANGES_REQUESTED",
        artifact: null,
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      // After reviewer-b updates to APPROVED: both reviewers now approved
      mockTx.gitHubPRReview.findMany.mockResolvedValue([
        { state: "APPROVED" },
        { state: "APPROVED" },
      ]);
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReview(event);

      // Aggregate = APPROVED (all reviewers approved)
      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-multi2" },
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

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-upsert",
        workstreamId: "ws-uuid-upsert",
        artifactId: null,
        reviewDecision: null,
        artifact: null,
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      mockTx.gitHubPRReview.findMany.mockResolvedValue([{ state: "APPROVED" }]);
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequestReview(event);

      // Verify upsert uses correct composite key
      expect(mockTx.gitHubPRReview.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            pullRequestId_authorLogin: {
              pullRequestId: "pr-uuid-upsert",
              authorLogin: "specific-reviewer",
            },
          },
          create: expect.objectContaining({
            pullRequestId: "pr-uuid-upsert",
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
