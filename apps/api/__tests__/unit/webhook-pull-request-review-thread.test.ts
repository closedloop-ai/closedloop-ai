import type * as ReviewThreadLookupModule from "@repo/github/review-thread-lookup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CommentsGithubProjectionModule from "@/app/comments/github-projection";
import type * as CommentsServiceModule from "@/app/comments/service";

const {
  MockGitHubReviewThreadResolutionAttributionKind,
  MockGitHubReviewThreadResolutionProjectionStatus,
  MockReviewThreadResolutionResultStatus,
  MockReviewThreadResolutionRetryableReason,
  MockReviewThreadResolutionTerminalReason,
  mockCommentsService,
  mockFetchReviewThreadResolutionByNodeId,
  mockFindGitHubReviewThreadResolutionProjection,
  mockLoadPrContextForCommentWebhook,
  mockResolveExternalGitHubAuthorInTransaction,
  mockResolveGitHubCommentOwner,
} = vi.hoisted(() => {
  const MockGitHubReviewThreadResolutionAttributionKind = {
    ConnectedUser: "connected_user",
    ExternalUnconnected: "external_unconnected",
    LegacyMissing: "legacy_missing",
  } as const satisfies typeof CommentsServiceModule.GitHubReviewThreadResolutionAttributionKind;
  const MockGitHubReviewThreadResolutionProjectionStatus = {
    Eligible: "eligible",
    UnknownReviewThread: "unknown_review_thread",
    AmbiguousReviewThread: "ambiguous_review_thread",
    WrongScope: "wrong_scope",
  } as const satisfies typeof CommentsGithubProjectionModule.GitHubReviewThreadResolutionProjectionStatus;
  const MockReviewThreadResolutionResultStatus = {
    Ok: "ok",
    Terminal: "terminal",
    RetryableError: "retryable_error",
  } as const satisfies typeof ReviewThreadLookupModule.ReviewThreadResolutionResultStatus;
  const MockReviewThreadResolutionRetryableReason = {
    Timeout: "timeout",
  } as const satisfies Pick<
    typeof ReviewThreadLookupModule.ReviewThreadResolutionRetryableReason,
    "Timeout"
  >;
  const MockReviewThreadResolutionTerminalReason = {
    NotFound: "not_found",
  } as const satisfies Pick<
    typeof ReviewThreadLookupModule.ReviewThreadResolutionTerminalReason,
    "NotFound"
  >;
  return {
    MockGitHubReviewThreadResolutionAttributionKind,
    MockGitHubReviewThreadResolutionProjectionStatus,
    MockReviewThreadResolutionResultStatus,
    MockReviewThreadResolutionRetryableReason,
    MockReviewThreadResolutionTerminalReason,
    mockCommentsService: {
      resolveThread: vi.fn(),
      unresolveThread: vi.fn(),
    },
    mockFetchReviewThreadResolutionByNodeId: vi.fn(),
    mockFindGitHubReviewThreadResolutionProjection: vi.fn(),
    mockLoadPrContextForCommentWebhook: vi.fn(),
    mockResolveExternalGitHubAuthorInTransaction: vi.fn(),
    mockResolveGitHubCommentOwner: vi.fn(),
  };
});

vi.mock("@repo/database", () => ({
  withDb: {
    tx: vi.fn((callback) => callback(mockTx)),
  },
}));

vi.mock("@repo/github/review-thread-lookup", () => ({
  ReviewThreadResolutionResultStatus: MockReviewThreadResolutionResultStatus,
  ReviewThreadResolutionRetryableReason:
    MockReviewThreadResolutionRetryableReason,
  ReviewThreadResolutionTerminalReason:
    MockReviewThreadResolutionTerminalReason,
  fetchReviewThreadResolutionByNodeId: mockFetchReviewThreadResolutionByNodeId,
}));

vi.mock("@/app/comments/service", () => ({
  GitHubReviewThreadResolutionAttributionKind:
    MockGitHubReviewThreadResolutionAttributionKind,
  commentsService: mockCommentsService,
}));

vi.mock("@/app/comments/external-authors", () => ({
  resolveExternalGitHubAuthorInTransaction:
    mockResolveExternalGitHubAuthorInTransaction,
}));

vi.mock("@/app/comments/github-projection", () => ({
  GitHubReviewThreadResolutionProjectionStatus:
    MockGitHubReviewThreadResolutionProjectionStatus,
  findGitHubReviewThreadResolutionProjection:
    mockFindGitHubReviewThreadResolutionProjection,
}));

