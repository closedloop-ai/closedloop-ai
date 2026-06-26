import type {
  PullRequestReviewCommentCreatedEvent,
  PullRequestReviewCommentDeletedEvent,
  PullRequestReviewCommentEditedEvent,
} from "@octokit/webhooks-types";
import {
  GitHubCommentThreadKind,
  GitHubLegacyCommentState,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { resolveExternalGitHubAuthorInTransaction } from "@/app/comments/external-authors";
import { normalizeGitHubDiffSide } from "@/app/comments/github-diff-side";
import {
  GitHubProjectionNoWriteError,
  softDeleteGitHubCommentByRemoteId,
  upsertGitHubReviewCommentThread,
} from "@/app/comments/github-projection";
import { resolveGitHubCommentOwner } from "../comment-owner-resolver";
import {
  type CommentWebhookPrContext,
  loadPrContextForCommentWebhook,
} from "./pr-comment-context";

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
 * - created: Upserts unified GitHub comment projection
 * - edited: Updates the unified GitHub comment projection; if GitHub delivers
 *   edited before created, the first projection write emits the added event
 * - deleted: Soft-deletes the unified GitHub comment projection by githubCommentId
 */
export async function handlePullRequestReviewComment(
  event: HandledPullRequestReviewCommentEvent
): Promise<Response> {
  const { action, comment, pull_request, repository } = event;
  const installationId = event.installation?.id;

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

  log.info(
    "[handlePullRequestReviewComment] Processing pull_request_review_comment event",
    {
      action,
      commentId: comment.id,
      prNumber: pull_request.number,
      prTitle: pull_request.title,
      repositoryId: repository.id,
      installationId,
    }
  );

  // All reads and writes in a single transaction to avoid TOCTOU gaps
  await withDb.tx(async (tx) => {
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
      return;
    }

    const existingPr = await loadPrContextForCommentWebhook(tx, {
      ownerResolution,
      prNumber: pull_request.number,
      action,
      logPrefix: "[handlePullRequestReviewComment]",
    });

    if (!existingPr) {
      return;
    }

    // Step 3: Handle comment action
    switch (action) {
      case "created": {
        await handleCreatedComment(
          tx,
          existingPr,
          comment,
          pull_request,
          ownerResolution.organizationId
        );
        break;
      }

      case "edited": {
        await handleEditedComment(
          tx,
          existingPr,
          comment,
          pull_request,
          ownerResolution.organizationId
        );
        break;
      }

      case "deleted": {
        await handleDeletedComment(
          tx,
          existingPr,
          comment,
          pull_request,
          ownerResolution.organizationId
        );
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

async function handleCreatedComment(
  tx: TransactionClient,
  existingPr: CommentWebhookPrContext,
  comment: HandledPullRequestReviewCommentEvent["comment"],
  pull_request: HandledPullRequestReviewCommentEvent["pull_request"],
  organizationId: string
): Promise<void> {
  const author = await resolveExternalGitHubAuthorInTransaction(tx, {
    organizationId,
    author: comment.user,
    source: {
      sourceKind: "review_comment",
      githubObjectId: String(comment.id),
      pullNumber: pull_request.number,
    },
  });

  const projectionInput: Parameters<typeof upsertGitHubReviewCommentThread>[1] =
    {
      organizationId,
      branchArtifactId: existingPr.branchArtifactId,
      pullRequestDetailId: existingPr.id,
      reviewThreadId: null,
      reviewId: comment.pull_request_review_id
        ? String(comment.pull_request_review_id)
        : null,
      rootCommentId: comment.in_reply_to_id ?? comment.id,
      path: comment.path,
      line: comment.line,
      side: normalizeGitHubDiffSide(comment.side),
      startLine: comment.start_line ?? null,
      startSide: normalizeGitHubDiffSide(comment.start_side),
      commitSha: comment.commit_id ?? null,
      htmlUrl: comment.html_url,
      legacyState: GitHubLegacyCommentState.PENDING,
      lastSyncedAt: new Date(),
      comments: [
        {
          githubCommentId: comment.id,
          githubInReplyToCommentId: comment.in_reply_to_id ?? null,
          githubHtmlUrl: comment.html_url,
          githubUpdatedAt: new Date(comment.updated_at),
          bodyMarkdown: comment.body,
          author: {
            userId: author.user.id,
            externalAuthorId: author.externalAuthor.id,
          },
          createdAt: new Date(comment.created_at),
        },
      ],
    };

  const projectionResult = await upsertReviewCommentThreadOrSkip(tx, {
    action: "created",
    input: projectionInput,
    prNumber: pull_request.number,
  });
  if (!projectionResult) {
    return;
  }

  log.info("[handlePullRequestReviewComment] Review comment created", {
    commentId: comment.id,
    prNumber: pull_request.number,
    path: comment.path,
    line: comment.line,
  });
}

async function handleEditedComment(
  tx: TransactionClient,
  existingPr: CommentWebhookPrContext,
  comment: HandledPullRequestReviewCommentEvent["comment"],
  pull_request: HandledPullRequestReviewCommentEvent["pull_request"],
  organizationId: string
): Promise<void> {
  const author = await resolveExternalGitHubAuthorInTransaction(tx, {
    organizationId,
    author: comment.user,
    source: {
      sourceKind: "review_comment",
      githubObjectId: String(comment.id),
      pullNumber: pull_request.number,
    },
  });

  const projectionInput: Parameters<typeof upsertGitHubReviewCommentThread>[1] =
    {
      organizationId,
      branchArtifactId: existingPr.branchArtifactId,
      pullRequestDetailId: existingPr.id,
      reviewThreadId: null,
      reviewId: comment.pull_request_review_id
        ? String(comment.pull_request_review_id)
        : null,
      rootCommentId: comment.in_reply_to_id ?? comment.id,
      path: comment.path,
      line: comment.line,
      side: normalizeGitHubDiffSide(comment.side),
      startLine: comment.start_line ?? null,
      startSide: normalizeGitHubDiffSide(comment.start_side),
      commitSha: comment.commit_id ?? null,
      htmlUrl: comment.html_url,
      legacyState: GitHubLegacyCommentState.PENDING,
      lastSyncedAt: new Date(),
      comments: [
        {
          githubCommentId: comment.id,
          githubInReplyToCommentId: comment.in_reply_to_id ?? null,
          githubHtmlUrl: comment.html_url,
          githubUpdatedAt: new Date(comment.updated_at),
          bodyMarkdown: comment.body,
          author: {
            userId: author.user.id,
            externalAuthorId: author.externalAuthor.id,
          },
          createdAt: new Date(comment.created_at),
        },
      ],
    };

  const projectionResult = await upsertReviewCommentThreadOrSkip(tx, {
    action: "edited",
    input: projectionInput,
    prNumber: pull_request.number,
  });
  if (!projectionResult) {
    return;
  }

  log.info("[handlePullRequestReviewComment] Review comment edited", {
    commentId: comment.id,
    prNumber: pull_request.number,
  });
}

async function handleDeletedComment(
  tx: TransactionClient,
  existingPr: CommentWebhookPrContext,
  comment: HandledPullRequestReviewCommentEvent["comment"],
  pull_request: HandledPullRequestReviewCommentEvent["pull_request"],
  organizationId: string
): Promise<void> {
  const deletedComment = await softDeleteGitHubCommentByRemoteId(tx, {
    organizationId,
    branchArtifactId: existingPr.branchArtifactId,
    pullRequestDetailId: existingPr.id,
    githubCommentId: comment.id,
    deletedAt: new Date(),
    threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
  });

  if (deletedComment.comments === 0) {
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
}

/**
 * Converts scoped projection no-write conflicts into bounded webhook skips while
 * preserving unexpected errors for the top-level webhook failure path.
 */
async function upsertReviewCommentThreadOrSkip(
  tx: TransactionClient,
  ctx: {
    action: "created" | "edited";
    input: Parameters<typeof upsertGitHubReviewCommentThread>[1];
    prNumber: number;
  }
): Promise<Awaited<ReturnType<typeof upsertGitHubReviewCommentThread>> | null> {
  try {
    return await upsertGitHubReviewCommentThread(tx, ctx.input);
  } catch (error) {
    if (!(error instanceof GitHubProjectionNoWriteError)) {
      throw error;
    }
    log.warn("[handlePullRequestReviewComment] Skipping projection no-write", {
      action: ctx.action,
      branchArtifactId: ctx.input.branchArtifactId,
      code: error.code,
      details: error.details,
      githubCommentId: ctx.input.comments[0]?.githubCommentId ?? null,
      organizationId: ctx.input.organizationId,
      prNumber: ctx.prNumber,
      pullRequestDetailId: ctx.input.pullRequestDetailId,
      reviewId: ctx.input.reviewId,
      rootCommentId: ctx.input.rootCommentId,
    });
    return null;
  }
}
