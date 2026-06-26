import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  BranchViewCommentAction,
  BranchViewCommentActionResultCode,
  type BranchViewCommentActionResultCode as BranchViewCommentActionResultCodeType,
  type BranchViewCommentAction as BranchViewCommentActionType,
  BranchViewCommentWriteIdentityStatus,
  type BranchViewCommentWriteIdentityStatus as BranchViewGithubIdentityStatusType,
  CommentKind,
  type CommentKind as CommentKindType,
} from "@repo/api/src/types/branch-view";

const HTTP_READ_METHODS = new Set(["GET", "HEAD"]);

export const BranchViewGithubIdentityStatus =
  BranchViewCommentWriteIdentityStatus;
export type BranchViewGithubIdentityStatus = BranchViewGithubIdentityStatusType;

export type BranchViewCommentPermissionAuth = {
  authMethod: "session" | "api_key";
  organizationId: string;
  apiKeyScopes?: ApiKeyScope[];
};

export type BranchViewCommentGithubIdentity = {
  status: BranchViewGithubIdentityStatus;
  githubUserId?: string | null;
  login?: string | null;
};

export type BranchViewCommentPermissionTarget = {
  organizationId: string;
  kind?: CommentKindType;
  authorGithubUserId?: string | null;
  authorLogin?: string | null;
  isAppAuthored?: boolean;
  reviewThreadNodeId?: string | null;
  resolvable?: boolean | null;
  resolved?: boolean | null;
};

export type BranchViewCommentPermissionInput = {
  action: BranchViewCommentActionType;
  auth: BranchViewCommentPermissionAuth;
  githubIdentity: BranchViewCommentGithubIdentity;
  target: BranchViewCommentPermissionTarget;
};

export type BranchViewCommentPermissionResult = {
  allowed: boolean;
  code: BranchViewCommentActionResultCodeType;
};

/**
 * Derive the API-key scopes branch-view comment routes should require when a
 * route does not provide a narrower override.
 */
export function getRequiredBranchViewCommentApiKeyScopes(input: {
  method: string;
  action?: BranchViewCommentActionType;
}): ApiKeyScope[] {
  const method = input.method.toUpperCase();

  if (HTTP_READ_METHODS.has(method)) {
    return ["read"];
  }

  if (method === "DELETE" || input.action === BranchViewCommentAction.Delete) {
    return ["delete"];
  }

  return ["write"];
}

/**
 * Evaluate branch-view comment action policy from caller-provided state only.
 * The helper intentionally performs no persistence, environment, or feature
 * flag reads so every route can source current identity and target state before
 * asking for a stable permission result code.
 */
export function canPerformBranchViewCommentAction(
  input: BranchViewCommentPermissionInput
): BranchViewCommentPermissionResult {
  const scopeResult = checkOrganizationAndApiKeyScope(input);
  if (scopeResult) {
    return scopeResult;
  }

  const targetResult = checkTargetActionState(input);
  if (targetResult) {
    return targetResult;
  }

  const identityResult = checkGithubIdentity(input.githubIdentity);
  if (identityResult) {
    return identityResult;
  }

  if (
    requiresAuthorOwnership(input.action) &&
    !githubUserIdsMatch(
      input.githubIdentity.githubUserId,
      input.target.authorGithubUserId
    )
  ) {
    return deny(BranchViewCommentActionResultCode.UnauthorizedCommentAction);
  }

  return allow();
}

function checkOrganizationAndApiKeyScope(
  input: BranchViewCommentPermissionInput
): BranchViewCommentPermissionResult | null {
  if (input.auth.organizationId !== input.target.organizationId) {
    return deny(BranchViewCommentActionResultCode.UnauthorizedCommentAction);
  }

  if (input.auth.authMethod !== "api_key") {
    return null;
  }

  const requiredScopes = getRequiredBranchViewCommentApiKeyScopes({
    method: "POST",
    action: input.action,
  });
  const scopes = input.auth.apiKeyScopes ?? ["read", "write", "delete"];
  const hasRequiredScopes = requiredScopes.every((scope) =>
    scopes.includes(scope)
  );

  return hasRequiredScopes
    ? null
    : deny(BranchViewCommentActionResultCode.UnauthorizedCommentAction);
}

function checkTargetActionState(
  input: BranchViewCommentPermissionInput
): BranchViewCommentPermissionResult | null {
  if (
    isReplyAction(input.action) &&
    input.target.kind === CommentKind.IssueComment
  ) {
    return deny(BranchViewCommentActionResultCode.UnsupportedCommentKind);
  }

  if (
    requiresAuthorOwnership(input.action) &&
    input.target.isAppAuthored === true
  ) {
    return deny(BranchViewCommentActionResultCode.AppAuthoredCommentReadOnly);
  }

  if (isThreadResolutionAction(input.action)) {
    if (input.target.kind !== CommentKind.ReviewComment) {
      return deny(BranchViewCommentActionResultCode.UnsupportedCommentKind);
    }

    if (!input.target.reviewThreadNodeId) {
      return deny(BranchViewCommentActionResultCode.GithubThreadMissing);
    }

    if (input.target.resolvable !== true) {
      return deny(BranchViewCommentActionResultCode.CommentNotResolvable);
    }

    if (
      input.action === BranchViewCommentAction.Resolve &&
      input.target.resolved === true
    ) {
      return deny(BranchViewCommentActionResultCode.CommentNotResolvable);
    }

    if (
      input.action === BranchViewCommentAction.Unresolve &&
      input.target.resolved !== true
    ) {
      return deny(BranchViewCommentActionResultCode.CommentNotResolvable);
    }
  }

  return null;
}

function checkGithubIdentity(
  identity: BranchViewCommentGithubIdentity
): BranchViewCommentPermissionResult | null {
  switch (identity.status) {
    case BranchViewGithubIdentityStatus.Active:
      return null;
    case BranchViewGithubIdentityStatus.Missing:
      return deny(BranchViewCommentActionResultCode.GithubIdentityRequired);
    case BranchViewGithubIdentityStatus.Expired:
    case BranchViewGithubIdentityStatus.Revoked:
    case BranchViewGithubIdentityStatus.DecryptionFailed:
      return deny(BranchViewCommentActionResultCode.GithubIdentityExpired);
    default:
      return deny(BranchViewCommentActionResultCode.GithubIdentityExpired);
  }
}

function requiresAuthorOwnership(action: BranchViewCommentActionType): boolean {
  return (
    action === BranchViewCommentAction.Edit ||
    action === BranchViewCommentAction.Delete
  );
}

function isThreadResolutionAction(
  action: BranchViewCommentActionType
): boolean {
  return (
    action === BranchViewCommentAction.Resolve ||
    action === BranchViewCommentAction.Unresolve
  );
}

function isReplyAction(action: BranchViewCommentActionType): boolean {
  return action === BranchViewCommentAction.Reply;
}

function githubUserIdsMatch(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  return Boolean(left && right && left.trim() === right.trim());
}

function allow(): BranchViewCommentPermissionResult {
  return {
    allowed: true,
    code: BranchViewCommentActionResultCode.Success,
  };
}

function deny(
  code: Exclude<
    BranchViewCommentActionResultCodeType,
    typeof BranchViewCommentActionResultCode.Success
  >
): BranchViewCommentPermissionResult {
  return {
    allowed: false,
    code,
  };
}
