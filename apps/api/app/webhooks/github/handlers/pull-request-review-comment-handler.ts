import type {
  PullRequestReviewCommentCreatedEvent,
  PullRequestReviewCommentDeletedEvent,
  PullRequestReviewCommentEditedEvent,
} from "@octokit/webhooks-types";
import { CommentSyncProvider } from "@repo/api/src/types/comment-thread-dto";
import {
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import { GitHubCommentThreadKind, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { commentsService } from "@/app/comments/service";
import {
  ApplyExternalOutcome,
  type GitHubExternalEvent,
  GitHubExternalEventKind,
} from "@/app/comments/service/github/apply-external-events";
import { withGitHubCommentWriteRetry } from "@/app/comments/service/github/github-comment-write-retry";
import {
  gitHubExternalReviewComment,
  gitHubReviewThreadPosition,
} from "@/app/comments/service/github/github-external-comment";
import type { GitHubWebhookObservationContext } from "@/lib/github/github-webhook-observation";
import { githubAppWebhookFetchProvenance } from "@/lib/github-fetch-provenance";
import { resolveGitHubCommentOwner } from "../comment-owner-resolver";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "./branch-activity-producer";
import {
  type GitHubDirtyScopePublicationInput,
  publishGitHubDirtyScopes,
} from "./dirty-scope-publisher";
import {
  type CommentWebhookPrContext,
  loadPrContextForCommentWebhook,
  webhookDeliveryReachedProjection,
} from "./pr-comment-context";

/**
 * Actions this handler processes. All other actions are ignored with an early return.
 */
const HANDLED_ACTIONS = new Set<HandledPullRequestReviewCommentEvent["action"]>(
  ["created", "edited", "deleted"]
);

/**
 * Union type for pull request review comment events we handle.
 */
export type HandledPullRequestReviewCommentEvent =
  | PullRequestReviewCommentCreatedEvent
  | PullRequestReviewCommentEditedEvent
  | PullRequestReviewCommentDeletedEvent;

/**
 * Handle GitHub pull_request_review_comment webhook events.
 *
 * Supported actions:
 * - created / edited: upserts the review comment's thread through
 *   `applyExternal`; a delivery older than the stored comment, or for a
 *   deleted one, is dropped
 * - deleted: deletes it through `applyExternal`; the delete is terminal
 */
export async function handlePullRequestReviewComment(
  event: HandledPullRequestReviewCommentEvent,
  observationContext?: GitHubWebhookObservationContext
): Promise<Response> {
  const { action, comment, pull_request, repository } = event;
  const installationId = event.installation?.id;

  // Early exit for unhandled actions
  if (!HANDLED_ACTIONS.has(action)) {
    log.debug("[handlePullRequestReviewComment] Skipping unhandled action", {
      action,
      commentId: comment.id,
      prNumber: pull_request.number,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json({
      message: `Ignoring unhandled pull_request_review_comment action: ${action}`,
      ok: true,
    });
  }
  if (!installationId) {
    log.warn("[handlePullRequestReviewComment] Missing installation on event", {
      action,
      commentId: comment.id,
      prNumber: pull_request.number,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json(
      { message: "Missing installation", ok: false },
      { status: 400 }
    );
  }

  log.debug(
    "[handlePullRequestReviewComment] Processing pull_request_review_comment event",
    {
      action,
      commentId: comment.id,
      prNumber: pull_request.number,
      repositoryId: repository.id,
      installationId,
    }
  );

  // All reads and writes in a single transaction to avoid TOCTOU gaps
  const publication = await withGitHubCommentWriteRetry(() =>
    withDb.tx(async (tx) => {
      const ownerResolution = await resolveGitHubCommentOwner(tx, {
        installationId,
        repositoryId: repository.id,
        pullNumber: pull_request.number,
      });

      if (!ownerResolution.ok) {
        log.warn("[handlePullRequestReviewComment] Owner resolution failed", {
          code: ownerResolution.code,
          installationId,
          githubRepoId: repository.id,
          repositoryFullName: repository.full_name,
          action,
          prNumber: pull_request.number,
        });
        return null;
      }

      const existingPr = await loadPrContextForCommentWebhook(tx, {
        ownerResolution,
        prNumber: pull_request.number,
        action,
        logPrefix: "[handlePullRequestReviewComment]",
      });

      if (!existingPr) {
        return null;
      }

      if (!existingPr.isCurrentPullRequest) {
        await persistReviewCommentActivity(
          event,
          existingPr,
          ownerResolution.organizationId,
          observationContext
        );
        return null;
      }

      const wroteProjection = await dispatchReviewCommentAction(event, {
        existingPr,
        organizationId: ownerResolution.organizationId,
      });
      if (!wroteProjection) {
        return null;
      }
      await persistReviewCommentActivity(
        event,
        existingPr,
        ownerResolution.organizationId,
        observationContext
      );
      return buildReviewCommentDirtyScopePublication({
        comment,
        pullRequest: pull_request,
        organizationId: ownerResolution.organizationId,
        repositoryId: ownerResolution.repositoryRecordId,
        repositoryFullName: repository.full_name,
      });
    })
  );
  if (publication) {
    await publishGitHubDirtyScopes(publication);
  }

  log.debug(
    "[handlePullRequestReviewComment] Successfully processed pull_request_review_comment event",
    {
      action,
      commentId: comment.id,
      prNumber: pull_request.number,
      githubRepoId: repository.id,
    }
  );

  return NextResponse.json({
    message: "Event processed successfully",
    ok: true,
  });
}
function reviewCommentEvent(
  event: HandledPullRequestReviewCommentEvent
): GitHubExternalEvent {
  const { comment } = event;
  if (event.action === "deleted") {
    return {
      kind: GitHubExternalEventKind.CommentDelete,
      threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
      githubCommentId: comment.id,
      providerUpdatedAt: new Date(comment.updated_at),
    };
  }
  return {
    kind: GitHubExternalEventKind.ReviewThreadUpsert,
    reviewThreadId: null,
    reviewId: comment.pull_request_review_id
      ? String(comment.pull_request_review_id)
      : null,
    rootCommentId: comment.in_reply_to_id ?? comment.id,
    position: gitHubReviewThreadPosition(comment),
    htmlUrl: comment.html_url,
    comments: [gitHubExternalReviewComment(comment)],
    ...(comment.in_reply_to_id ? { threadFieldsFromReply: true } : {}),
  };
}

function buildReviewCommentDirtyScopePublication({
  comment,
  pullRequest,
  organizationId,
  repositoryId,
  repositoryFullName,
}: {
  comment: HandledPullRequestReviewCommentEvent["comment"];
  pullRequest: HandledPullRequestReviewCommentEvent["pull_request"];
  organizationId: string;
  repositoryId: string;
  repositoryFullName: string;
}): GitHubDirtyScopePublicationInput {
  const scope = {
    kind: GitHubDirtyScopeKind.Comment,
    repositoryId,
    repositoryFullName,
    branchName: pullRequest.head.ref,
    pullRequestNumber: pullRequest.number,
    commentId: String(comment.id),
    ...(comment.pull_request_review_id
      ? { reviewId: String(comment.pull_request_review_id) }
      : {}),
  };
  return {
    organizationId,
    repositoryId,
    repositoryFullName,
    scopes: [scope],
    triggers: [GitHubDirtyTrigger.ReviewComment],
  };
}

/** Persist authoritative review-comment activity in the caller's transaction. */
function persistReviewCommentActivity(
  event: HandledPullRequestReviewCommentEvent,
  existingPr: CommentWebhookPrContext,
  organizationId: string,
  observationContext?: GitHubWebhookObservationContext
) {
  return persistGitHubBranchActivity({
    eventName: GitHubBranchActivityEventName.PullRequestReviewComment,
    deliveryId: observationContext?.deliveryId,
    payload: event,
    attribution: {
      organizationId,
      branchArtifactId: existingPr.branchArtifactId,
      pullRequestDetailId: existingPr.id,
    },
  });
}

/**
 * Apply the event through `applyExternal` (PLN-2122 Step 4) before activity
 * persistence; its ordering guard drops a delivery older than the stored
 * comment and never brings a deleted comment back.
 */
async function dispatchReviewCommentAction(
  event: HandledPullRequestReviewCommentEvent,
  context: {
    existingPr: CommentWebhookPrContext;
    organizationId: string;
  }
): Promise<boolean> {
  const result = await commentsService.applyExternal({
    provider: CommentSyncProvider.Github,
    organizationId: context.organizationId,
    branchArtifactId: context.existingPr.branchArtifactId,
    pullRequestDetailId: context.existingPr.id,
    fetchProvenance: githubAppWebhookFetchProvenance(),
    events: [reviewCommentEvent(event)],
  });
  const outcome = result.outcomes[0] ?? ApplyExternalOutcome.NotFound;
  if (outcome === ApplyExternalOutcome.NotFound) {
    log.warn(
      "[handlePullRequestReviewComment] Comment not found for deletion",
      {
        githubCommentId: event.comment.id,
        prNumber: event.pull_request.number,
        reason: "Comment may not have been tracked by Symphony",
      }
    );
  }
  return webhookDeliveryReachedProjection(outcome);
}
