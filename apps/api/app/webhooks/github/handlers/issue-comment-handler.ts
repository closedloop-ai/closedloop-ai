import type {
  IssueCommentCreatedEvent,
  IssueCommentDeletedEvent,
  IssueCommentEditedEvent,
} from "@octokit/webhooks-types";
import { CommentSyncProvider } from "@repo/api/src/types/comment-thread-dto";
import {
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import {
  GitHubCommentThreadKind,
  GitHubLegacyCommentState,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { commentsService } from "@/app/comments/service";
import {
  ApplyExternalOutcome,
  type GitHubExternalEvent,
  GitHubExternalEventKind,
} from "@/app/comments/service/github/apply-external-events";
import { withGitHubCommentWriteRetry } from "@/app/comments/service/github/github-comment-write-retry";
import { gitHubExternalComment } from "@/app/comments/service/github/github-external-comment";
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
const HANDLED_ACTIONS = new Set<HandledIssueCommentEvent["action"]>([
  "created",
  "edited",
  "deleted",
]);

/**
 * Union type for issue comment events we handle.
 */
export type HandledIssueCommentEvent =
  | IssueCommentCreatedEvent
  | IssueCommentEditedEvent
  | IssueCommentDeletedEvent;

/**
 * Handle GitHub issue_comment webhook events for PR conversation comments.
 *
 * The issue_comment event fires for both issues and PRs. We gate on
 * `event.issue.pull_request` to skip non-PR events.
 *
 * Supported actions:
 * - created / edited: upserts the issue comment through `applyExternal`; a
 *   delivery older than the stored comment, or for a deleted one, is dropped
 * - deleted: deletes it through `applyExternal`; the delete is terminal
 */
export async function handleIssueComment(
  event: HandledIssueCommentEvent,
  observationContext?: GitHubWebhookObservationContext
): Promise<Response> {
  const { action, comment, issue, repository } = event;
  const installationId = event.installation?.id;

  // Skip non-PR issue comments
  if (!issue.pull_request) {
    return NextResponse.json({
      message: "Ignoring non-PR issue comment",
      ok: true,
    });
  }

  // Early exit for unhandled actions
  if (!HANDLED_ACTIONS.has(action)) {
    return NextResponse.json({
      message: `Ignoring unhandled issue_comment action: ${action}`,
      ok: true,
    });
  }
  if (!installationId) {
    log.warn("[handleIssueComment] Missing installation on event", {
      action,
      commentId: comment.id,
      issueNumber: issue.number,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json(
      { message: "Missing installation", ok: false },
      { status: 400 }
    );
  }

  const publication = await withGitHubCommentWriteRetry(() =>
    withDb.tx(async (tx) => {
      const ownerResolution = await resolveGitHubCommentOwner(tx, {
        installationId,
        repositoryId: repository.id,
        pullNumber: issue.number,
      });

      if (!ownerResolution.ok) {
        log.warn("[handleIssueComment] Owner resolution failed", {
          code: ownerResolution.code,
          installationId,
          githubRepoId: repository.id,
          repositoryFullName: repository.full_name,
          action,
          prNumber: issue.number,
        });
        return null;
      }

      const existingPr = await loadPrContextForCommentWebhook(tx, {
        ownerResolution,
        prNumber: issue.number,
        action,
        logPrefix: "[handleIssueComment]",
      });

      if (!existingPr) {
        return null;
      }

      if (!existingPr.isCurrentPullRequest) {
        await persistIssueCommentActivity(
          event,
          existingPr,
          ownerResolution.organizationId,
          observationContext
        );
        return null;
      }

      const wroteProjection = await dispatchIssueCommentAction(action, {
        comment,
        issue,
        existingPr,
        organizationId: ownerResolution.organizationId,
      });
      if (!wroteProjection) {
        return null;
      }
      await persistIssueCommentActivity(
        event,
        existingPr,
        ownerResolution.organizationId,
        observationContext
      );
      return buildIssueCommentDirtyScopePublication({
        comment,
        issue,
        organizationId: ownerResolution.organizationId,
        repositoryId: ownerResolution.repositoryRecordId,
        repositoryFullName: repository.full_name,
      });
    })
  );
  if (publication) {
    await publishGitHubDirtyScopes(publication);
  }

  return NextResponse.json({
    message: "Event processed successfully",
    ok: true,
  });
}

type DispatchContext = {
  comment: HandledIssueCommentEvent["comment"];
  issue: HandledIssueCommentEvent["issue"];
  existingPr: CommentWebhookPrContext;
  organizationId: string;
};

/**
 * Every action goes through `applyExternal` (PLN-2122 Step 4), whose ordering
 * guard drops a delivery older than the stored comment and never brings a
 * deleted comment back. Returns whether the delivery reached the projection.
 */
async function dispatchIssueCommentAction(
  action: HandledIssueCommentEvent["action"],
  ctx: DispatchContext
): Promise<boolean> {
  const result = await commentsService.applyExternal({
    provider: CommentSyncProvider.Github,
    organizationId: ctx.organizationId,
    branchArtifactId: ctx.existingPr.branchArtifactId,
    pullRequestDetailId: ctx.existingPr.id,
    fetchProvenance: githubAppWebhookFetchProvenance(),
    events: [issueCommentEvent(action, ctx.comment)],
  });
  const outcome = result.outcomes[0] ?? ApplyExternalOutcome.NotFound;
  if (outcome === ApplyExternalOutcome.NotFound) {
    log.warn("[handleIssueComment] Comment not found for deletion", {
      githubCommentId: ctx.comment.id,
      prNumber: ctx.issue.number,
    });
  }
  return webhookDeliveryReachedProjection(outcome);
}

function issueCommentEvent(
  action: HandledIssueCommentEvent["action"],
  comment: HandledIssueCommentEvent["comment"]
): GitHubExternalEvent {
  if (action === "deleted") {
    return {
      kind: GitHubExternalEventKind.CommentDelete,
      threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
      githubCommentId: comment.id,
      providerUpdatedAt: new Date(comment.updated_at),
    };
  }
  return {
    kind: GitHubExternalEventKind.IssueCommentUpsert,
    htmlUrl: comment.html_url,
    legacyState: GitHubLegacyCommentState.PENDING,
    comment: gitHubExternalComment(comment),
  };
}

function buildIssueCommentDirtyScopePublication({
  comment,
  issue,
  organizationId,
  repositoryId,
  repositoryFullName,
}: {
  comment: HandledIssueCommentEvent["comment"];
  issue: HandledIssueCommentEvent["issue"];
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
        kind: GitHubDirtyScopeKind.Comment,
        repositoryId,
        repositoryFullName,
        pullRequestNumber: issue.number,
        commentId: String(comment.id),
      },
    ],
    triggers: [GitHubDirtyTrigger.IssueComment],
  };
}

/** Persist authoritative issue-comment activity for an associated PR. */
function persistIssueCommentActivity(
  event: HandledIssueCommentEvent,
  existingPr: CommentWebhookPrContext,
  organizationId: string,
  observationContext?: GitHubWebhookObservationContext
) {
  return persistGitHubBranchActivity({
    eventName: GitHubBranchActivityEventName.IssueComment,
    deliveryId: observationContext?.deliveryId,
    payload: event,
    attribution: {
      organizationId,
      branchArtifactId: existingPr.branchArtifactId,
      pullRequestDetailId: existingPr.id,
    },
  });
}
