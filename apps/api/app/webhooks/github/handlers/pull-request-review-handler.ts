import type {
  PullRequestReviewDismissedEvent,
  PullRequestReviewSubmittedEvent,
} from "@octokit/webhooks-types";
import { LinkType } from "@repo/api/src/types/artifact";
import { ReviewDecision } from "@repo/api/src/types/document";
import {
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import {
  ArtifactType,
  GitHubInstallationStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";

import { bumpBranchActivity } from "@/app/branches/branch-push-state";
import {
  gitHubFetchProvenanceData,
  githubAppWebhookFetchProvenance,
} from "@/lib/github-fetch-provenance";
import { recomputeAndUpdateAggregate } from "@/lib/review-decision-utils";
import {
  type GitHubDirtyScopePublicationInput,
  publishGitHubDirtyScopes,
} from "./dirty-scope-publisher";

/**
 * Union type for pull request review events we handle.
 */
export type HandledPullRequestReviewEvent =
  | PullRequestReviewSubmittedEvent
  | PullRequestReviewDismissedEvent;

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
  await tx.gitHubPRReview.upsert({
    where: {
      pullRequestId_authorLogin: {
        pullRequestId: existingPr.id,
        authorLogin: reviewerLogin,
      },
    },
    create: {
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
    },
    update: {
      githubReviewId: String(review.id),
      authorAvatarUrl: review.user?.avatar_url ?? null,
      state: reviewDecision,
      body: review.body ?? null,
      htmlUrl: review.html_url,
      submittedAt: review.submitted_at
        ? new Date(review.submitted_at)
        : new Date(),
      ...fetchProvenance,
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
    await tx.gitHubPRReview.upsert({
      where: {
        pullRequestId_authorLogin: {
          pullRequestId: existingPr.id,
          authorLogin: reviewerLogin,
        },
      },
      create: {
        pullRequestId: existingPr.id,
        githubReviewId: String(review.id),
        authorLogin: reviewerLogin,
        authorAvatarUrl: review.user?.avatar_url ?? null,
        state: ReviewDecision.Dismissed,
        body: review.body ?? null,
        htmlUrl: review.html_url,
        submittedAt: new Date(),
        ...fetchProvenance,
      },
      update: {
        state: ReviewDecision.Dismissed,
        ...fetchProvenance,
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
  const installationId = event.installation?.id;

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
  const publication = await withDb.tx(async (tx) => {
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
      // PLN-1034: a submitted review is genuine branch activity. Monotonic bump
      // keyed on the branch artifact (not the PR-detail id used above).
      await bumpBranchActivity(
        tx,
        prDetail.branchArtifactId,
        review.submitted_at ? new Date(review.submitted_at) : new Date()
      );
    } else if (action === "dismissed") {
      await handleDismissedReview(tx, review, pull_request, existingPr);
    }
    const organizationId = repo.installation?.organizationId;
    if (!organizationId) {
      return null;
    }
    return buildPullRequestReviewDirtyScopePublication({
      review,
      pullRequest: pull_request,
      organizationId,
      repositoryId: repo.id,
      repositoryFullName: repo.fullName ?? repository.full_name,
    });
  });
  if (publication) {
    await publishGitHubDirtyScopes(publication);
  }

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