vi.mock("@/app/webhooks/github/comment-owner-resolver", () => ({
  resolveGitHubCommentOwner: mockResolveGitHubCommentOwner,
}));

vi.mock("@/app/webhooks/github/handlers/pr-comment-context", () => ({
  loadPrContextForCommentWebhook: mockLoadPrContextForCommentWebhook,
}));

import {
  ReviewThreadResolutionResultStatus,
  ReviewThreadResolutionRetryableReason,
  ReviewThreadResolutionTerminalReason,
} from "@repo/github/review-thread-lookup";
import { GitHubReviewThreadResolutionProjectionStatus } from "@/app/comments/github-projection";
import {
  type GitHubReviewThreadResolutionAttribution,
  GitHubReviewThreadResolutionAttributionKind,
} from "@/app/comments/service";
import { handlePullRequestReviewThread } from "@/app/webhooks/github/handlers/pull-request-review-thread-handler";

const REVIEW_THREAD_ATTRIBUTION_SOURCE =
  "pull_request_review_thread" satisfies GitHubReviewThreadResolutionAttribution["source"];

let mockTx: {
  workstreamEvent: { create: ReturnType<typeof vi.fn> };
};

function reviewThreadPayload(action = "resolved") {
  return {
    action,
    installation: { id: 123 },
    repository: { id: 456, full_name: "acme/repo" },
    pull_request: {
      number: 42,
      title: "Improve branch view",
      html_url: "https://github.com/acme/repo/pull/42",
    },
    thread: { node_id: "PRRT_thread" },
    sender: {
      id: 789,
      node_id: "U_sender",
      login: "octocat",
      avatar_url: "https://avatars.example/octocat.png",
      html_url: "https://github.com/octocat",
    },
  };
}

