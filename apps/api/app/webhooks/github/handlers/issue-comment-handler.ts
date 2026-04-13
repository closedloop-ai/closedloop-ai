import type {
  IssueCommentCreatedEvent,
  IssueCommentDeletedEvent,
  IssueCommentEditedEvent,
} from "@octokit/webhooks-types";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";

/**
 * Actions this handler processes. All other actions are ignored with an early return.
 */
const HANDLED_ACTIONS = new Set(["created", "edited", "deleted"]);

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
 * - created: Upserts GitHubPRReviewComment with path=null, line=null, reviewId=null
 * - edited: Updates body on existing record
 * - deleted: Deletes record by githubCommentId
 */
export async function handleIssueComment(
  event: HandledIssueCommentEvent
): Promise<Response> {
  const { action, comment, issue, repository } = event;

  // Skip non-PR issue comments
  if (!issue.pull_request) {
    return NextResponse.json({
      message: "Ignoring non-PR issue comment",
      ok: true,
    });
  }

  // Early exit for unhandled actions
  if (!HANDLED_ACTIONS.has(action)) {
    log.info("[handleIssueComment] Skipping unhandled action", {
      action,
      commentId: comment.id,
      issueNumber: issue.number,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json({
      message: `Ignoring unhandled issue_comment action: ${action}`,
      ok: true,
    });
  }

  log.info("[handleIssueComment] Processing issue_comment event", {
    action,
    commentId: comment.id,
    prNumber: issue.number,
    prTitle: issue.title,
    repositoryId: repository.id,
  });

  await withDb.tx(async (tx) => {
    // Find GitHubInstallationRepository by githubRepoId
    const repo = await tx.gitHubInstallationRepository.findFirst({
      where: { githubRepoId: String(repository.id) },
      select: { id: true },
    });

    if (!repo) {
      log.warn("[handleIssueComment] Repository not found in database", {
        githubRepoId: repository.id,
        repositoryFullName: repository.full_name,
        action,
        prNumber: issue.number,
      });
      return;
    }

    // Find GitHubPullRequest by repositoryId + number
    const existingPr = await tx.gitHubPullRequest.findUnique({
      where: {
        repositoryId_number: {
          repositoryId: repo.id,
          number: issue.number,
        },
      },
      select: {
        id: true,
        workstreamId: true,
        artifactId: true,
        artifact: { select: { slug: true } },
      },
    });

    if (!existingPr) {
      log.warn("[handleIssueComment] Pull request not found in database", {
        repositoryId: repo.id,
        prNumber: issue.number,
        action,
        reason: "PR may have been created outside Symphony workflow",
      });
      return;
    }

    switch (action) {
      case "created": {
        await tx.gitHubPRReviewComment.upsert({
          where: { githubCommentId: String(comment.id) },
          create: {
            pullRequestId: existingPr.id,
            githubCommentId: String(comment.id),
            reviewId: null,
            body: comment.body,
            path: null,
            line: null,
            authorLogin: comment.user.login,
            authorAvatarUrl: comment.user.avatar_url,
            state: "PENDING",
            htmlUrl: comment.html_url,
            createdAt: new Date(comment.created_at),
          },
          update: {
            body: comment.body,
          },
        });

        await tx.workstreamEvent.create({
          data: {
            workstreamId: existingPr.workstreamId,
            type: "GITHUB_PR_COMMENT_ADDED",
            actorType: "system",
            data: {
              commentId: comment.id,
              commentBody: comment.body,
              authorLogin: comment.user.login,
              prNumber: issue.number,
              prTitle: issue.title,
              prUrl: issue.html_url,
              commentUrl: comment.html_url,
              artifactId: existingPr.artifactId,
              artifactSlug: existingPr.artifact?.slug,
              commentKind: "issue_comment",
            },
          },
        });

        log.info("[handleIssueComment] Issue comment created", {
          commentId: comment.id,
          prNumber: issue.number,
        });
        break;
      }

      case "edited": {
        const updatedComment = await tx.gitHubPRReviewComment.updateMany({
          where: { githubCommentId: String(comment.id) },
          data: { body: comment.body },
        });

        if (updatedComment.count === 0) {
          log.warn("[handleIssueComment] Comment not found for update", {
            githubCommentId: comment.id,
            prNumber: issue.number,
          });
        } else {
          log.info("[handleIssueComment] Issue comment edited", {
            commentId: comment.id,
            prNumber: issue.number,
          });
        }
        break;
      }

      case "deleted": {
        const deletedComment = await tx.gitHubPRReviewComment.deleteMany({
          where: { githubCommentId: String(comment.id) },
        });

        if (deletedComment.count === 0) {
          log.warn("[handleIssueComment] Comment not found for deletion", {
            githubCommentId: comment.id,
            prNumber: issue.number,
          });
        } else {
          log.info("[handleIssueComment] Issue comment deleted", {
            commentId: comment.id,
            prNumber: issue.number,
          });
        }
        break;
      }

      default: {
        log.warn("[handleIssueComment] Unhandled action type", {
          action: action as string,
        });
      }
    }
  });

  log.info("[handleIssueComment] Successfully processed issue_comment event", {
    action,
    commentId: comment.id,
    prNumber: issue.number,
    githubRepoId: repository.id,
  });

  return NextResponse.json({
    message: "Event processed successfully",
    ok: true,
  });
}
