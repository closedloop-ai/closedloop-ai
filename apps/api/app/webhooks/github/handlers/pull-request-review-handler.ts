import type {
  PullRequestReviewDismissedEvent,
  PullRequestReviewSubmittedEvent,
} from "@octokit/webhooks-types";
import { ReviewDecision } from "@repo/api/src/types/artifact";
import { type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";

/**
 * Union type for pull request review events we handle.
 */
export type HandledPullRequestReviewEvent =
  | PullRequestReviewSubmittedEvent
  | PullRequestReviewDismissedEvent;

/**
 * Priority order for review decisions. Higher numbers take precedence.
 * DISMISSED reviews are excluded from aggregate computation (filtered before this is used).
 * Per-reviewer records still store DISMISSED for audit purposes.
 */
const REVIEW_DECISION_PRIORITY = {
  [ReviewDecision.ChangesRequested]: 3,
  [ReviewDecision.Approved]: 2,
  [ReviewDecision.Commented]: 1,
  null: 0,
} as const;

/**
 * Actions this handler processes. All other actions are ignored with an early return.
 */
const HANDLED_ACTIONS = new Set(["submitted", "dismissed"]);

/**
 * Map GitHub review state to our ReviewDecision enum.
 * Returns null for unrecognized states.
 */
function mapReviewStateToDecision(state: string): ReviewDecision | null {
  switch (state.toUpperCase()) {
    case "APPROVED":
      return ReviewDecision.Approved;
    case "CHANGES_REQUESTED":
      return ReviewDecision.ChangesRequested;
    case "COMMENTED":
      return ReviewDecision.Commented;
    default:
      return null;
  }
}

/**
 * Compute the aggregate review decision from a list of per-reviewer states.
 * Filters out DISMISSED reviews (neutralized by admin action), then takes
 * the highest-priority value across remaining active reviewers.
 * Returns null if no active reviews exist.
 */
function computeAggregateReviewDecision(
  reviewStates: ReviewDecision[]
): ReviewDecision | null {
  const activeStates = reviewStates.filter(
    (s) => s !== ReviewDecision.Dismissed
  );

  if (activeStates.length === 0) {
    return null;
  }

  let highest: ReviewDecision = activeStates[0];
  for (const state of activeStates) {
    if (
      REVIEW_DECISION_PRIORITY[state as keyof typeof REVIEW_DECISION_PRIORITY] >
      REVIEW_DECISION_PRIORITY[highest as keyof typeof REVIEW_DECISION_PRIORITY]
    ) {
      highest = state;
    }
  }
  return highest;
}

/**
 * Recompute aggregate reviewDecision from all per-reviewer reviews and update the PR.
 */
async function recomputeAndUpdateAggregate(
  tx: TransactionClient,
  pullRequestId: string
): Promise<ReviewDecision | null> {
  const allReviews = await tx.gitHubPRReview.findMany({
    where: { pullRequestId },
    select: { state: true },
  });

  const aggregateDecision = computeAggregateReviewDecision(
    allReviews.map((r: { state: string }) => r.state as ReviewDecision)
  );

  await tx.gitHubPullRequest.update({
    where: { id: pullRequestId },
    data: { reviewDecision: aggregateDecision },
  });

  return aggregateDecision;
}

/**
 * Handle the "submitted" action for a PR review.
 * Upserts per-reviewer record, recomputes aggregate, creates workstream event.
 */
async function handleSubmittedReview(
  tx: TransactionClient,
  review: HandledPullRequestReviewEvent["review"],
  pull_request: HandledPullRequestReviewEvent["pull_request"],
  existingPr: {
    id: string;
    workstreamId: string;
    artifactId: string | null;
    reviewDecision: string | null;
    artifact: { slug: string } | null;
  }
): Promise<void> {
  const reviewDecision = mapReviewStateToDecision(review.state);
  if (!reviewDecision) {
    log.warn("[handlePullRequestReview] Unrecognized review state", {
      reviewState: review.state,
      reviewId: review.id,
      prNumber: pull_request.number,
    });
    return;
  }

  const reviewerLogin = review.user?.login;
  if (!reviewerLogin) {
    log.warn("[handlePullRequestReview] Review has no user login", {
      reviewId: review.id,
      prNumber: pull_request.number,
    });
    return;
  }

  // Upsert per-reviewer record (keyed by pullRequestId + authorLogin)
  await tx.gitHubPRReview.upsert({
    where: {
      pullRequestId_authorLogin: {
        pullRequestId: existingPr.id,
        authorLogin: reviewerLogin,
      },
    },
    create: {
      pullRequestId: existingPr.id,
      githubReviewId: BigInt(review.id),
      authorLogin: reviewerLogin,
      authorAvatarUrl: review.user?.avatar_url ?? null,
      state: reviewDecision,
      body: review.body ?? null,
      htmlUrl: review.html_url,
      submittedAt: review.submitted_at
        ? new Date(review.submitted_at)
        : new Date(),
    },
    update: {
      githubReviewId: BigInt(review.id),
      authorAvatarUrl: review.user?.avatar_url ?? null,
      state: reviewDecision,
      body: review.body ?? null,
      htmlUrl: review.html_url,
      submittedAt: review.submitted_at
        ? new Date(review.submitted_at)
        : new Date(),
    },
  });

  const aggregateDecision = await recomputeAndUpdateAggregate(
    tx,
    existingPr.id
  );

  log.info(
    "[handlePullRequestReview] Updated per-reviewer and aggregate review decision",
    {
      prNumber: pull_request.number,
      reviewerLogin,
      reviewerDecision: reviewDecision,
      previousAggregate: existingPr.reviewDecision,
      newAggregate: aggregateDecision,
    }
  );

  // Create workstream event for submitted review
  await tx.workstreamEvent.create({
    data: {
      workstreamId: existingPr.workstreamId,
      type: "GITHUB_PR_REVIEW_SUBMITTED",
      actorType: "system",
      data: {
        reviewId: review.id,
        reviewState: review.state,
        reviewDecision,
        reviewerLogin,
        reviewBody: review.body,
        prNumber: pull_request.number,
        prTitle: pull_request.title,
        prUrl: pull_request.html_url,
        reviewUrl: review.html_url,
        artifactId: existingPr.artifactId,
        artifactSlug: existingPr.artifact?.slug,
      },
    },
  });
}

/**
 * Handle the "dismissed" action for a PR review.
 * Sets reviewer record to DISMISSED, recomputes aggregate.
 */
async function handleDismissedReview(
  tx: TransactionClient,
  review: HandledPullRequestReviewEvent["review"],
  pull_request: HandledPullRequestReviewEvent["pull_request"],
  existingPr: {
    id: string;
    workstreamId: string;
    artifactId: string | null;
    reviewDecision: string | null;
    artifact: { slug: string } | null;
  }
): Promise<void> {
  const reviewerLogin = review.user?.login;

  if (reviewerLogin) {
    await tx.gitHubPRReview.upsert({
      where: {
        pullRequestId_authorLogin: {
          pullRequestId: existingPr.id,
          authorLogin: reviewerLogin,
        },
      },
      create: {
        pullRequestId: existingPr.id,
        githubReviewId: BigInt(review.id),
        authorLogin: reviewerLogin,
        authorAvatarUrl: review.user?.avatar_url ?? null,
        state: ReviewDecision.Dismissed,
        body: review.body ?? null,
        htmlUrl: review.html_url,
        submittedAt: new Date(),
      },
      update: {
        state: ReviewDecision.Dismissed,
      },
    });
  }

  const aggregateDecision = await recomputeAndUpdateAggregate(
    tx,
    existingPr.id
  );

  log.info("[handlePullRequestReview] Review dismissed", {
    prNumber: pull_request.number,
    reviewerLogin,
    previousAggregate: existingPr.reviewDecision,
    newAggregate: aggregateDecision,
  });

  // Create workstream event for dismissed review
  await tx.workstreamEvent.create({
    data: {
      workstreamId: existingPr.workstreamId,
      type: "GITHUB_PR_REVIEW_SUBMITTED",
      actorType: "system",
      data: {
        reviewId: review.id,
        reviewState: "dismissed",
        reviewDecision: ReviewDecision.Dismissed,
        reviewerLogin,
        reviewBody: review.body,
        prNumber: pull_request.number,
        prTitle: pull_request.title,
        prUrl: pull_request.html_url,
        reviewUrl: review.html_url,
        artifactId: existingPr.artifactId,
        artifactSlug: existingPr.artifact?.slug,
      },
    },
  });
}

/**
 * Handle GitHub pull_request_review webhook events.
 *
 * Supported actions:
 * - submitted: Upserts per-reviewer GitHubPRReview record, recomputes aggregate reviewDecision
 * - dismissed: Sets specific reviewer's record to DISMISSED, recomputes aggregate
 *
 * Per-reviewer tracking: Each reviewer's latest review is stored in GitHubPRReview
 * (keyed by pullRequestId + authorLogin). The aggregate reviewDecision on GitHubPullRequest
 * is computed as the highest-priority value across active (non-dismissed) reviewers.
 * DISMISSED reviews are excluded from the aggregate but retained in per-reviewer records.
 *
 * Priority order (highest to lowest):
 * CHANGES_REQUESTED > APPROVED > COMMENTED > null
 */
export async function handlePullRequestReview(
  event: HandledPullRequestReviewEvent
): Promise<Response> {
  const { action, review, pull_request, repository } = event;

  // Early exit for unhandled actions
  if (!HANDLED_ACTIONS.has(action)) {
    log.info("[handlePullRequestReview] Skipping unhandled action", {
      action,
      prNumber: pull_request.number,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json({
      message: `Ignoring unhandled pull_request_review action: ${action}`,
      ok: true,
    });
  }

  log.info("[handlePullRequestReview] Processing pull_request_review event", {
    action,
    reviewId: review.id,
    reviewState: review.state,
    prNumber: pull_request.number,
    prTitle: pull_request.title,
    repositoryId: repository.id,
  });

  // All reads and writes in a single transaction to avoid TOCTOU gaps
  await withDb.tx(async (tx) => {
    const repo = await tx.gitHubInstallationRepository.findFirst({
      where: { githubRepoId: String(repository.id) },
      select: { id: true },
    });

    if (!repo) {
      log.warn("[handlePullRequestReview] Repository not found in database", {
        githubRepoId: repository.id,
        repositoryFullName: repository.full_name,
        action,
        prNumber: pull_request.number,
      });
      return;
    }

    const existingPr = await tx.gitHubPullRequest.findUnique({
      where: {
        repositoryId_number: {
          repositoryId: repo.id,
          number: pull_request.number,
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

    if (!existingPr) {
      log.warn("[handlePullRequestReview] Pull request not found in database", {
        repositoryId: repo.id,
        prNumber: pull_request.number,
        action,
        reason: "PR may have been created outside Symphony workflow",
      });
      return;
    }

    if (action === "submitted") {
      await handleSubmittedReview(tx, review, pull_request, existingPr);
    } else if (action === "dismissed") {
      await handleDismissedReview(tx, review, pull_request, existingPr);
    }
  });

  log.info(
    "[handlePullRequestReview] Successfully processed pull_request_review event",
    {
      action,
      reviewId: review.id,
      prNumber: pull_request.number,
      githubRepoId: repository.id,
    }
  );

  return NextResponse.json({
    message: "Event processed successfully",
    ok: true,
  });
}
