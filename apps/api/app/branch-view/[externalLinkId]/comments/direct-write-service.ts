import "server-only";

import {
  type BranchViewComment,
  BranchViewCommentAction,
  type BranchViewCommentActionFailureResult,
  BranchViewCommentActionRecovery,
  type BranchViewCommentActionResult,
  BranchViewCommentActionResultCode,
  type BranchViewCommentActionResultCode as BranchViewCommentActionResultCodeType,
  type BranchViewCommentAction as BranchViewCommentActionType,
  type BranchViewCommentIdentityBlocker,
  CommentKind,
  type CreateBranchViewInlineCommentRequest,
  GitHubCommentThreadKind,
  GitHubDiffSide,
  PRReviewCommentState,
} from "@repo/api/src/types/branch-view";
import { ThreadSource } from "@repo/api/src/types/comment";
import type { User } from "@repo/api/src/types/user";
import {
  GitHubLegacyCommentState,
  ThreadStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import {
  createPullRequestReviewCommentWithUserToken,
  createReplyForReviewCommentWithUserToken,
  deletePullRequestReviewCommentWithUserToken,
  type GitHubPullRequestReviewComment,
  resolvePullRequestReviewThreadWithUserToken,
  unresolvePullRequestReviewThreadWithUserToken,
  updatePullRequestReviewCommentWithUserToken,
} from "@repo/github";
import { log } from "@repo/observability/log";
import { resolveExternalGitHubAuthorInTransaction } from "@/app/comments/external-authors";
import {
  type GitHubWriteIdentity,
  type GitHubWriteIdentityStatus,
  getGitHubWriteIdentityErrorBlocker,
  getGitHubWriteIdentityErrorCode,
  getGitHubWriteIdentityStatus,
  requireGitHubWriteIdentity,
} from "@/app/comments/github-identity";
import { upsertGitHubReviewCommentThread } from "@/app/comments/github-projection";
import type { AuthContext } from "@/lib/auth/with-auth";
import { userOAuthRestFetchProvenance } from "@/lib/github-fetch-provenance";
import type { PrContext } from "@/lib/resolve-pr-context";
import { toBranchViewComment } from "../comment-utils";
import {
  BranchViewGithubIdentityStatus,
  canPerformBranchViewCommentAction,
} from "./permissions";

type DirectWriteDb = Pick<
  TransactionClient,
  | "branchFileChange"
  | "comment"
  | "commentThread"
  | "externalCommentAuthor"
  | "gitHubCommentProjection"
  | "gitHubCommentThreadProjection"
  | "gitHubUserConnection"
  | "user"
>;

type MutableReviewTarget = {
  commentId: string;
  threadId: string;
  githubCommentId: string;
  rootCommentId: string;
  reviewThreadId: string | null;
  reviewId: string | null;
  path: string | null;
  line: number | null;
  side: GitHubDiffSide | null;
  startLine: number | null;
  startSide: GitHubDiffSide | null;
  commitSha: string | null;
  htmlUrl: string | null;
  authorGithubUserId: string | null;
  authorLogin: string | null;
  isAppAuthored: boolean;
  resolvable: boolean;
  resolved: boolean;
  deletedAt: Date | null;
  githubDeletedAt: Date | null;
};

const DIFF_HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Create a GitHub inline review comment from the branch-view API using the
 * caller's GitHub user token and unified comment projection storage.
 */
export async function createInlineReviewComment(input: {
  ctx: PrContext;
  user: User;
  auth: AuthContext;
  request: CreateBranchViewInlineCommentRequest;
}): Promise<BranchViewCommentActionResult> {
  const action = BranchViewCommentAction.CreateInline;
  const contextResult = validateCurrentPrContext(input.ctx, action);
  if (contextResult) {
    return contextResult;
  }
  const anchorResult = await validateInlineAnchor(input.ctx, input.request);
  if (anchorResult) {
    return { ...anchorResult, action };
  }
  const identityResult = await getWriteIdentity(input.user);
  if (!identityResult.ok) {
    const code = getGitHubWriteIdentityErrorCode(identityResult.error);
    return failure(
      action,
      code,
      identityMessage(code),
      getGitHubWriteIdentityErrorBlocker(identityResult.error)
    );
  }

  try {
    const providerComment = await createPullRequestReviewCommentWithUserToken(
      identityResult.value.token,
      input.ctx.owner,
      input.ctx.repo,
      input.ctx.pullNumber!,
      {
        body: input.request.body,
        commitId: input.request.expectedHeadSha,
        path: input.request.path,
        line: input.request.line,
        side: input.request.side,
        startLine: input.request.startLine,
        startSide: input.request.startSide,
      }
    );
    return await projectProviderComment({
      action,
      auth: input.auth,
      ctx: input.ctx,
      identity: identityResult.value,
      providerComment,
      rootCommentId: providerComment.id,
    });
  } catch (error) {
    logCommentActionError("GitHub review comment write failed", error, {
      action,
      pullRequestDetailId: input.ctx.gitHubPullRequest?.id,
      branchArtifactId: input.ctx.branch?.artifactId,
    });
    return failure(
      action,
      BranchViewCommentActionResultCode.GithubWriteFailed,
      "GitHub review comment write failed"
    );
  }
}

/**
 * Reply to an existing GitHub review comment while preserving the historical
 * `{ commentGithubId, body }` branch-view route payload.
 */
export async function replyToReviewComment(input: {
  ctx: PrContext;
  user: User;
  auth: AuthContext;
  commentGithubId: number;
  body: string;
}): Promise<BranchViewCommentActionResult> {
  const action = BranchViewCommentAction.Reply;
  const contextResult = validateCurrentPrContext(input.ctx, action);
  if (contextResult) {
    return contextResult;
  }
  const target = await findReviewTarget(
    input.ctx,
    String(input.commentGithubId)
  );
  if (!target) {
    return failure(
      action,
      BranchViewCommentActionResultCode.CommentNotFound,
      "Comment not found"
    );
  }
  const preIdentityResult = validateReviewTargetBeforeIdentity({
    action,
    auth: input.auth,
    ctx: input.ctx,
    target,
  });
  if (preIdentityResult) {
    return preIdentityResult;
  }
  const identityStatus = await getWriteIdentityStatus(input.user);
  if (!identityStatus.ok) {
    const code = getGitHubWriteIdentityErrorCode(identityStatus.error);
    return failure(
      action,
      code,
      identityMessage(code),
      getGitHubWriteIdentityErrorBlocker(identityStatus.error)
    );
  }
  const statusPermission = canPerformBranchViewCommentAction({
    action,
    auth: authPermission(input.auth),
    githubIdentity: permissionIdentityFromStatus(identityStatus.value),
    target: permissionTarget(input.ctx, target),
  });
  if (!statusPermission.allowed) {
    return failure(
      action,
      statusPermission.code,
      permissionMessage(statusPermission.code)
    );
  }
  const identityResult = await getWriteIdentity(input.user);
  if (!identityResult.ok) {
    const code = getGitHubWriteIdentityErrorCode(identityResult.error);
    return failure(
      action,
      code,
      identityMessage(code),
      getGitHubWriteIdentityErrorBlocker(identityResult.error)
    );
  }

  try {
    const providerComment = await createReplyForReviewCommentWithUserToken(
      identityResult.value.token,
      input.ctx.owner,
      input.ctx.repo,
      input.ctx.pullNumber!,
      input.commentGithubId,
      input.body
    );
    return await projectProviderComment({
      action,
      auth: input.auth,
      ctx: input.ctx,
      identity: identityResult.value,
      providerComment,
      rootCommentId: target.rootCommentId,
      fallbackThread: target,
    });
  } catch (error) {
    logCommentActionError("GitHub review comment reply failed", error, {
      action,
      commentGithubId: input.commentGithubId,
      pullRequestDetailId: input.ctx.gitHubPullRequest?.id,
      branchArtifactId: input.ctx.branch?.artifactId,
    });
    return failure(
      action,
      BranchViewCommentActionResultCode.GithubWriteFailed,
      "GitHub review comment reply failed"
    );
  }
}

/**
 * Edit a projected GitHub review comment. GitHub owns the final body, so the
 * projection is updated from the provider response after the write succeeds.
 */
export async function editReviewComment(input: {
  ctx: PrContext;
  user: User;
  auth: AuthContext;
  commentId: string;
  body: string;
}): Promise<BranchViewCommentActionResult> {
  const action = BranchViewCommentAction.Edit;
  const result = await mutateExistingReviewComment(input, action);
  if (!result.ok) {
    return result.result;
  }

  try {
    const providerComment = await updatePullRequestReviewCommentWithUserToken(
      result.identity.token,
      input.ctx.owner,
      input.ctx.repo,
      Number(result.target.githubCommentId),
      input.body
    );
    return await projectProviderComment({
      action,
      auth: input.auth,
      ctx: input.ctx,
      identity: result.identity,
      providerComment,
      rootCommentId: result.target.rootCommentId,
      fallbackThread: result.target,
    });
  } catch (error) {
    logCommentActionError("GitHub review comment edit failed", error, {
      action,
      commentId: input.commentId,
      githubCommentId: result.target.githubCommentId,
      pullRequestDetailId: input.ctx.gitHubPullRequest?.id,
      branchArtifactId: input.ctx.branch?.artifactId,
    });
    return failure(
      action,
      BranchViewCommentActionResultCode.GithubWriteFailed,
      "GitHub review comment edit failed"
    );
  }
}

/**
 * Delete a projected GitHub review comment. Once the local projection is marked
 * deleted, repeated deletes are idempotent and do not spend another GitHub API
 * side effect.
 */
export async function deleteReviewComment(input: {
  ctx: PrContext;
  user: User;
  auth: AuthContext;
  commentId: string;
}): Promise<BranchViewCommentActionResult> {
  const action = BranchViewCommentAction.Delete;
  const result = await mutateExistingReviewComment(input, action);
  if (!result.ok) {
    return result.result;
  }

  try {
    await deletePullRequestReviewCommentWithUserToken(
      result.identity.token,
      input.ctx.owner,
      input.ctx.repo,
      Number(result.target.githubCommentId)
    );
  } catch (error) {
    logCommentActionError("GitHub review comment delete failed", error, {
      action,
      commentId: input.commentId,
      githubCommentId: result.target.githubCommentId,
      pullRequestDetailId: input.ctx.gitHubPullRequest?.id,
      branchArtifactId: input.ctx.branch?.artifactId,
    });
    return failure(
      action,
      BranchViewCommentActionResultCode.GithubWriteFailed,
      "GitHub review comment delete failed"
    );
  }

  try {
    const deletedAt = new Date();
    await withDb.tx(async (tx) => {
      await tx.gitHubCommentProjection.updateMany({
        where: {
          commentId: result.target.commentId,
          githubDeletedAt: null,
        },
        data: { githubDeletedAt: deletedAt },
      });
      await tx.comment.update({
        where: { id: result.target.commentId },
        data: { deletedAt },
      });
    });
    return successResult(
      action,
      targetToBranchViewComment({ ...result.target, deletedAt })
    );
  } catch (error) {
    logCommentActionError(
      "GitHub review comment delete projection failed",
      error,
      {
        action,
        commentId: result.target.commentId,
        githubCommentId: result.target.githubCommentId,
        pullRequestDetailId: input.ctx.gitHubPullRequest?.id,
        branchArtifactId: input.ctx.branch?.artifactId,
      }
    );
    return projectionFailure(action, {
      commentId: result.target.githubCommentId,
      reviewThreadId: result.target.reviewThreadId ?? undefined,
    });
  }
}

/**
 * Resolve a GitHub review thread through the caller's user token and reconcile
 * local projection only after GitHub reports the provider mutation succeeded.
 */
export async function resolveReviewThread(input: {
  ctx: PrContext;
  user: User;
  auth: AuthContext;
  commentId: string;
}): Promise<BranchViewCommentActionResult> {
  return await mutateReviewThreadResolution(
    input,
    BranchViewCommentAction.Resolve
  );
}

/**
 * Reopen a GitHub review thread through the caller's user token and reconcile
 * local projection only after GitHub reports the provider mutation succeeded.
 */
export async function unresolveReviewThread(input: {
  ctx: PrContext;
  user: User;
  auth: AuthContext;
  commentId: string;
}): Promise<BranchViewCommentActionResult> {
  return await mutateReviewThreadResolution(
    input,
    BranchViewCommentAction.Unresolve
  );
}

async function mutateReviewThreadResolution(
  input: {
    ctx: PrContext;
    user: User;
    auth: AuthContext;
    commentId: string;
  },
  action:
    | typeof BranchViewCommentAction.Resolve
    | typeof BranchViewCommentAction.Unresolve
): Promise<BranchViewCommentActionResult> {
  const result = await mutateExistingReviewComment(input, action);
  if (!result.ok) {
    return result.result;
  }
  const reviewThreadId = result.target.reviewThreadId;
  if (!reviewThreadId) {
    throw new Error(
      "Expected review thread id after review comment permission check"
    );
  }

  try {
    const providerThread =
      action === BranchViewCommentAction.Resolve
        ? await resolvePullRequestReviewThreadWithUserToken(
            result.identity.token,
            reviewThreadId
          )
        : await unresolvePullRequestReviewThreadWithUserToken(
            result.identity.token,
            reviewThreadId
          );

    return await reconcileReviewThreadResolution({
      action,
      ctx: input.ctx,
      providerIsResolved: providerThread.isResolved,
      target: result.target,
      user: input.user,
    });
  } catch (error) {
    logCommentActionError("GitHub review thread resolution failed", error, {
      action,
      commentId: input.commentId,
      githubCommentId: result.target.githubCommentId,
      reviewThreadId: result.target.reviewThreadId,
      pullRequestDetailId: input.ctx.gitHubPullRequest?.id,
      branchArtifactId: input.ctx.branch?.artifactId,
    });
    return failure(
      action,
      BranchViewCommentActionResultCode.GithubWriteFailed,
      "GitHub review thread resolution failed"
    );
  }
}

async function mutateExistingReviewComment(
  input: {
    ctx: PrContext;
    user: User;
    auth: AuthContext;
    commentId: string;
  },
  action:
    | typeof BranchViewCommentAction.Edit
    | typeof BranchViewCommentAction.Delete
    | typeof BranchViewCommentAction.Resolve
    | typeof BranchViewCommentAction.Unresolve
): Promise<
  | { ok: true; identity: GitHubWriteIdentity; target: MutableReviewTarget }
  | { ok: false; result: BranchViewCommentActionResult }
> {
  const contextResult = validateCurrentPrContext(input.ctx, action);
  if (contextResult) {
    return { ok: false, result: contextResult };
  }
  const target = await findReviewTarget(input.ctx, input.commentId);
  if (!target) {
    return {
      ok: false,
      result: failure(
        action,
        BranchViewCommentActionResultCode.CommentNotFound,
        "Comment not found"
      ),
    };
  }
  if (
    action !== BranchViewCommentAction.Delete &&
    isLocallyDeletedTarget(target)
  ) {
    return {
      ok: false,
      result: failure(
        action,
        BranchViewCommentActionResultCode.CommentNotFound,
        "Comment not found"
      ),
    };
  }
  if (
    action === BranchViewCommentAction.Delete &&
    isLocallyDeletedTarget(target)
  ) {
    return {
      ok: false,
      result: successResult(action, targetToBranchViewComment(target)),
    };
  }
  const preIdentityResult = validateReviewTargetBeforeIdentity({
    action,
    auth: input.auth,
    ctx: input.ctx,
    target,
  });
  if (preIdentityResult) {
    return { ok: false, result: preIdentityResult };
  }
  const identityStatus = await getWriteIdentityStatus(input.user);
  if (!identityStatus.ok) {
    const code = getGitHubWriteIdentityErrorCode(identityStatus.error);
    return {
      ok: false,
      result: failure(
        action,
        code,
        identityMessage(code),
        getGitHubWriteIdentityErrorBlocker(identityStatus.error)
      ),
    };
  }
  const statusPermission = canPerformBranchViewCommentAction({
    action,
    auth: authPermission(input.auth),
    githubIdentity: permissionIdentityFromStatus(identityStatus.value),
    target: permissionTarget(input.ctx, target),
  });
  if (!statusPermission.allowed) {
    return {
      ok: false,
      result: failure(
        action,
        statusPermission.code,
        permissionMessage(statusPermission.code)
      ),
    };
  }
  const identityResult = await getWriteIdentity(input.user);
  if (!identityResult.ok) {
    const code = getGitHubWriteIdentityErrorCode(identityResult.error);
    return {
      ok: false,
      result: failure(
        action,
        code,
        identityMessage(code),
        getGitHubWriteIdentityErrorBlocker(identityResult.error)
      ),
    };
  }
  return { ok: true, identity: identityResult.value, target };
}

async function reconcileReviewThreadResolution(input: {
  action:
    | typeof BranchViewCommentAction.Resolve
    | typeof BranchViewCommentAction.Unresolve;
  ctx: PrContext;
  user: User;
  target: MutableReviewTarget;
  providerIsResolved: boolean;
}): Promise<BranchViewCommentActionResult> {
  try {
    const comment = await withDb.tx(async (tx) => {
      const now = new Date();
      await tx.commentThread.update({
        where: { id: input.target.threadId },
        data: {
          status: input.providerIsResolved
            ? ThreadStatus.RESOLVED
            : ThreadStatus.OPEN,
          resolvedAt: input.providerIsResolved ? now : null,
          resolvedById: input.providerIsResolved ? input.user.id : null,
          updatedAt: now,
        },
      });
      await tx.gitHubCommentThreadProjection.update({
        where: { threadId: input.target.threadId },
        data: {
          legacyState: input.providerIsResolved
            ? GitHubLegacyCommentState.ADDRESSED
            : GitHubLegacyCommentState.PENDING,
          lastSyncedAt: now,
        },
      });
      return await findProjectedBranchViewComment(tx, input.ctx, {
        commentId: input.target.commentId,
        githubCommentId: input.target.githubCommentId,
      });
    });
    if (!comment) {
      return projectionFailure(input.action, {
        commentId: input.target.githubCommentId,
        reviewThreadId: input.target.reviewThreadId ?? undefined,
      });
    }
    return successResult(input.action, comment);
  } catch (error) {
    logCommentActionError(
      "GitHub review thread resolution projection failed",
      error,
      {
        action: input.action,
        commentId: input.target.commentId,
        githubCommentId: input.target.githubCommentId,
        reviewThreadId: input.target.reviewThreadId,
        pullRequestDetailId: input.ctx.gitHubPullRequest?.id,
        branchArtifactId: input.ctx.branch?.artifactId,
      }
    );
    return projectionFailure(input.action, {
      commentId: input.target.githubCommentId,
      reviewThreadId: input.target.reviewThreadId ?? undefined,
    });
  }
}

async function projectProviderComment(input: {
  action: BranchViewCommentActionType;
  auth: AuthContext;
  ctx: PrContext;
  identity: GitHubWriteIdentity;
  providerComment: GitHubPullRequestReviewComment;
  rootCommentId: string | number;
  fallbackThread?: MutableReviewTarget;
}): Promise<BranchViewCommentActionResult> {
  try {
    const comment = await withDb.tx(async (tx) => {
      const author = await resolveExternalGitHubAuthorInTransaction(tx, {
        organizationId: input.ctx.externalLink.organizationId,
        author: input.providerComment.user,
        source: {
          sourceKind: "review_comment",
          githubObjectId: String(input.providerComment.id),
          repositoryId: input.ctx.repositoryId ?? undefined,
          pullNumber: input.ctx.pullNumber ?? undefined,
        },
      });
      const projection = await upsertGitHubReviewCommentThread(tx, {
        organizationId: input.ctx.externalLink.organizationId,
        branchArtifactId: input.ctx.branch?.artifactId ?? "",
        pullRequestDetailId: input.ctx.gitHubPullRequest?.id ?? "",
        reviewThreadId:
          input.providerComment.review_thread_node_id ??
          input.fallbackThread?.reviewThreadId ??
          null,
        rootCommentId: input.rootCommentId,
        reviewId:
          stringOrNull(input.providerComment.pull_request_review_id) ??
          input.fallbackThread?.reviewId ??
          null,
        path: input.providerComment.path ?? input.fallbackThread?.path ?? null,
        line: input.providerComment.line ?? input.fallbackThread?.line ?? null,
        side:
          diffSideOrNull(input.providerComment.side) ??
          input.fallbackThread?.side ??
          null,
        startLine:
          input.providerComment.start_line ??
          input.fallbackThread?.startLine ??
          null,
        startSide:
          diffSideOrNull(input.providerComment.start_side) ??
          input.fallbackThread?.startSide ??
          null,
        commitSha:
          input.providerComment.commit_id ??
          input.fallbackThread?.commitSha ??
          null,
        htmlUrl:
          input.providerComment.html_url ??
          input.fallbackThread?.htmlUrl ??
          null,
        legacyState: GitHubLegacyCommentState.PENDING,
        resolvable: true,
        lastSyncedAt: new Date(),
        fetchProvenance: userOAuthRestFetchProvenance({
          credentialOwnerId: input.auth.user.id,
        }),
        comments: [
          {
            githubCommentId: input.providerComment.id,
            githubInReplyToCommentId: input.providerComment.in_reply_to_id,
            githubHtmlUrl: input.providerComment.html_url,
            githubUpdatedAt: new Date(input.providerComment.updated_at),
            bodyMarkdown: input.providerComment.body,
            author: {
              userId: author.user.id,
              externalAuthorId: author.externalAuthor.id,
            },
            createdAt: new Date(input.providerComment.created_at),
          },
        ],
      });
      return await findProjectedBranchViewComment(tx, input.ctx, {
        commentId: projection.commentIds[0] ?? null,
        githubCommentId: String(input.providerComment.id),
      });
    });
    if (!comment) {
      return projectionFailure(input.action, {
        commentId: String(input.providerComment.id),
        reviewThreadId:
          input.providerComment.review_thread_node_id ?? undefined,
      });
    }
    return successResult(input.action, comment);
  } catch (error) {
    logCommentActionError("GitHub review comment projection failed", error, {
      action: input.action,
      githubCommentId: input.providerComment.id,
      reviewThreadId: input.providerComment.review_thread_node_id ?? undefined,
      pullRequestDetailId: input.ctx.gitHubPullRequest?.id,
      branchArtifactId: input.ctx.branch?.artifactId,
    });
    return projectionFailure(input.action, {
      commentId: String(input.providerComment.id),
      reviewThreadId: input.providerComment.review_thread_node_id ?? undefined,
    });
  }
}

async function validateInlineAnchor(
  ctx: PrContext,
  request: CreateBranchViewInlineCommentRequest
): Promise<BranchViewCommentActionFailureResult | null> {
  if (ctx.branch?.fileCacheHeadSha !== request.expectedHeadSha) {
    return failure(
      BranchViewCommentAction.CreateInline,
      BranchViewCommentActionResultCode.StaleHeadSha,
      "Branch file cache is not at the expected head SHA"
    );
  }
  const file = await withDb((db) =>
    db.branchFileChange.findUnique({
      where: {
        branchArtifactId_headSha_path: {
          branchArtifactId: ctx.branch?.artifactId ?? "",
          headSha: request.expectedHeadSha,
          path: request.path,
        },
      },
      select: { patch: true, isBinary: true },
    })
  );
  if (!file) {
    return failure(
      BranchViewCommentAction.CreateInline,
      BranchViewCommentActionResultCode.AnchorNotInDiff,
      "Comment anchor is not present in the current diff"
    );
  }
  if (file.isBinary || !isInlineAnchorInPatch(file.patch, request)) {
    return failure(
      BranchViewCommentAction.CreateInline,
      BranchViewCommentActionResultCode.InvalidAnchor,
      "Comment anchor is invalid for the current diff"
    );
  }
  return null;
}

function validateCurrentPrContext(
  ctx: PrContext,
  action: BranchViewCommentActionType
): BranchViewCommentActionFailureResult | null {
  if (!(ctx.gitHubPullRequest && ctx.pullNumber && ctx.branch?.artifactId)) {
    return failure(
      action,
      BranchViewCommentActionResultCode.GithubThreadMissing,
      "Current pull request context is unavailable"
    );
  }
  if (ctx.branch.invalidCurrentPullRequestRelation) {
    return failure(
      action,
      BranchViewCommentActionResultCode.StaleHeadSha,
      "Branch current pull request relation is stale"
    );
  }
  return null;
}

async function getWriteIdentity(user: User) {
  return await requireGitHubWriteIdentity({
    organizationId: user.organizationId,
    userId: user.id,
    now: new Date(),
  });
}

async function getWriteIdentityStatus(user: User) {
  return await getGitHubWriteIdentityStatus({
    organizationId: user.organizationId,
    userId: user.id,
    now: new Date(),
  });
}

async function findReviewTarget(
  ctx: PrContext,
  commentId: string
): Promise<MutableReviewTarget | null> {
  return await withDb((db) => findReviewTargetWithDb(db, ctx, commentId));
}

async function findReviewTargetWithDb(
  db: DirectWriteDb,
  ctx: PrContext,
  commentId: string
): Promise<MutableReviewTarget | null> {
  const row = await db.comment.findFirst({
    where: {
      OR: [
        ...(UUID_REGEX.test(commentId) ? [{ id: commentId }] : []),
        { githubProjection: { is: { githubCommentId: commentId } } },
      ],
      thread: {
        organizationId: ctx.externalLink.organizationId,
        artifactId: ctx.branch?.artifactId,
        source: ThreadSource.Github,
        githubProjection: {
          is: {
            pullRequestDetailId: ctx.gitHubPullRequest?.id,
            threadKind: GitHubCommentThreadKind.ReviewThread,
          },
        },
      },
      githubProjection: { is: { githubCommentId: { not: null } } },
    },
    select: {
      id: true,
      deletedAt: true,
      githubProjection: {
        select: {
          githubCommentId: true,
          githubDeletedAt: true,
          externalAuthor: {
            select: { providerUserId: true, providerLogin: true },
          },
        },
      },
      thread: {
        select: {
          id: true,
          status: true,
          githubProjection: {
            select: {
              rootCommentId: true,
              reviewThreadId: true,
              reviewId: true,
              path: true,
              line: true,
              commitSha: true,
              side: true,
              startLine: true,
              startSide: true,
              htmlUrl: true,
              resolvable: true,
            },
          },
        },
      },
    },
  });
  if (
    !(
      row?.githubProjection?.githubCommentId &&
      row.thread.githubProjection?.rootCommentId
    )
  ) {
    return null;
  }
  const authorLogin =
    row.githubProjection.externalAuthor?.providerLogin ?? null;
  return {
    commentId: row.id,
    threadId: row.thread.id,
    githubCommentId: row.githubProjection.githubCommentId,
    rootCommentId: row.thread.githubProjection.rootCommentId,
    reviewThreadId: row.thread.githubProjection.reviewThreadId,
    reviewId: row.thread.githubProjection.reviewId,
    path: row.thread.githubProjection.path,
    line: row.thread.githubProjection.line,
    side: row.thread.githubProjection.side,
    startLine: row.thread.githubProjection.startLine,
    startSide: row.thread.githubProjection.startSide,
    commitSha: row.thread.githubProjection.commitSha,
    htmlUrl: row.thread.githubProjection.htmlUrl,
    resolvable: row.thread.githubProjection.resolvable,
    resolved: row.thread.status === ThreadStatus.RESOLVED,
    authorGithubUserId:
      row.githubProjection.externalAuthor?.providerUserId ?? null,
    authorLogin,
    isAppAuthored: authorLogin?.endsWith("[bot]") ?? false,
    deletedAt: row.deletedAt,
    githubDeletedAt: row.githubProjection.githubDeletedAt,
  };
}

async function findProjectedBranchViewComment(
  db: DirectWriteDb,
  ctx: PrContext,
  input: { commentId: string | null; githubCommentId: string }
): Promise<BranchViewComment | null> {
  const row = await db.comment.findFirst({
    where: {
      ...(input.commentId ? { id: input.commentId } : {}),
      githubProjection: {
        is: {
          githubCommentId: input.githubCommentId,
          githubDeletedAt: null,
        },
      },
      deletedAt: null,
      thread: {
        organizationId: ctx.externalLink.organizationId,
        artifactId: ctx.branch?.artifactId,
        source: ThreadSource.Github,
        githubProjection: {
          is: {
            branchArtifactId: ctx.branch?.artifactId,
            pullRequestDetailId: ctx.gitHubPullRequest?.id,
            threadKind: GitHubCommentThreadKind.ReviewThread,
            deletedAt: null,
          },
        },
      },
    },
    select: {
      id: true,
      body: true,
      plainText: true,
      createdAt: true,
      githubProjection: {
        select: {
          githubCommentId: true,
          githubInReplyToCommentId: true,
          githubHtmlUrl: true,
          externalAuthor: {
            select: { providerLogin: true, avatarUrl: true, profileUrl: true },
          },
        },
      },
      thread: {
        select: {
          id: true,
          source: true,
          status: true,
          githubProjection: {
            select: {
              legacyState: true,
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
            },
          },
        },
      },
    },
  });
  if (!(row?.githubProjection && row.thread.githubProjection)) {
    return null;
  }
  return toBranchViewComment({
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
      commitSha: row.thread.githubProjection.commitSha,
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
      login:
        row.githubProjection.externalAuthor?.providerLogin ??
        "unknown-github-user",
      avatarUrl: row.githubProjection.externalAuthor?.avatarUrl ?? null,
      profileUrl: row.githubProjection.externalAuthor?.profileUrl ?? null,
    },
  });
}