describe("handlePullRequestReviewThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = {
      workstreamEvent: { create: vi.fn() },
    };
    mockResolveGitHubCommentOwner.mockResolvedValue({
      ok: true,
      organizationId: "org-1",
      installationRecordId: "installation-1",
      repositoryRecordId: "repository-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-detail-1",
    });
    mockLoadPrContextForCommentWebhook.mockResolvedValue({
      id: "pr-detail-1",
      branchArtifactId: "branch-1",
      workstreamId: "workstream-1",
      documentId: "doc-1",
      document: { slug: "FEA-1429" },
    });
    mockFindGitHubReviewThreadResolutionProjection.mockResolvedValue({
      status: GitHubReviewThreadResolutionProjectionStatus.Eligible,
      threadId: "thread-1",
      threadExternalId:
        "github-pr-thread:pr-detail-1:review-thread:PRRT_thread",
    });
    mockFetchReviewThreadResolutionByNodeId.mockResolvedValue({
      status: ReviewThreadResolutionResultStatus.Ok,
      isResolved: true,
    });
    mockResolveExternalGitHubAuthorInTransaction.mockResolvedValue({
      source: "github_user_connection",
      user: { id: "user-1" },
    });
    mockCommentsService.resolveThread.mockResolvedValue({
      kind: "transition",
      thread: { id: "thread-1" },
    });
    mockCommentsService.unresolveThread.mockResolvedValue({
      kind: "transition",
      thread: { id: "thread-1" },
    });
  });

  it("does not call the provider for local terminal no-write eligibility", async () => {
    mockFindGitHubReviewThreadResolutionProjection.mockResolvedValue({
      status: GitHubReviewThreadResolutionProjectionStatus.UnknownReviewThread,
    });

    const response = await handlePullRequestReviewThread(reviewThreadPayload());

    expect(response.status).toBe(200);
    expect(mockFetchReviewThreadResolutionByNodeId).not.toHaveBeenCalled();
    expect(mockCommentsService.resolveThread).not.toHaveBeenCalled();
  });

  it("does not call the provider for a wrong-scope review thread", async () => {
    mockFindGitHubReviewThreadResolutionProjection.mockResolvedValue({
      status: GitHubReviewThreadResolutionProjectionStatus.WrongScope,
    });

    const response = await handlePullRequestReviewThread(reviewThreadPayload());

    expect(response.status).toBe(200);
    expect(mockFetchReviewThreadResolutionByNodeId).not.toHaveBeenCalled();
    expect(mockCommentsService.resolveThread).not.toHaveBeenCalled();
    expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
  });

  it("passes payload review comment ids to local thread projection lookup", async () => {
    const payload = reviewThreadPayload();
    (
      payload.thread as typeof payload.thread & {
        comments: { id: string | number; node_id?: string }[];
      }
    ).comments = [{ id: 1001 }, { id: "1002", node_id: "PRRC_node_1002" }];

    const response = await handlePullRequestReviewThread(payload);

    expect(response.status).toBe(200);
    expect(mockFindGitHubReviewThreadResolutionProjection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reviewThreadId: "PRRT_thread",
        reviewCommentIds: ["1001", "1002"],
      })
    );
  });

  it("does not call the provider for missing PR context or ambiguous review-thread projection", async () => {
    mockLoadPrContextForCommentWebhook.mockResolvedValueOnce(null);

    await expect(
      handlePullRequestReviewThread(reviewThreadPayload())
    ).resolves.toHaveProperty("status", 200);
    expect(mockFetchReviewThreadResolutionByNodeId).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockFindGitHubReviewThreadResolutionProjection.mockResolvedValue({
      status:
        GitHubReviewThreadResolutionProjectionStatus.AmbiguousReviewThread,
    });

    await expect(
      handlePullRequestReviewThread(reviewThreadPayload())
    ).resolves.toHaveProperty("status", 200);
    expect(mockFetchReviewThreadResolutionByNodeId).not.toHaveBeenCalled();
    expect(mockCommentsService.resolveThread).not.toHaveBeenCalled();
    expect(mockCommentsService.unresolveThread).not.toHaveBeenCalled();
  });

  it("returns 400 for missing installation before local or provider work", async () => {
    const payload = reviewThreadPayload();
    payload.installation = undefined as never;

    const response = await handlePullRequestReviewThread(payload);

    expect(response.status).toBe(400);
    expect(mockResolveGitHubCommentOwner).not.toHaveBeenCalled();
    expect(mockFetchReviewThreadResolutionByNodeId).not.toHaveBeenCalled();
  });

  it("skips unsupported actions before local or provider work", async () => {
    const response = await handlePullRequestReviewThread(
      reviewThreadPayload("reopened")
    );

    expect(response.status).toBe(200);
    expect(mockResolveGitHubCommentOwner).not.toHaveBeenCalled();
    expect(mockFetchReviewThreadResolutionByNodeId).not.toHaveBeenCalled();
  });

  it("does not call the provider on owner resolution failure", async () => {
    mockResolveGitHubCommentOwner.mockResolvedValueOnce({ ok: false });

    await expect(
      handlePullRequestReviewThread(reviewThreadPayload())
    ).resolves.toHaveProperty("status", 200);
    expect(mockFetchReviewThreadResolutionByNodeId).not.toHaveBeenCalled();
  });

  it("returns retryable 5xx for provider timeout after local eligibility", async () => {
    mockFetchReviewThreadResolutionByNodeId.mockResolvedValue({
      status: ReviewThreadResolutionResultStatus.RetryableError,
      reason: ReviewThreadResolutionRetryableReason.Timeout,
    });

    const response = await handlePullRequestReviewThread(reviewThreadPayload());

    expect(response.status).toBe(502);
    expect(mockCommentsService.resolveThread).not.toHaveBeenCalled();
    expect(mockCommentsService.unresolveThread).not.toHaveBeenCalled();
    expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
  });

  it("acknowledges provider terminal and stale replay states without writing", async () => {
    mockFetchReviewThreadResolutionByNodeId.mockResolvedValueOnce({
      status: ReviewThreadResolutionResultStatus.Terminal,
      reason: ReviewThreadResolutionTerminalReason.NotFound,
    });

    await expect(
      handlePullRequestReviewThread(reviewThreadPayload())
    ).resolves.toHaveProperty("status", 200);
    expect(mockCommentsService.resolveThread).not.toHaveBeenCalled();

    mockFetchReviewThreadResolutionByNodeId.mockResolvedValueOnce({
      status: ReviewThreadResolutionResultStatus.Ok,
      isResolved: false,
    });

    await expect(
      handlePullRequestReviewThread(reviewThreadPayload())
    ).resolves.toHaveProperty("status", 200);
    expect(mockCommentsService.resolveThread).not.toHaveBeenCalled();

    mockFetchReviewThreadResolutionByNodeId.mockResolvedValueOnce({
      status: ReviewThreadResolutionResultStatus.Ok,
      isResolved: true,
    });

    await expect(
      handlePullRequestReviewThread(reviewThreadPayload("unresolved"))
    ).resolves.toHaveProperty("status", 200);
    expect(mockCommentsService.resolveThread).not.toHaveBeenCalled();
    expect(mockCommentsService.unresolveThread).not.toHaveBeenCalled();
  });

  it("does not write when revalidation changes document context", async () => {
    mockLoadPrContextForCommentWebhook
      .mockResolvedValueOnce({
        id: "pr-detail-1",
        branchArtifactId: "branch-1",
        workstreamId: "workstream-1",
        documentId: "doc-1",
        document: { slug: "FEA-1429" },
      })
      .mockResolvedValueOnce({
        id: "pr-detail-1",
        branchArtifactId: "branch-1",
        workstreamId: "workstream-1",
        documentId: "doc-2",
        document: { slug: "FEA-1430" },
      });

    const response = await handlePullRequestReviewThread(reviewThreadPayload());

    expect(response.status).toBe(200);
    expect(mockFetchReviewThreadResolutionByNodeId).toHaveBeenCalledTimes(1);
    expect(mockCommentsService.resolveThread).not.toHaveBeenCalled();
    expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
  });

  it("does not write when revalidation loses the projection", async () => {
    mockLoadPrContextForCommentWebhook.mockResolvedValue({
      id: "pr-detail-1",
      branchArtifactId: "branch-1",
      documentId: "doc-1",
      document: { slug: "FEA-1429" },
    });
    mockFindGitHubReviewThreadResolutionProjection
      .mockResolvedValueOnce({
        status: GitHubReviewThreadResolutionProjectionStatus.Eligible,
        threadId: "thread-1",
        threadExternalId:
          "github-pr-thread:pr-detail-1:review-thread:PRRT_thread",
      })
      .mockResolvedValueOnce({
        status:
          GitHubReviewThreadResolutionProjectionStatus.UnknownReviewThread,
      });

    await expect(
      handlePullRequestReviewThread(reviewThreadPayload())
    ).resolves.toHaveProperty("status", 200);
    expect(mockFetchReviewThreadResolutionByNodeId).toHaveBeenCalledTimes(1);
    expect(mockCommentsService.resolveThread).not.toHaveBeenCalled();
    expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
  });

  it("resolves locally and emits one minimal workstream event on transition", async () => {
    const response = await handlePullRequestReviewThread(reviewThreadPayload());

    expect(response.status).toBe(200);
    expect(mockCommentsService.resolveThread).toHaveBeenCalledWith(
      "org-1",
      "github-pr-thread:pr-detail-1:review-thread:PRRT_thread",
      expect.any(Date),
      expect.objectContaining({
        resolvedById: "user-1",
        attribution: expect.objectContaining({
          kind: GitHubReviewThreadResolutionAttributionKind.ConnectedUser,
          githubLogin: "octocat",
          source: REVIEW_THREAD_ATTRIBUTION_SOURCE,
        }),
      })
    );
  });

  it("records authoritative external attribution without resolvedById", async () => {
    mockResolveExternalGitHubAuthorInTransaction.mockResolvedValue({
      source: "external_comment_author",
    });

    await handlePullRequestReviewThread(reviewThreadPayload());

    expect(mockCommentsService.resolveThread).toHaveBeenCalledWith(
      "org-1",
      "github-pr-thread:pr-detail-1:review-thread:PRRT_thread",
      expect.any(Date),
      expect.objectContaining({
        resolvedById: null,
        attribution: expect.objectContaining({
          kind: GitHubReviewThreadResolutionAttributionKind.ExternalUnconnected,
          githubLogin: "octocat",
          source: REVIEW_THREAD_ATTRIBUTION_SOURCE,
        }),
      })
    );
  });

  it("unresolves locally on transition", async () => {
    mockFetchReviewThreadResolutionByNodeId.mockResolvedValue({
      status: ReviewThreadResolutionResultStatus.Ok,
      isResolved: false,
    });

    const response = await handlePullRequestReviewThread(
      reviewThreadPayload("unresolved")
    );

    expect(response.status).toBe(200);
    expect(mockCommentsService.unresolveThread).toHaveBeenCalledWith(
      "org-1",
      "github-pr-thread:pr-detail-1:review-thread:PRRT_thread"
    );
    expect(mockCommentsService.resolveThread).not.toHaveBeenCalled();
    expect(mockResolveExternalGitHubAuthorInTransaction).not.toHaveBeenCalled();
  });
});
