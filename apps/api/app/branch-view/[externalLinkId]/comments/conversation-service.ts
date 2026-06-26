import "server-only";

import {
  BRANCH_VIEW_COMMENT_ACTION_RESULT_HTTP_STATUS,
  type BranchViewComment,
  BranchViewCommentAction,
  BranchViewCommentActionRecovery,
  type BranchViewCommentActionResult,
  BranchViewCommentActionResultCode,
  type BranchViewCommentIdentityBlocker,
  GitHubCommentThreadKind,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";
import type { User } from "@repo/api/src/types/user";
import { type TransactionClient, withDb } from "@repo/database";
import {
  createPullRequestIssueCommentWithUserToken,
  deletePullRequestIssueCommentWithUserToken,
  type GitHubPullRequestIssueComment,
  updatePullRequestIssueCommentWithUserToken,
} from "@repo/github";
import { log } from "@repo/observability/log";
import {
  type ResolvedExternalGitHubAuthor,
  resolveExternalGitHubAuthorInTransaction,
} from "@/app/comments/external-authors";
import {
  type GitHubWriteIdentityStatus,
  getGitHubWriteIdentityErrorBlocker,
  getGitHubWriteIdentityErrorCode,
  getGitHubWriteIdentityStatus,
  requireGitHubWriteIdentity,
} from "@/app/comments/github-identity";
import {
  softDeleteScopedGitHubCommentProjection,
  upsertGitHubIssueCommentThread,
} from "@/app/comments/github-projection";
import type { PrContext } from "@/lib/resolve-pr-context";
import { toBranchViewComment } from "../comment-utils";
import type { BranchViewAuthContext } from "../service";
import {
  BranchViewGithubIdentityStatus,
  canPerformBranchViewCommentAction,
} from "./permissions";

export type BranchViewConversationMutationResult = {
  result: BranchViewCommentActionResult;
  httpStatus: number;
};

type MutationContext = {
  branchArtifactId: string;
  pullRequestDetailId: string;
  pullNumber: number;
  owner: string;
  repo: string;
  organizationId: string;
};

type ProjectedIssueCommentRecord = {
  branchViewComment: BranchViewComment;
  authorGithubUserId: string | null;
  authorLogin: string | null;
  isAppAuthored: boolean;
};

/**
 * Create a top-level GitHub PR conversation comment as the caller, then
 * materialize the unified branch-view projection used by GET/refetch.
 */
async function createBranchViewConversationComment(input: {
  ctx: PrContext;
  user: User;
  auth: BranchViewAuthContext;
  body: string;
}): Promise<BranchViewConversationMutationResult> {
  const mutationContext = getMutationContext(input.ctx);
  if (!mutationContext) {
    return failureResult(
      BranchViewCommentAction.CreateConversation,
      BranchViewCommentActionResultCode.InvalidRequest,
      "Current pull request context is unavailable"
    );
  }

  const preliminaryPermission = canPerformBranchViewCommentAction({
    action: BranchViewCommentAction.CreateConversation,
    auth: input.auth,
    githubIdentity: activeGithubIdentityPlaceholder(),
    target: { organizationId: mutationContext.organizationId },
  });
  if (!preliminaryPermission.allowed) {
    return failureResult(
      BranchViewCommentAction.CreateConversation,
      preliminaryPermission.code,
      "You are not allowed to create a PR conversation comment"
    );
  }

  const identityStatus = await getGitHubWriteIdentityStatus({
    organizationId: input.user.organizationId,
    userId: input.user.id,
    now: new Date(),
  });
  const permission = canPerformBranchViewCommentAction({
    action: BranchViewCommentAction.CreateConversation,
    auth: input.auth,
    githubIdentity: githubIdentityFromStatus(identityStatus),
    target: { organizationId: mutationContext.organizationId },
  });
  if (!permission.allowed) {
    return failureResult(
      BranchViewCommentAction.CreateConversation,
      permission.code,
      "You are not allowed to create a PR conversation comment",
      getIdentityStatusBlockerForPermission(permission.code, identityStatus)
    );
  }

  const identityResult = await requireGitHubWriteIdentity({
    organizationId: input.user.organizationId,
    userId: input.user.id,
    now: new Date(),
  });
  if (!identityResult.ok) {
    const blocker = getGitHubWriteIdentityErrorBlocker(identityResult.error);
    return failureResult(
      BranchViewCommentAction.CreateConversation,
      getGitHubWriteIdentityErrorCode(identityResult.error),
      "A connected GitHub identity is required",
      blocker
    );
  }

  let githubComment: GitHubPullRequestIssueComment;
  try {
    githubComment = await createPullRequestIssueCommentWithUserToken(
      identityResult.value.token,
      mutationContext.owner,
      mutationContext.repo,
      mutationContext.pullNumber,
      input.body
    );
  } catch (error) {
    log.warn("[branch-view/comments] GitHub conversation create failed", {
      externalLinkId: input.ctx.externalLink.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResult(
      BranchViewCommentAction.CreateConversation,
      BranchViewCommentActionResultCode.GithubWriteFailed,
      "GitHub failed to create the PR conversation comment"
    );
  }

  return await projectProviderMutation({
    action: BranchViewCommentAction.CreateConversation,
    ctx: mutationContext,
    githubComment,
  });
}

/**
 * Edit an existing unified GitHub issue-comment projection after proving stable
 * GitHub user-id ownership against the projected author identity.
 */
async function editBranchViewConversationComment(input: {
  ctx: PrContext;
  user: User;
  auth: BranchViewAuthContext;
  githubCommentId: string;
  body: string;
}): Promise<BranchViewConversationMutationResult> {
  const mutationContext = getMutationContext(input.ctx);
  if (!mutationContext) {
    return failureResult(
      BranchViewCommentAction.Edit,
      BranchViewCommentActionResultCode.InvalidRequest,
      "Current pull request context is unavailable"
    );
  }

  const target = await findProjectedIssueComment(
    mutationContext,
    input.githubCommentId
  );
  if (!target) {
    return failureResult(
      BranchViewCommentAction.Edit,
      BranchViewCommentActionResultCode.CommentNotFound,
      "PR conversation comment not found"
    );
  }

  const preliminaryPermission = canPerformBranchViewCommentAction({
    action: BranchViewCommentAction.Edit,
    auth: input.auth,
    githubIdentity: activeGithubIdentityPlaceholder(target.authorGithubUserId),
    target: {
      organizationId: mutationContext.organizationId,
      kind: target.branchViewComment.kind,
      authorGithubUserId: target.authorGithubUserId,
      authorLogin: target.authorLogin,
      isAppAuthored: target.isAppAuthored,
    },
  });
  if (!preliminaryPermission.allowed) {
    return failureResult(
      BranchViewCommentAction.Edit,
      preliminaryPermission.code,
      "You are not allowed to edit this PR conversation comment"
    );
  }

  const numericCommentId = parseNumericGithubCommentId(input.githubCommentId);
  if (numericCommentId === null) {
    return failureResult(
      BranchViewCommentAction.Edit,
      BranchViewCommentActionResultCode.InvalidRequest,
      "GitHub comment id must be a positive integer"
    );
  }

  const identityStatus = await getGitHubWriteIdentityStatus({
    organizationId: input.user.organizationId,
    userId: input.user.id,
    now: new Date(),
  });
  const permission = canPerformBranchViewCommentAction({
    action: BranchViewCommentAction.Edit,
    auth: input.auth,
    githubIdentity: githubIdentityFromStatus(identityStatus),
    target: {
      organizationId: mutationContext.organizationId,
      kind: target.branchViewComment.kind,
      authorGithubUserId: target.authorGithubUserId,
      authorLogin: target.authorLogin,
      isAppAuthored: target.isAppAuthored,
    },
  });
  if (!permission.allowed) {
    return failureResult(
      BranchViewCommentAction.Edit,
      permission.code,
      "You are not allowed to edit this PR conversation comment",
      getIdentityStatusBlockerForPermission(permission.code, identityStatus)
    );
  }

  const identityResult = await requireGitHubWriteIdentity({
    organizationId: input.user.organizationId,
    userId: input.user.id,
    now: new Date(),
  });
  if (!identityResult.ok) {
    const blocker = getGitHubWriteIdentityErrorBlocker(identityResult.error);
    return failureResult(
      BranchViewCommentAction.Edit,
      getGitHubWriteIdentityErrorCode(identityResult.error),
      "A connected GitHub identity is required",
      blocker
    );
  }

  let githubComment: GitHubPullRequestIssueComment;
  try {
    githubComment = await updatePullRequestIssueCommentWithUserToken(
      identityResult.value.token,
      mutationContext.owner,
      mutationContext.repo,
      numericCommentId,
      input.body
    );
  } catch (error) {
    log.warn("[branch-view/comments] GitHub conversation edit failed", {
      externalLinkId: input.ctx.externalLink.id,
      githubCommentId: input.githubCommentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResult(
      BranchViewCommentAction.Edit,
      BranchViewCommentActionResultCode.GithubWriteFailed,
      "GitHub failed to edit the PR conversation comment"
    );
  }

  return await projectProviderMutation({
    action: BranchViewCommentAction.Edit,
    ctx: mutationContext,
    githubComment,
  });
}

/**
 * Delete one scoped GitHub issue comment and soft-delete only that local unified
 * projection, returning the pre-delete projected comment on full success.
 */
async function deleteBranchViewConversationComment(input: {
  ctx: PrContext;
  user: User;
  auth: BranchViewAuthContext;
  githubCommentId: string;
}): Promise<BranchViewConversationMutationResult> {
  const mutationContext = getMutationContext(input.ctx);
  if (!mutationContext) {
    return failureResult(
      BranchViewCommentAction.Delete,
      BranchViewCommentActionResultCode.InvalidRequest,
      "Current pull request context is unavailable"
    );
  }

  const target = await findProjectedIssueComment(
    mutationContext,
    input.githubCommentId
  );
  if (!target) {
    return failureResult(
      BranchViewCommentAction.Delete,
      BranchViewCommentActionResultCode.CommentNotFound,
      "PR conversation comment not found"
    );
  }

  const preliminaryPermission = canPerformBranchViewCommentAction({
    action: BranchViewCommentAction.Delete,
    auth: input.auth,
    githubIdentity: activeGithubIdentityPlaceholder(target.authorGithubUserId),
    target: {
      organizationId: mutationContext.organizationId,
      kind: target.branchViewComment.kind,
      authorGithubUserId: target.authorGithubUserId,
      authorLogin: target.authorLogin,
      isAppAuthored: target.isAppAuthored,
    },
  });
  if (!preliminaryPermission.allowed) {
    return failureResult(
      BranchViewCommentAction.Delete,
      preliminaryPermission.code,
      "You are not allowed to delete this PR conversation comment"
    );
  }

  const numericCommentId = parseNumericGithubCommentId(input.githubCommentId);
  if (numericCommentId === null) {
    return failureResult(
      BranchViewCommentAction.Delete,
      BranchViewCommentActionResultCode.InvalidRequest,
      "GitHub comment id must be a positive integer"
    );
  }

  const identityStatus = await getGitHubWriteIdentityStatus({
    organizationId: input.user.organizationId,
    userId: input.user.id,
    now: new Date(),
  });
  const permission = canPerformBranchViewCommentAction({
    action: BranchViewCommentAction.Delete,
    auth: input.auth,
    githubIdentity: githubIdentityFromStatus(identityStatus),
    target: {
      organizationId: mutationContext.organizationId,
      kind: target.branchViewComment.kind,
      authorGithubUserId: target.authorGithubUserId,
      authorLogin: target.authorLogin,
      isAppAuthored: target.isAppAuthored,
    },
  });
  if (!permission.allowed) {
    return failureResult(
      BranchViewCommentAction.Delete,
      permission.code,
      "You are not allowed to delete this PR conversation comment",
      getIdentityStatusBlockerForPermission(permission.code, identityStatus)
    );
  }

  const identityResult = await requireGitHubWriteIdentity({
    organizationId: input.user.organizationId,
    userId: input.user.id,
    now: new Date(),
  });
  if (!identityResult.ok) {
    const blocker = getGitHubWriteIdentityErrorBlocker(identityResult.error);
    return failureResult(
      BranchViewCommentAction.Delete,
      getGitHubWriteIdentityErrorCode(identityResult.error),
      "A connected GitHub identity is required",
      blocker
    );
  }

  try {
    await deletePullRequestIssueCommentWithUserToken(
      identityResult.value.token,
      mutationContext.owner,
      mutationContext.repo,
      numericCommentId
    );
  } catch (error) {
    log.warn("[branch-view/comments] GitHub conversation delete failed", {
      externalLinkId: input.ctx.externalLink.id,
      githubCommentId: input.githubCommentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResult(
      BranchViewCommentAction.Delete,
      BranchViewCommentActionResultCode.GithubWriteFailed,
      "GitHub failed to delete the PR conversation comment"
    );
  }

  return await projectLocalDelete({
    action: BranchViewCommentAction.Delete,
    ctx: mutationContext,
    githubCommentId: input.githubCommentId,
    preDeleteComment: target.branchViewComment,
  });
}

function getMutationContext(ctx: PrContext): MutationContext | null {
  const branchArtifactId = ctx.branch?.artifactId ?? null;
  const pullRequestDetailId = ctx.branch?.currentPullRequestDetailId ?? null;
  const pullNumber = ctx.gitHubPullRequest?.number ?? ctx.pullNumber;
  if (!(branchArtifactId && pullRequestDetailId && pullNumber)) {
    return null;
  }
  return {
    branchArtifactId,
    pullRequestDetailId,
    pullNumber,
    owner: ctx.owner,
    repo: ctx.repo,
    organizationId: ctx.externalLink.organizationId,
  };
}

function activeGithubIdentityPlaceholder(githubUserId?: string | null) {
  return {
    status: BranchViewGithubIdentityStatus.Active,
    githubUserId: githubUserId ?? "policy-preflight",
    login: "policy-preflight",
  };
}

function githubIdentityFromStatus(
  identity: Awaited<ReturnType<typeof getGitHubWriteIdentityStatus>>
) {
  if (identity.ok) {
    return activeGithubIdentityStatus(identity.value);
  }
  return {
    status: getGitHubWriteIdentityErrorBlocker(identity.error).status,
  };
}

function getIdentityStatusBlocker(
  identity: Awaited<ReturnType<typeof getGitHubWriteIdentityStatus>>
): BranchViewCommentIdentityBlocker | undefined {
  return identity.ok
    ? undefined
    : getGitHubWriteIdentityErrorBlocker(identity.error);
}

function getIdentityStatusBlockerForPermission(
  code: BranchViewCommentActionResultCode,
  identity: Awaited<ReturnType<typeof getGitHubWriteIdentityStatus>>
): BranchViewCommentIdentityBlocker | undefined {
  if (
    code !== BranchViewCommentActionResultCode.GithubIdentityRequired &&
    code !== BranchViewCommentActionResultCode.GithubIdentityExpired
  ) {
    return undefined;
  }
  return getIdentityStatusBlocker(identity);
}

function activeGithubIdentityStatus(identity: GitHubWriteIdentityStatus) {
  return {
    status: BranchViewGithubIdentityStatus.Active,
    githubUserId: identity.githubUserId,
    login: identity.login,
  };
}

async function projectProviderMutation(input: {
  action: BranchViewCommentAction;
  ctx: MutationContext;
  githubComment: GitHubPullRequestIssueComment;
}): Promise<BranchViewConversationMutationResult> {
  const project = () =>
    upsertIssueCommentProjection(input.ctx, input.githubComment);
  try {
    const comment = await project();
    return successActionResult(input.action, comment);
  } catch (firstError) {
    log.warn("[branch-view/comments] Direct projection failed; retrying once", {
      githubCommentId: input.githubComment.id,
      error:
        firstError instanceof Error ? firstError.message : String(firstError),
    });
    try {
      const comment = await project();
      return successActionResult(input.action, comment);
    } catch (secondError) {
      log.warn("[branch-view/comments] Direct projection retry failed", {
        githubCommentId: input.githubComment.id,
        error:
          secondError instanceof Error
            ? secondError.message
            : String(secondError),
      });
      return projectionFailureResult(
        input.action,
        String(input.githubComment.id)
      );
    }
  }
}

async function projectLocalDelete(input: {
  action: BranchViewCommentAction;
  ctx: MutationContext;
  githubCommentId: string;
  preDeleteComment: BranchViewComment;
}): Promise<BranchViewConversationMutationResult> {
  const project = () =>
    withDb.tx((tx) =>
      softDeleteScopedGitHubCommentProjection(tx, {
        organizationId: input.ctx.organizationId,
        branchArtifactId: input.ctx.branchArtifactId,
        pullRequestDetailId: input.ctx.pullRequestDetailId,
        githubCommentId: input.githubCommentId,
        deletedAt: new Date(),
      })
    );
  try {
    await project();
    return successActionResult(input.action, input.preDeleteComment);
  } catch (firstError) {
    log.warn(
      "[branch-view/comments] Direct delete projection failed; retrying once",
      {
        githubCommentId: input.githubCommentId,
        error:
          firstError instanceof Error ? firstError.message : String(firstError),
      }
    );
    try {
      await project();
      return successActionResult(input.action, input.preDeleteComment);
    } catch (secondError) {
      log.warn("[branch-view/comments] Direct delete projection retry failed", {
        githubCommentId: input.githubCommentId,
        error:
          secondError instanceof Error
            ? secondError.message
            : String(secondError),
      });
      return projectionFailureResult(input.action, input.githubCommentId);
    }
  }
}

async function upsertIssueCommentProjection(
  ctx: MutationContext,
  githubComment: GitHubPullRequestIssueComment
): Promise<BranchViewComment> {
  return await withDb.tx(async (tx) => {
    const author = await resolveGitHubAuthorForIssueComment(
      tx,
      ctx,
      githubComment
    );
    const projection = await upsertGitHubIssueCommentThread(tx, {
      organizationId: ctx.organizationId,
      branchArtifactId: ctx.branchArtifactId,
      pullRequestDetailId: ctx.pullRequestDetailId,
      htmlUrl: githubComment.html_url,
      comment: {
        githubCommentId: githubComment.id,
        githubHtmlUrl: githubComment.html_url,
        githubUpdatedAt: new Date(githubComment.updated_at),
        bodyMarkdown: githubComment.body,
        author: {
          userId: author.user.id,
          externalAuthorId: author.externalAuthor.id,
        },
        createdAt: new Date(githubComment.created_at),
      },
    });
    const projected = await findProjectedIssueCommentByLocalIds(
      tx,
      projection.threadId,
      projection.commentIds[0] ?? ""
    );
    if (!projected) {
      throw new Error("Projected GitHub issue comment was not readable");
    }
    return projected.branchViewComment;
  });
}

function resolveGitHubAuthorForIssueComment(
  tx: TransactionClient,
  ctx: MutationContext,
  githubComment: GitHubPullRequestIssueComment
): Promise<ResolvedExternalGitHubAuthor> {
  return resolveExternalGitHubAuthorInTransaction(tx, {
    organizationId: ctx.organizationId,
    author: githubComment.user
      ? {
          id: githubComment.user.id,
          node_id: githubComment.user.node_id,
          login: githubComment.user.login,
          avatar_url: githubComment.user.avatar_url,
          html_url: `https://github.com/${githubComment.user.login}`,
        }
      : null,
    source: {
      sourceKind: "issue_comment",
      githubObjectId: String(githubComment.id),
    },
  });
}

async function findProjectedIssueComment(
  ctx: MutationContext,
  githubCommentId: string
): Promise<ProjectedIssueCommentRecord | null> {
  return await withDb((db) =>
    findProjectedIssueCommentInDb(db, {
      organizationId: ctx.organizationId,
      branchArtifactId: ctx.branchArtifactId,
      pullRequestDetailId: ctx.pullRequestDetailId,
      githubCommentId,
    })
  );
}

async function findProjectedIssueCommentByLocalIds(
  db: TransactionClient,
  threadId: string,
  commentId: string
): Promise<ProjectedIssueCommentRecord | null> {
  if (!commentId) {
    return null;
  }
  return await findProjectedIssueCommentInDb(db, { threadId, commentId });
}

async function findProjectedIssueCommentInDb(
  db: Pick<TransactionClient, "comment">,
  where:
    | {
        organizationId: string;
        branchArtifactId: string;
        pullRequestDetailId: string;
        githubCommentId: string;
      }
    | { threadId: string; commentId: string }
): Promise<ProjectedIssueCommentRecord | null> {
  const row = await db.comment.findFirst({
    where:
      "commentId" in where
        ? { id: where.commentId, threadId: where.threadId, deletedAt: null }
        : {
            deletedAt: null,
            githubProjection: {
              is: {
                githubCommentId: where.githubCommentId.trim(),
                githubDeletedAt: null,
                threadProjection: {
                  branchArtifactId: where.branchArtifactId,
                  pullRequestDetailId: where.pullRequestDetailId,
                  threadKind: GitHubCommentThreadKind.IssueComment,
                  deletedAt: null,
                  thread: {
                    organizationId: where.organizationId,
                  },
                },
              },
            },
          },
    select: {
      id: true,
      body: true,
      plainText: true,
      createdAt: true,
      thread: {
        select: {
          id: true,
          source: true,
          status: true,
          githubProjection: {
            select: {
              threadKind: true,
              reviewId: true,
              htmlUrl: true,
              path: true,
              line: true,
              commitSha: true,
              side: true,
              startLine: true,
              startSide: true,
              resolvable: true,
              legacyState: true,
            },
          },
        },
      },
      githubProjection: {
        select: {
          githubCommentId: true,
          githubInReplyToCommentId: true,
          githubHtmlUrl: true,
          externalAuthor: {
            select: {
              providerUserId: true,
              providerLogin: true,
              avatarUrl: true,
              profileUrl: true,
            },
          },
        },
      },
    },
  });
  if (!(row?.githubProjection && row.thread.githubProjection)) {
    return null;
  }
  const author = row.githubProjection.externalAuthor;
  const branchViewComment = toBranchViewComment({
    thread: {
      id: row.thread.id,
      source: row.thread.source,
      status: row.thread.status,
      legacyState: row.thread.githubProjection.legacyState,
      threadKind: row.thread.githubProjection.threadKind,
      reviewId: row.thread.githubProjection.reviewId,
      htmlUrl: row.thread.githubProjection.htmlUrl,
      path: row.thread.githubProjection.path,
      line: row.thread.githubProjection.line,
      commitSha: row.thread.githubProjection.commitSha ?? null,
      side: row.thread.githubProjection.side,
      startLine: row.thread.githubProjection.startLine,
      startSide: row.thread.githubProjection.startSide,
      resolvable: row.thread.githubProjection.resolvable,
    },
    comment: {
      id: row.id,
      body: row.body,
      plainText: row.plainText,
      createdAt: row.createdAt,
      githubCommentId: row.githubProjection.githubCommentId,
      githubInReplyToCommentId: row.githubProjection.githubInReplyToCommentId,
      githubHtmlUrl: row.githubProjection.githubHtmlUrl,
    },
    author: {
      login: author?.providerLogin ?? "unknown-github-user",
      avatarUrl: author?.avatarUrl ?? null,
      profileUrl: author?.profileUrl ?? null,
    },
  });
  if (!branchViewComment) {
    return null;
  }
  return {
    branchViewComment,
    authorGithubUserId: author?.providerUserId ?? null,
    authorLogin: author?.providerLogin ?? null,
    isAppAuthored: branchViewComment.authorKind === PrCommentAuthorKind.Bot,
  };
}

function successActionResult(
  action: BranchViewCommentAction,
  comment: BranchViewComment
): BranchViewConversationMutationResult {
  return { httpStatus: 200, result: { success: true, action, comment } };
}

function failureResult(
  action: BranchViewCommentAction,
  code: BranchViewCommentActionResultCode,
  message: string,
  identityBlocker?: BranchViewCommentIdentityBlocker
): BranchViewConversationMutationResult {
  return {
    httpStatus: BRANCH_VIEW_COMMENT_ACTION_RESULT_HTTP_STATUS[code],
    result: {
      success: false,
      action,
      code,
      message,
      ...(identityBlocker ? { identityBlocker } : {}),
    },
  };
}

function projectionFailureResult(
  action: BranchViewCommentAction,
  githubCommentId: string
): BranchViewConversationMutationResult {
  return {
    httpStatus: 202,
    result: {
      success: false,
      action,
      code: BranchViewCommentActionResultCode.GithubProjectionFailed,
      message: "GitHub succeeded, but branch-view projection failed",
      recovery: BranchViewCommentActionRecovery.DirectReprojection,
      github: { commentId: githubCommentId },
    },
  };
}

function parseNumericGithubCommentId(githubCommentId: string): number | null {
  const parsed = Number(githubCommentId.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

/** Direct GitHub issue-comment mutations for branch-view conversation rows. */
export const branchViewConversationService = {
  create: createBranchViewConversationComment,
  delete: deleteBranchViewConversationComment,
  edit: editBranchViewConversationComment,
};