/**
 * Validate that a branch-file-cache patch contains the requested GitHub diff
 * side and line range before a provider write is attempted.
 */
export function isInlineAnchorInPatch(
  patch: string | null,
  request: CreateBranchViewInlineCommentRequest
): boolean {
  if (!patch) {
    return false;
  }
  const lines = patch.split("\n");
  let oldLine = 0;
  let newLine = 0;
  if (request.startSide && request.startSide !== request.side) {
    return true;
  }
  const rangeStart = request.startLine ?? request.line;
  const rangeEnd = request.line;
  if (rangeStart > rangeEnd) {
    return false;
  }
  const matched = new Set<number>();
  for (const line of lines) {
    const header = DIFF_HUNK_HEADER_REGEX.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (line.startsWith("+")) {
      recordAnchorLine(
        matched,
        request.side,
        GitHubDiffSide.Right,
        newLine,
        rangeStart,
        rangeEnd
      );
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      recordAnchorLine(
        matched,
        request.side,
        GitHubDiffSide.Left,
        oldLine,
        rangeStart,
        rangeEnd
      );
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      recordAnchorLine(
        matched,
        request.side,
        GitHubDiffSide.Right,
        newLine,
        rangeStart,
        rangeEnd
      );
      recordAnchorLine(
        matched,
        request.side,
        GitHubDiffSide.Left,
        oldLine,
        rangeStart,
        rangeEnd
      );
      oldLine += 1;
      newLine += 1;
    }
  }
  return matched.size === rangeEnd - rangeStart + 1;
}

