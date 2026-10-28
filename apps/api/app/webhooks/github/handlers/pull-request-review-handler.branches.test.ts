/**
 * Branch-arm coverage for `handlePullRequestReview` (ISS-11280): the review
 * states and payload shapes the sibling `webhook-pull-request-review.test.ts`
 * never sends — an unhandled action, an unrecognized review state, a review
 * with no user, and the absent `body` / `submitted_at` / `avatar_url` payload
 * fields on both the submitted and dismissed paths.
 */
import { CommentSyncProvider } from "@repo/api/src/types/comment-thread-dto";
import { ReviewDecision } from "@repo/api/src/types/document";
import {
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyExternal: vi.fn(),
  persistLatestGitHubPRReview: vi.fn(),
  recomputeAndUpdateAggregate: vi.fn(),
  persistActivity: vi.fn(),
  publishDirtyScopes: vi.fn(),
  nextHeaders: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.nextHeaders }));

vi.mock("@/app/branches/branch-detail-signal", () => ({
  emitBranchDetailChanged: vi.fn(),
}));

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@/app/comments/service", () => ({
  commentsService: { applyExternal: mocks.applyExternal },
}));

vi.mock("@/app/integrations/github/pr-review-projection", () => ({
  persistLatestGitHubPRReview: mocks.persistLatestGitHubPRReview,
}));

vi.mock("@/lib/review-decision-utils", () => ({
  recomputeAndUpdateAggregate: mocks.recomputeAndUpdateAggregate,
}));

vi.mock("./branch-activity-producer", () => ({
  GitHubBranchActivityEventName: { PullRequestReview: "pull_request_review" },
  persistGitHubBranchActivity: mocks.persistActivity,
}));

vi.mock("./dirty-scope-publisher", () => ({
  publishGitHubDirtyScopes: mocks.publishDirtyScopes,
}));

import {
  createPullRequest,
  createPullRequestReviewEditedEvent,
  createPullRequestReviewSubmittedEvent,
  createRepository,
  createReview,
} from "@/__tests__/fixtures/github-webhook-fixtures";
import { deliverGitHubWebhook } from "@/__tests__/support/webhooks/github/github-webhook-route-delivery.test-helpers";
import { getMockWithDb } from "@/__tests__/utils/db-helpers";
import {
  ApplyExternalOutcome,
  GitHubExternalEventKind,
} from "@/app/comments/service/github/apply-external-events";
import { handlePullRequestReview } from "./pull-request-review-handler";

const ORG_ID = "org-review-branches";
const REPO_ID = "repo-review-branches";
const PR_DETAIL_ID = "pr-detail-review-branches";
const BRANCH_ARTIFACT_ID = "branch-artifact-review-branches";
const NOW = new Date("2026-03-04T05:06:07.000Z");
const PR_NUMBER = 314;

type ReviewTx = {
  gitHubInstallationRepository: { findFirst: ReturnType<typeof vi.fn> };
  pullRequestDetail: { findUnique: ReturnType<typeof vi.fn> };
};

let tx: ReviewTx;

function buildEvent(action: "submitted" | "edited") {
  const review = createReview({ id: 77, state: "approved" });
  const pullRequest = createPullRequest({ number: PR_NUMBER });
  const envelope = { repository: createRepository(4040) };
  return action === "submitted"
    ? createPullRequestReviewSubmittedEvent(review, pullRequest, envelope)
    : createPullRequestReviewEditedEvent(review, pullRequest, envelope);
}

/**
 * A delivery the Octokit review types forbid — an unhandled action, an
 * unrecognized review state, no review user, an omitted body — which reaches
 * the handler only as the route's raw body.
 */
function buildOffContractEvent(
  action: string,
  reviewOverrides: Record<string, unknown>
) {
  return {
    ...buildEvent("submitted"),
    action,
    review: {
      ...createReview({ id: 77, state: "approved" }),
      ...reviewOverrides,
    },
  };
}

function deliver(payload: unknown, deliveryId?: string) {
  return deliverGitHubWebhook(mocks.nextHeaders, {
    eventType: "pull_request_review",
    payload,
    deliveryId,
  });
}

/** Answers the PR-detail lookup only for this repository's PR number. */
function stubPrDetail(row: unknown) {
  tx.pullRequestDetail.findUnique.mockImplementation(
    (args: {
      where: { repositoryId_number: { repositoryId: string; number: number } };
    }) => {
      const key = args.where.repositoryId_number;
      return Promise.resolve(
        key.repositoryId === REPO_ID && key.number === PR_NUMBER ? row : null
      );
    }
  );
}

const webhookProvenance = {
  fetchCredentialType: GitHubFetchCredentialType.GitHubApp,
  fetchCredentialOwnerId: null,
  fetchMechanism: GitHubFetchMechanism.Webhook,
  fetchTrigger: GitHubFetchTrigger.Webhook,
  fetchObservedAt: NOW,
  fetchResultReason: GitHubSyncResultReason.Success,
};

