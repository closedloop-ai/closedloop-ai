import type {
  PullRequestReviewCommentCreatedEvent,
  PullRequestReviewCommentDeletedEvent,
  PullRequestReviewCommentEditedEvent,
} from "@octokit/webhooks-types";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";

/**
 * Actions this handler processes. All other actions are ignored with an early return.
 */
const HANDLED_ACTIONS = new Set(["created", "edited", "deleted"]);

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
 * - created: Creates GitHubPRReviewComment record, creates GITHUB_PR_COMMENT_ADDED workstream event
 * - edited: Updates body field on existing GitHubPRReviewComment
 * - deleted: Deletes GitHubPRReviewComment record by githubCommentId
 */
export async function handlePullRequestReviewComment(
  event: HandledPullRequestReviewCommentEvent
): Promise<Response> {
  const { action, comment, pull_request, repository } = event;

  // Early exit for unhandled actions
  if (!HANDLED_ACTIONS.has(action)) {
    log.info("[handlePullRequestReviewComment] Skipping unhandled action", {
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

  log.info(
    "[handlePullRequestReviewComment] Processing pull_request_review_comment event",
    {
      action,
      commentId: comment.id,
      prNumber: pull_request.number,
      prTitle: pull_request.title,
      repositoryId: repository.id,
    }
  );

  // All reads and writes in a single transaction to avoid TOCTOU gaps
  await withDb.tx(async (tx) => {
    // Step 1: Find GitHubInstallationRepository by githubRepoId
    const repo = await tx.gitHubInstallationRepository.findFirst({
      where: { githubRepoId: repository.id },
      select: { id: true },
    });

    if (!repo) {
      log.warn(
        "[handlePullRequestReviewComment] Repository not found in database",
        {
          githubRepoId: repository.id,
          repositoryFullName: repository.full_name,
          action,
          prNumber: pull_request.number,
        }
      );
      return;
    }

    // Step 2: Find GitHubPullRequest by repositoryId + number
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
        artifact: { select: { slug: true } },
      },
    });

    if (!existingPr) {
      log.warn(
        "[handlePullRequestReviewComment] Pull request not found in database",
        {
          repositoryId: repo.id,
          prNumber: pull_request.number,
          action,
          reason: "PR may have been created outside Symphony workflow",
        }
      );
      return;
    }

    // Step 3: Handle comment action
    switch (action) {
      case "created": {
        // Upsert GitHubPRReviewComment record (idempotent for webhook retries)
        await tx.gitHubPRReviewComment.upsert({
          where: { githubCommentId: BigInt(comment.id) },
          create: {
            pullRequestId: existingPr.id,
            githubCommentId: BigInt(comment.id),
            reviewId: comment.pull_request_review_id
              ? BigInt(comment.pull_request_review_id)
              : null,
            body: comment.body,
            path: comment.path,
            line: comment.line,
            authorLogin: comment.user.login,
            authorAvatarUrl: comment.user.avatar_url,
            state: "PENDING",
            htmlUrl: comment.html_url,
          },
          update: {
            body: comment.body,
            path: comment.path,
            line: comment.line,
            reviewId: comment.pull_request_review_id
              ? BigInt(comment.pull_request_review_id)
              : null,
          },
        });

        // Create workstream event
        await tx.workstreamEvent.create({
          data: {
            workstreamId: existingPr.workstreamId,
            type: "GITHUB_PR_COMMENT_ADDED",
            actorType: "system",
            data: {
              commentId: comment.id,
              commentBody: comment.body,
              commentPath: comment.path,
              commentLine: comment.line,
              authorLogin: comment.user.login,
              prNumber: pull_request.number,
              prTitle: pull_request.title,
              prUrl: pull_request.html_url,
              commentUrl: comment.html_url,
              artifactId: existingPr.artifactId,
              artifactSlug: existingPr.artifact?.slug,
            },
          },
        });

        log.info("[handlePullRequestReviewComment] Review comment created", {
          commentId: comment.id,
          prNumber: pull_request.number,
          path: comment.path,
          line: comment.line,
        });
        break;
      }

      case "edited": {
        // Update body field on existing GitHubPRReviewComment
        const updatedComment = await tx.gitHubPRReviewComment.updateMany({
          where: {
            githubCommentId: BigInt(comment.id),
          },
          data: {
            body: comment.body,
          },
        });

        if (updatedComment.count === 0) {
          log.warn(
            "[handlePullRequestReviewComment] Comment not found for update",
            {
              githubCommentId: comment.id,
              prNumber: pull_request.number,
              reason: "Comment may not have been tracked by Symphony",
            }
          );
        } else {
          log.info("[handlePullRequestReviewComment] Review comment edited", {
            commentId: comment.id,
            prNumber: pull_request.number,
          });
        }
        break;
      }

      case "deleted": {
        // Delete GitHubPRReviewComment by githubCommentId
        const deletedComment = await tx.gitHubPRReviewComment.deleteMany({
          where: {
            githubCommentId: BigInt(comment.id),
          },
        });

        if (deletedComment.count === 0) {
          log.warn(
            "[handlePullRequestReviewComment] Comment not found for deletion",
            {
              githubCommentId: comment.id,
              prNumber: pull_request.number,
              reason: "Comment may not have been tracked by Symphony",
            }
          );
        } else {
          log.info("[handlePullRequestReviewComment] Review comment deleted", {
            commentId: comment.id,
            prNumber: pull_request.number,
          });
        }
        break;
      }

      default: {
        log.warn("[handlePullRequestReviewComment] Unhandled action type", {
          action: action as string,
        });
      }
    }
  });

  log.info(
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
