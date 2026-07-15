import type {
  IssueCommentCreatedEvent,
  IssueCommentDeletedEvent,
  IssueCommentEditedEvent,
} from "@octokit/webhooks-types";
import {
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
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
import { githubAppWebhookFetchProvenance } from "@/lib/github-fetch-provenance";
import { resolveGitHubCommentOwner } from "../comment-owner-resolver";
import {
  type GitHubDirtyScopePublicationInput,
  publishGitHubDirtyScopes,
} from "./dirty-scope-publisher";
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

  const publication = await withDb.tx(async (tx) => {
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

    const wroteProjection = await dispatchIssueCommentAction(tx, action, {
      comment,
      issue,
      existingPr,
      organizationId: ownerResolution.organizationId,
    });
    if (!wroteProjection) {
      return null;
    }
    return buildIssueCommentDirtyScopePublication({
      comment,
      issue,
      organizationId: ownerResolution.organizationId,
      repositoryId: ownerResolution.repositoryRecordId,
      repositoryFullName: repository.full_name,
    });
  });
  if (publication) {
    await publishGitHubDirtyScopes(publication);
  }

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
): Promise<boolean> {
  if (action === "created") {
    return await handleCommentCreated(tx, ctx);
  }
  if (action === "edited") {
    return await handleCommentEdited(tx, ctx);
  }
  if (action === "deleted") {
    return await handleCommentDeleted(tx, ctx);
  }
  log.warn("[handleIssueComment] Unhandled action type", {
    action: action as string,
  });
  return false;
}

async function handleCommentCreated(
  tx: TransactionClient,
  { comment, issue, existingPr, organizationId }: DispatchContext
): Promise<boolean> {
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
      fetchProvenance: githubAppWebhookFetchProvenance(),
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
    return false;
  }

  log.info("[handleIssueComment] Issue comment created", {
    commentId: comment.id,
    prNumber: issue.number,
  });
  return true;
}

async function handleCommentEdited(
  tx: TransactionClient,
  { comment, issue, existingPr, organizationId }: DispatchContext
): Promise<boolean> {
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
      fetchProvenance: githubAppWebhookFetchProvenance(),
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
    return false;
  }

  log.info("[handleIssueComment] Issue comment edited", {
    commentId: comment.id,
    prNumber: issue.number,
  });
  return true;
}

async function handleCommentDeleted(
  tx: TransactionClient,
  { comment, issue, existingPr, organizationId }: DispatchContext
): Promise<boolean> {
  const deletedComment = await softDeleteGitHubCommentByRemoteId(tx, {
    organizationId,
    branchArtifactId: existingPr.branchArtifactId,
    pullRequestDetailId: existingPr.id,
    githubCommentId: comment.id,
    deletedAt: new Date(),
    threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
    fetchProvenance: githubAppWebhookFetchProvenance(),
  });

  if (deletedComment.comments === 0) {
    log.warn("[handleIssueComment] Comment not found for deletion", {
      githubCommentId: comment.id,
      prNumber: issue.number,
    });
    return false;
  }
  log.info("[handleIssueComment] Issue comment deleted", {
    commentId: comment.id,
    prNumber: issue.number,
  });
  return true;
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
