import type {
  IssueCommentCreatedEvent,
  IssueCommentDeletedEvent,
  IssueCommentEditedEvent,
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
import {
  GitHubProjectionNoWriteError,
  softDeleteGitHubCommentByRemoteId,
  upsertGitHubIssueCommentThread,
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
 * - created: Upserts unified GitHub issue-comment projection and creates one first-time GITHUB_PR_COMMENT_ADDED event
 * - edited: Updates the unified GitHub issue-comment projection; if GitHub
 *   delivers edited before created, the first projection write emits the added event
 * - deleted: Soft-deletes the unified GitHub issue-comment projection
 */
export async function handleIssueComment(
  event: HandledIssueCommentEvent
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

  log.info("[handleIssueComment] Processing issue_comment event", {
    action,
    commentId: comment.id,
    prNumber: issue.number,
    prTitle: issue.title,
    repositoryId: repository.id,
    installationId,
  });

  await withDb.tx(async (tx) => {
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
      return;
    }

    const existingPr = await loadPrContextForCommentWebhook(tx, {
      ownerResolution,
      prNumber: issue.number,
      action,
      logPrefix: "[handleIssueComment]",
    });

    if (!existingPr) {
      return;
    }

    await dispatchIssueCommentAction(tx, action, {
      comment,
      issue,
      existingPr,
      organizationId: ownerResolution.organizationId,
    });
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

type DispatchContext = {
  comment: HandledIssueCommentEvent["comment"];
  issue: HandledIssueCommentEvent["issue"];
  existingPr: CommentWebhookPrContext;
  organizationId: string;
};

async function dispatchIssueCommentAction(
  tx: TransactionClient,
  action: HandledIssueCommentEvent["action"],
  ctx: DispatchContext
): Promise<void> {
  if (action === "created") {
    await handleCommentCreated(tx, ctx);
    return;
  }
  if (action === "edited") {
    await handleCommentEdited(tx, ctx);
    return;
  }
  if (action === "deleted") {
    await handleCommentDeleted(tx, ctx);
    return;
  }
  log.warn("[handleIssueComment] Unhandled action type", {
    action: action as string,
  });
}

async function handleCommentCreated(
  tx: TransactionClient,
  { comment, issue, existingPr, organizationId }: DispatchContext
): Promise<void> {
  const author = await resolveExternalGitHubAuthorInTransaction(tx, {
    organizationId,
    author: comment.user,
    source: {
      sourceKind: "issue_comment",
      githubObjectId: String(comment.id),
      pullNumber: issue.number,
    },
  });

  const projectionInput: Parameters<typeof upsertGitHubIssueCommentThread>[1] =
    {
      organizationId,
      branchArtifactId: existingPr.branchArtifactId,
      pullRequestDetailId: existingPr.id,
      htmlUrl: comment.html_url,
      legacyState: GitHubLegacyCommentState.PENDING,
      lastSyncedAt: new Date(),
      comment: {
        githubCommentId: comment.id,
        githubHtmlUrl: comment.html_url,
        githubUpdatedAt: new Date(comment.updated_at),
        bodyMarkdown: comment.body,
        author: {
          userId: author.user.id,
          externalAuthorId: author.externalAuthor.id,
        },
        createdAt: new Date(comment.created_at),
      },
    };

  const projectionResult = await upsertIssueCommentThreadOrSkip(tx, {
    action: "created",
    input: projectionInput,
    prNumber: issue.number,
  });
  if (!projectionResult) {
    return;
  }

  log.info("[handleIssueComment] Issue comment created", {
    commentId: comment.id,
    prNumber: issue.number,
  });
}

async function handleCommentEdited(
  tx: TransactionClient,
  { comment, issue, existingPr, organizationId }: DispatchContext
): Promise<void> {
  const author = await resolveExternalGitHubAuthorInTransaction(tx, {
    organizationId,
    author: comment.user,
    source: {
      sourceKind: "issue_comment",
      githubObjectId: String(comment.id),
      pullNumber: issue.number,
    },
  });

  const projectionInput: Parameters<typeof upsertGitHubIssueCommentThread>[1] =
    {
      organizationId,
      branchArtifactId: existingPr.branchArtifactId,
      pullRequestDetailId: existingPr.id,
      htmlUrl: comment.html_url,
      legacyState: GitHubLegacyCommentState.PENDING,
      lastSyncedAt: new Date(),
      comment: {
        githubCommentId: comment.id,
        githubHtmlUrl: comment.html_url,
        githubUpdatedAt: new Date(comment.updated_at),
        bodyMarkdown: comment.body,
        author: {
          userId: author.user.id,
          externalAuthorId: author.externalAuthor.id,
        },
        createdAt: new Date(comment.created_at),
      },
    };

  const projectionResult = await upsertIssueCommentThreadOrSkip(tx, {
    action: "edited",
    input: projectionInput,
    prNumber: issue.number,
  });
  if (!projectionResult) {
    return;
  }

  log.info("[handleIssueComment] Issue comment edited", {
    commentId: comment.id,
    prNumber: issue.number,
  });
}

async function handleCommentDeleted(
  tx: TransactionClient,
  { comment, issue, existingPr, organizationId }: DispatchContext
): Promise<void> {
  const deletedComment = await softDeleteGitHubCommentByRemoteId(tx, {
    organizationId,
    branchArtifactId: existingPr.branchArtifactId,
    pullRequestDetailId: existingPr.id,
    githubCommentId: comment.id,
    deletedAt: new Date(),
    threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
  });

  if (deletedComment.comments === 0) {
    log.warn("[handleIssueComment] Comment not found for deletion", {
      githubCommentId: comment.id,
      prNumber: issue.number,
    });
    return;
  }
  log.info("[handleIssueComment] Issue comment deleted", {
    commentId: comment.id,
    prNumber: issue.number,
  });
}

/**
 * Converts scoped projection no-write conflicts into bounded webhook skips while
 * preserving unexpected errors for the top-level webhook failure path.
 */
async function upsertIssueCommentThreadOrSkip(
  tx: TransactionClient,
  ctx: {
    action: "created" | "edited";
    input: Parameters<typeof upsertGitHubIssueCommentThread>[1];
    prNumber: number;
  }
): Promise<Awaited<ReturnType<typeof upsertGitHubIssueCommentThread>> | null> {
  try {
    return await upsertGitHubIssueCommentThread(tx, ctx.input);
  } catch (error) {
    if (!(error instanceof GitHubProjectionNoWriteError)) {
      throw error;
    }
    log.warn("[handleIssueComment] Skipping projection no-write", {
      action: ctx.action,
      branchArtifactId: ctx.input.branchArtifactId,
      code: error.code,
      details: error.details,
      githubCommentId: ctx.input.comment.githubCommentId,
      organizationId: ctx.input.organizationId,
      prNumber: ctx.prNumber,
      pullRequestDetailId: ctx.input.pullRequestDetailId,
    });
    return null;
  }
}