describe("handlePullRequestReview branch arms", () => {
  const mockWithDb = getMockWithDb();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    tx = {
      gitHubInstallationRepository: {
        findFirst: vi.fn().mockResolvedValue({
          id: REPO_ID,
          fullName: "owner/test-repo",
          installation: { organizationId: ORG_ID },
        }),
      },
      pullRequestDetail: { findUnique: vi.fn() },
    };
    stubPrDetail({
      id: PR_DETAIL_ID,
      artifactId: null,
      branchArtifactId: BRANCH_ARTIFACT_ID,
      reviewDecision: null,
      artifact: null,
      branchArtifact: {
        branch: { currentPullRequestDetailId: PR_DETAIL_ID },
        targetLinks: [],
      },
    });
    mockWithDb.tx = vi.fn((callback: (client: ReviewTx) => unknown) =>
      callback(tx)
    );
    mocks.applyExternal.mockResolvedValue({
      outcomes: [ApplyExternalOutcome.Applied],
      changedThreadIds: ["summary-thread"],
    });
    mocks.persistLatestGitHubPRReview.mockResolvedValue(undefined);
    mocks.recomputeAndUpdateAggregate.mockResolvedValue(null);
    mocks.persistActivity.mockResolvedValue(undefined);
    mocks.publishDirtyScopes.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores an unhandled action without opening a transaction", async () => {
    const response = await deliver(buildOffContractEvent("requested", {}));

    expect(mockWithDb.tx).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      message: "Ignoring unhandled pull_request_review action: requested",
      ok: true,
    });
  });

  it("applies an edited review's summary without rewriting the reviewer decision", async () => {
    const response = await handlePullRequestReview(buildEvent("edited"));

    expect(mockWithDb.tx).toHaveBeenCalledOnce();
    expect(mocks.persistLatestGitHubPRReview).not.toHaveBeenCalled();
    expect(mocks.recomputeAndUpdateAggregate).not.toHaveBeenCalled();
    expect(mocks.applyExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: CommentSyncProvider.Github,
        organizationId: ORG_ID,
        branchArtifactId: BRANCH_ARTIFACT_ID,
        pullRequestDetailId: PR_DETAIL_ID,
        events: [
          expect.objectContaining({
            kind: GitHubExternalEventKind.ReviewSummaryUpsert,
            reviewId: 77,
          }),
        ],
      })
    );
    expect(response.status).toBe(200);
  });

  it("marks a submitted summary as the first version and an edited one as a revival", async () => {
    await handlePullRequestReview(buildEvent("submitted"));
    await handlePullRequestReview(buildEvent("edited"));

    const [submitted, edited] = mocks.applyExternal.mock.calls.map(
      ([input]) => input.events[0]
    );
    expect(submitted).toEqual(expect.objectContaining({ asSubmitted: true }));
    expect(submitted).not.toHaveProperty("reviveDeletedBefore");
    expect(edited).toEqual(
      expect.objectContaining({ reviveDeletedBefore: NOW })
    );
    expect(edited).not.toHaveProperty("asSubmitted");
  });

  it("commits the review decision before the summary is written, so a failing summary keeps it", async () => {
    let decisionCommitted = false;
    mockWithDb.tx = vi.fn(async (callback: (client: ReviewTx) => unknown) => {
      const result = await callback(tx);
      decisionCommitted = true;
      return result;
    });
    let summaryAfterCommit = false;
    const summaryFailure = new Error("summary write failed");
    mocks.applyExternal.mockImplementation(() => {
      summaryAfterCommit = decisionCommitted;
      return Promise.reject(summaryFailure);
    });

    await expect(handlePullRequestReview(buildEvent("submitted"))).rejects.toBe(
      summaryFailure
    );

    expect(mockWithDb.tx).toHaveBeenCalledOnce();
    expect(mocks.persistLatestGitHubPRReview).toHaveBeenCalledOnce();
    expect(mocks.recomputeAndUpdateAggregate).toHaveBeenCalledOnce();
    expect(summaryAfterCommit).toBe(true);
  });

  it("drops a submitted review with an unrecognized state but still records activity and publishes the review scope", async () => {
    const event = buildOffContractEvent("submitted", { state: "pending" });

    const response = await deliver(event, "delivery-pending");

    expect(mocks.persistLatestGitHubPRReview).not.toHaveBeenCalled();
    expect(mocks.recomputeAndUpdateAggregate).not.toHaveBeenCalled();
    // pins current behavior; looks odd because the review itself is dropped
    // as unrecognized, yet the delivery still records branch activity and
    // publishes a Review dirty scope for it.
    expect(mocks.persistActivity).toHaveBeenCalledWith({
      eventName: "pull_request_review",
      deliveryId: "delivery-pending",
      payload: event,
      attribution: {
        organizationId: ORG_ID,
        branchArtifactId: BRANCH_ARTIFACT_ID,
        pullRequestDetailId: PR_DETAIL_ID,
      },
    });
    expect(mocks.publishDirtyScopes).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      repositoryId: REPO_ID,
      repositoryFullName: "owner/test-repo",
      scopes: [
        {
          kind: GitHubDirtyScopeKind.Review,
          repositoryId: REPO_ID,
          repositoryFullName: "owner/test-repo",
          branchName: "feature-branch",
          pullRequestNumber: PR_NUMBER,
          reviewId: "77",
        },
      ],
      triggers: [GitHubDirtyTrigger.Review],
    });
    expect(response.status).toBe(200);
  });

  it("skips the per-reviewer write and the aggregate recompute for a submitted review with no user", async () => {
    await deliver(buildOffContractEvent("submitted", { user: null }));

    expect(mocks.persistLatestGitHubPRReview).not.toHaveBeenCalled();
    expect(mocks.recomputeAndUpdateAggregate).not.toHaveBeenCalled();
    expect(mocks.persistActivity).toHaveBeenCalledTimes(1);
  });

  it("persists a submitted review with a missing body and a null submitted_at as body null and submittedAt now", async () => {
    await deliver(
      buildOffContractEvent("submitted", {
        state: "commented",
        // An omitted key, not null: `undefined ?? null` is the only input
        // that tells `?? null` apart from `&& null`.
        body: undefined,
        submitted_at: null,
      })
    );

    expect(mocks.persistLatestGitHubPRReview).toHaveBeenCalledWith(tx, {
      pullRequestId: PR_DETAIL_ID,
      githubReviewId: "77",
      authorLogin: "reviewer",
      authorAvatarUrl: "",
      state: ReviewDecision.Commented,
      body: null,
      htmlUrl: "https://github.com/owner/test-repo/pull/1#pullrequestreview-77",
      submittedAt: NOW,
      ...webhookProvenance,
    });
    expect(mocks.recomputeAndUpdateAggregate).toHaveBeenCalledWith(
      tx,
      PR_DETAIL_ID
    );
  });

  it("recomputes the aggregate without a per-reviewer write for a dismissed review with no user", async () => {
    await deliver(
      buildOffContractEvent("dismissed", { state: "dismissed", user: null })
    );

    expect(mocks.persistLatestGitHubPRReview).not.toHaveBeenCalled();
    expect(mocks.recomputeAndUpdateAggregate).toHaveBeenCalledWith(
      tx,
      PR_DETAIL_ID
    );
  });

  it("persists a dismissed review with a missing avatar and body and a null submitted_at as nulls and submittedAt now", async () => {
    await deliver(
      buildOffContractEvent("dismissed", {
        state: "dismissed",
        user: { login: "dismissed-reviewer", id: 12 },
        body: undefined,
        submitted_at: null,
      })
    );

    expect(mocks.persistLatestGitHubPRReview).toHaveBeenCalledWith(tx, {
      pullRequestId: PR_DETAIL_ID,
      githubReviewId: "77",
      authorLogin: "dismissed-reviewer",
      authorAvatarUrl: null,
      state: ReviewDecision.Dismissed,
      body: null,
      htmlUrl: "https://github.com/owner/test-repo/pull/1#pullrequestreview-77",
      submittedAt: NOW,
      ...webhookProvenance,
    });
  });

  it("keys a review on a row that also carries a legacy PR artifact by the PR detail id and attributes activity to its branch artifact", async () => {
    // `PullRequestDetail.branchArtifactId` is required in the schema, so a
    // legacy row still has its branch artifact. The linked document only
    // shapes `existingPr.documentId` / `document`, which neither review path
    // reads; the observable contract here is the detail-id key.
    stubPrDetail({
      id: PR_DETAIL_ID,
      artifactId: "legacy-pr-artifact",
      branchArtifactId: BRANCH_ARTIFACT_ID,
      reviewDecision: null,
      artifact: { targetLinks: [{ source: { id: "doc-legacy", slug: null } }] },
      branchArtifact: { branch: null, targetLinks: [] },
    });

    await handlePullRequestReview(buildEvent("submitted"));

    expect(mocks.persistLatestGitHubPRReview).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        pullRequestId: PR_DETAIL_ID,
        state: ReviewDecision.Approved,
      })
    );
    expect(mocks.persistActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        attribution: {
          organizationId: ORG_ID,
          branchArtifactId: BRANCH_ARTIFACT_ID,
          pullRequestDetailId: PR_DETAIL_ID,
        },
      })
    );
  });
});