function recordAnchorLine(
  matched: Set<number>,
  requestedSide: GitHubDiffSide,
  candidateSide: GitHubDiffSide,
  line: number,
  start: number,
  end: number
) {
  if (requestedSide === candidateSide && line >= start && line <= end) {
    matched.add(line);
  }
}

function authPermission(auth: AuthContext) {
  return {
    authMethod: auth.authMethod,
    organizationId: auth.user.organizationId,
    apiKeyScopes: auth.apiKeyScopes,
  };
}

function permissionIdentityFromStatus(identity: GitHubWriteIdentityStatus) {
  return {
    status: BranchViewGithubIdentityStatus.Active,
    githubUserId: identity.githubUserId,
    login: identity.login,
  };
}

function activeIdentityPlaceholder(target: MutableReviewTarget) {
  return {
    status: BranchViewGithubIdentityStatus.Active,
    githubUserId: target.authorGithubUserId,
    login: target.authorLogin,
  };
}

function permissionTarget(ctx: PrContext, target: MutableReviewTarget) {
  return {
    organizationId: ctx.externalLink.organizationId,
    kind: target.path ? CommentKind.ReviewComment : CommentKind.IssueComment,
    authorGithubUserId: target.authorGithubUserId,
    authorLogin: target.authorLogin,
    isAppAuthored: target.isAppAuthored,
    reviewThreadNodeId: target.reviewThreadId,
    resolvable: target.resolvable,
    resolved: target.resolved,
  };
}

