import type {
  PullRequestReviewDismissedEvent,
  PullRequestReviewEditedEvent,
  PullRequestReviewSubmittedEvent,
} from "@octokit/webhooks-types";
import { LinkType } from "@repo/api/src/types/artifact";
import { CommentSyncProvider } from "@repo/api/src/types/comment-thread-dto";
import { ReviewDecision } from "@repo/api/src/types/document";
import {
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import {
  ArtifactType,
  GitHubCommentThreadKind,
  GitHubInstallationStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";

import { emitBranchDetailChanged } from "@/app/branches/branch-detail-signal";
import { commentsService } from "@/app/comments/service";
import {
  type GitHubCommentDeleteEvent,
  GitHubExternalEventKind,
  type GitHubReviewSummaryUpsertEvent,
} from "@/app/comments/service/github/apply-external-events";
import { withGitHubCommentWriteRetry } from "@/app/comments/service/github/github-comment-write-retry";
import { persistLatestGitHubPRReview } from "@/app/integrations/github/pr-review-projection";
import type { GitHubWebhookObservationContext } from "@/lib/github/github-webhook-observation";
import {
  gitHubFetchProvenanceData,
  githubAppWebhookFetchProvenance,
} from "@/lib/github-fetch-provenance";
import { recomputeAndUpdateAggregate } from "@/lib/review-decision-utils";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "./branch-activity-producer";
import {
  type GitHubDirtyScopePublicationInput,
  publishGitHubDirtyScopes,
} from "./dirty-scope-publisher";
import {
  branchCurrentPullRequestDetailId,
  isBranchCurrentPullRequest,
} from "./pr-comment-context";

/**
 * Union type for pull request review events we handle.
 */
export type HandledPullRequestReviewEvent =
  | PullRequestReviewSubmittedEvent
  | PullRequestReviewEditedEvent
  | PullRequestReviewDismissedEvent;

/**
 * Actions this handler processes. All other actions are ignored with an early return.
 */
const HANDLED_ACTIONS = new Set(["submitted", "edited", "dismissed"]);

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
 * Handle the "submitted" action for a PR review.
 * Upserts per-reviewer record, recomputes aggregate.
 */
async function handleSubmittedReview(
  tx: TransactionClient,
  review: HandledPullRequestReviewEvent["review"],
  pull_request: HandledPullRequestReviewEvent["pull_request"],
  existingPr: {
    id: string;
    documentId: string | null;
    reviewDecision: string | null;
    document: { slug: string } | null;
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
  const fetchProvenance = gitHubFetchProvenanceData(
    githubAppWebhookFetchProvenance()
  );
  await persistLatestGitHubPRReview(tx, {
    pullRequestId: existingPr.id,
    githubReviewId: String(review.id),
    authorLogin: reviewerLogin,
    authorAvatarUrl: review.user?.avatar_url ?? null,
    state: reviewDecision,
    body: review.body ?? null,
    htmlUrl: review.html_url,
    submittedAt: review.submitted_at
      ? new Date(review.submitted_at)
      : new Date(),
    ...fetchProvenance,
  });

  const aggregateDecision = await recomputeAndUpdateAggregate(
    tx,
    existingPr.id
  );

  log.debug(
    "[handlePullRequestReview] Updated per-reviewer and aggregate review decision",
    {
      prNumber: pull_request.number,
      reviewerLogin,
      reviewerDecision: reviewDecision,
      previousAggregate: existingPr.reviewDecision,
      newAggregate: aggregateDecision,
    }
  );
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
    documentId: string | null;
    reviewDecision: string | null;
    document: { slug: string } | null;
  }
): Promise<void> {
  const reviewerLogin = review.user?.login;

  if (reviewerLogin) {
    const fetchProvenance = gitHubFetchProvenanceData(
      githubAppWebhookFetchProvenance()
    );
    await persistLatestGitHubPRReview(tx, {
      pullRequestId: existingPr.id,
      githubReviewId: String(review.id),
      authorLogin: reviewerLogin,
      authorAvatarUrl: review.user?.avatar_url ?? null,
      state: ReviewDecision.Dismissed,
      body: review.body ?? null,
      htmlUrl: review.html_url,
      submittedAt: review.submitted_at
        ? new Date(review.submitted_at)
        : new Date(),
      ...fetchProvenance,
    });
  }

  const aggregateDecision = await recomputeAndUpdateAggregate(
    tx,
    existingPr.id
  );

  log.debug("[handlePullRequestReview] Review dismissed", {
    prNumber: pull_request.number,
    reviewerLogin,
    previousAggregate: existingPr.reviewDecision,
    newAggregate: aggregateDecision,
  });
}

/**
 * Handle GitHub pull_request_review webhook events.
 *
 * Supported actions:
 * - submitted: Upserts per-reviewer GitHubPRReview record, recomputes aggregate
 *   reviewDecision, and stores the review's summary body as its own thread
 * - edited: Updates the stored summary thread (PLN-2122 decision 6)
 * - dismissed: Sets specific reviewer's record to DISMISSED, recomputes
 *   aggregate; the summary thread and its body are left as they are
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
  event: HandledPullRequestReviewEvent,
  observationContext?: GitHubWebhookObservationContext
): Promise<Response> {
  const { action, review, pull_request, repository } = event;
  const installationId = event.installation?.id;

  // Early exit for unhandled actions
  if (!HANDLED_ACTIONS.has(action)) {
    log.debug("[handlePullRequestReview] Skipping unhandled action", {
      action,
      prNumber: pull_request.number,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json({
      message: `Ignoring unhandled pull_request_review action: ${action}`,
      ok: true,
    });
  }

  log.debug("[handlePullRequestReview] Processing pull_request_review event", {
    action,
    reviewId: review.id,
    reviewState: review.state,
    prNumber: pull_request.number,
    repositoryId: repository.id,
  });

  // The review decision's reads and writes share one transaction to avoid
  // TOCTOU gaps; the summary thread is written after it commits, so a summary
  // write that fails cannot roll the decision back.
  const persisted = await withDb.tx(async (tx) => {
    // Installation-aware lookup (FEA-2022 / PLN-1034): the same githubRepoId can
    // exist under multiple installations/tenants, so scope by full name + the
    // active installation that delivered this webhook. Without this, a review
    // event could resolve the wrong tenant's repo and bump the wrong branch's
    // activity (mirrors the pull_request handler's findActivePullRequestRepository).
    const repo = await tx.gitHubInstallationRepository.findFirst({
      where: {
        githubRepoId: String(repository.id),
        fullName: repository.full_name,
        removedAt: null,
        installation: {
          installationId: String(installationId),
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: {
        id: true,
        fullName: true,
        installation: { select: { organizationId: true } },
      },
    });

    if (!repo) {
      log.warn("[handlePullRequestReview] Repository not found in database", {
        githubRepoId: repository.id,
        repositoryFullName: repository.full_name,
        action,
        prNumber: pull_request.number,
      });
      return null;
    }

    const prDetail = await tx.pullRequestDetail.findUnique({
      where: {
        repositoryId_number: {
          repositoryId: repo.id,
          number: pull_request.number,
        },
      },
      select: {
        id: true,
        artifactId: true,
        branchArtifactId: true,
        reviewDecision: true,
        artifact: {
          select: {
            // PR is the TARGET of a DOCUMENT → produces → PR link.
            targetLinks: {
              where: {
                linkType: LinkType.Produces,
                source: { type: ArtifactType.DOCUMENT },
              },
              select: {
                source: { select: { id: true, slug: true } },
              },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
        branchArtifact: {
          select: {
            branch: { select: { currentPullRequestDetailId: true } },
            targetLinks: {
              where: {
                linkType: LinkType.Produces,
                source: { type: ArtifactType.DOCUMENT },
              },
              select: {
                source: { select: { id: true, slug: true } },
              },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    });

    if (!prDetail) {
      log.warn("[handlePullRequestReview] Pull request not found in database", {
        repositoryId: repo.id,
        prNumber: pull_request.number,
        action,
        reason: "PR may have been created outside Symphony workflow",
      });
      return null;
    }

    const ownerArtifact = prDetail.branchArtifact ?? prDetail.artifact;
    const linkedDoc = ownerArtifact?.targetLinks[0]?.source ?? null;
    const existingPr = {
      id: prDetail.id,
      documentId: linkedDoc?.id ?? null,
      reviewDecision: prDetail.reviewDecision,
      document: linkedDoc ? { slug: linkedDoc.slug ?? "" } : null,
    };

    if (action === "submitted") {
      await handleSubmittedReview(tx, review, pull_request, existingPr);
    } else if (action === "dismissed") {
      await handleDismissedReview(tx, review, pull_request, existingPr);
    }
    const organizationId = repo.installation?.organizationId;
    if (!organizationId) {
      return null;
    }
    await persistGitHubBranchActivity({
      eventName: GitHubBranchActivityEventName.PullRequestReview,
      deliveryId: observationContext?.deliveryId,
      payload: event,
      attribution: {
        organizationId,
        branchArtifactId: prDetail.branchArtifactId,
        pullRequestDetailId: prDetail.id,
      },
    });
    await emitBranchDetailChanged(
      tx,
      organizationId,
      prDetail.branchArtifactId
    );
    return {
      publication: buildPullRequestReviewDirtyScopePublication({
        review,
        pullRequest: pull_request,
        organizationId,
        repositoryId: repo.id,
        repositoryFullName: repo.fullName ?? repository.full_name,
      }),
      summaryScope: {
        organizationId,
        branchArtifactId: prDetail.branchArtifactId,
        pullRequestDetailId: prDetail.id,
        isCurrentPullRequest: isBranchCurrentPullRequest(
          branchCurrentPullRequestDetailId(prDetail.branchArtifact.branch),
          prDetail.id
        ),
      },
    };
  });
  if (persisted) {
    await publishGitHubDirtyScopes(persisted.publication);
    await applyReviewSummary(action, review, persisted.summaryScope);
  }

  log.debug(
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

/**
 * PLN-2122 decision 6: a review's summary body is its own thread, written
 * through `applyExternal` and ordered by `submitted_at`, which `edited` keeps.
 * A blank body is not stored, so an edit that clears the body deletes the
 * stored summary, as the reconcile's cleanup would, and an edit that restores
 * a body brings it back. A dismissal leaves the thread as it is (campaign
 * ruling). Only the branch's current pull request is written
 * ({@link isBranchCurrentPullRequest}, the comment webhooks' rule). Runs in a
 * transaction of its own, after the review decision's has committed.
 */
async function applyReviewSummary(
  action: HandledPullRequestReviewEvent["action"],
  review: HandledPullRequestReviewEvent["review"],
  scope: {
    organizationId: string;
    branchArtifactId: string;
    pullRequestDetailId: string;
    isCurrentPullRequest: boolean;
  }
): Promise<void> {
  if (
    action === "dismissed" ||
    !scope.isCurrentPullRequest ||
    !review.submitted_at
  ) {
    return;
  }
  const event = reviewSummaryEvent(action, review, review.submitted_at);
  if (!event) {
    return;
  }
  await withGitHubCommentWriteRetry(() =>
    commentsService.applyExternal({
      provider: CommentSyncProvider.Github,
      organizationId: scope.organizationId,
      branchArtifactId: scope.branchArtifactId,
      pullRequestDetailId: scope.pullRequestDetailId,
      fetchProvenance: githubAppWebhookFetchProvenance(),
      events: [event],
    })
  );
}

function buildPullRequestReviewDirtyScopePublication({
  review,
  pullRequest,
  organizationId,
  repositoryId,
  repositoryFullName,
}: {
  review: HandledPullRequestReviewEvent["review"];
  pullRequest: HandledPullRequestReviewEvent["pull_request"];
  organizationId: string;
  repositoryId: string;
  repositoryFullName: string;
}): GitHubDirtyScopePublicationInput {
  return {
    organizationId,
    repositoryId,
    repositoryFullName,
    scopes: [
      {
        kind: GitHubDirtyScopeKind.Review,
        repositoryId,
        repositoryFullName,
        branchName: pullRequest.head.ref,
        pullRequestNumber: pullRequest.number,
        reviewId: String(review.id),
      },
    ],
    triggers: [GitHubDirtyTrigger.Review],
  };
}

function reviewSummaryEvent(
  action: "submitted" | "edited",
  review: HandledPullRequestReviewEvent["review"],
  submittedAt: string
): GitHubReviewSummaryUpsertEvent | GitHubCommentDeleteEvent | null {
  if (review.body?.trim()) {
    return {
      kind: GitHubExternalEventKind.ReviewSummaryUpsert,
      ...(action === "submitted"
        ? { asSubmitted: true }
        : { reviveDeletedBefore: new Date() }),
      reviewId: review.id,
      htmlUrl: review.html_url,
      comment: {
        githubCommentId: review.id,
        htmlUrl: review.html_url,
        bodyMarkdown: review.body,
        author: review.user,
        createdAt: new Date(submittedAt),
        providerUpdatedAt: new Date(submittedAt),
      },
    };
  }
  if (action !== "edited") {
    return null;
  }
  return {
    kind: GitHubExternalEventKind.CommentDelete,
    threadKind: GitHubCommentThreadKind.REVIEW_SUMMARY,
    githubCommentId: review.id,
    providerUpdatedAt: new Date(submittedAt),
  };
}