function validateReviewTargetBeforeIdentity(input: {
  action: BranchViewCommentActionType;
  auth: AuthContext;
  ctx: PrContext;
  target: MutableReviewTarget;
}): BranchViewCommentActionFailureResult | null {
  const permission = canPerformBranchViewCommentAction({
    action: input.action,
    auth: authPermission(input.auth),
    githubIdentity: activeIdentityPlaceholder(input.target),
    target: permissionTarget(input.ctx, input.target),
  });
  if (permission.allowed) {
    return null;
  }
  return failure(
    input.action,
    permission.code,
    permissionMessage(permission.code)
  );
}

function isLocallyDeletedTarget(target: MutableReviewTarget): boolean {
  return !!(target.deletedAt || target.githubDeletedAt);
}

function targetToBranchViewComment(
  target: MutableReviewTarget
): BranchViewComment {
  return {
    id: target.githubCommentId,
    githubCommentId: target.githubCommentId,
    threadId: target.threadId,
    commentId: target.commentId,
    author: target.authorLogin ?? "unknown-github-user",
    authorAvatar: null,
    authorKind: target.isAppAuthored ? "bot" : "user",
    body: "",
    createdAt: new Date().toISOString(),
    path: target.path,
    line: target.line,
    side: target.side,
    startLine: target.startLine,
    startSide: target.startSide,
    state: PRReviewCommentState.Pending,
    reviewId: target.reviewId,
    htmlUrl: target.htmlUrl ?? "",
    inReplyToId: null,
    kind: CommentKind.ReviewComment,
    resolvable: target.resolvable,
    resolved: target.resolved,
  };
}

function successResult(
  action: BranchViewCommentActionType,
  comment: BranchViewComment
): BranchViewCommentActionResult {
  return { success: true, action, comment };
}

function projectionFailure(
  action: BranchViewCommentActionType,
  github?: { commentId?: string; reviewThreadId?: string }
): BranchViewCommentActionFailureResult {
  return {
    success: false,
    action,
    code: BranchViewCommentActionResultCode.GithubProjectionFailed,
    message: "GitHub write succeeded but local branch-view projection failed",
    recovery: BranchViewCommentActionRecovery.BranchViewSync,
    github,
  };
}

function failure(
  action: BranchViewCommentActionType,
  code: BranchViewCommentActionResultCodeType,
  message: string,
  identityBlocker?: BranchViewCommentIdentityBlocker
): BranchViewCommentActionFailureResult {
  return {
    success: false,
    action,
    code,
    message,
    ...(identityBlocker ? { identityBlocker } : {}),
  };
}

function logCommentActionError(
  message: string,
  error: unknown,
  context: Record<string, unknown>
) {
  log.error(`[branch-view/comments] ${message}`, {
    ...context,
    error: error instanceof Error ? error.message : String(error),
  });
}

function identityMessage(code: BranchViewCommentActionResultCodeType): string {
  return code === BranchViewCommentActionResultCode.GithubIdentityRequired
    ? "GitHub user connection is required for comment writes"
    : "GitHub user connection must be reconnected for comment writes";
}

function permissionMessage(
  code: BranchViewCommentActionResultCodeType
): string {
  return code === BranchViewCommentActionResultCode.AppAuthoredCommentReadOnly
    ? "App-authored GitHub comments are read-only"
    : "Comment action is not allowed";
}

function stringOrNull(
  value: string | number | null | undefined
): string | null {
  return value === null || value === undefined ? null : String(value);
}

function diffSideOrNull(
  value: string | null | undefined
): GitHubDiffSide | null {
  return value === GitHubDiffSide.Left || value === GitHubDiffSide.Right
    ? value
    : null;
}
