import type {
  BranchViewCommentActionPromptEligibility,
  BranchViewCommentAction as BranchViewCommentActionType,
  BranchViewCommentCreatePromptEligibility,
  BranchViewCommentIdentityBlocker,
  BranchViewCommentIdentityPromptEligibility,
} from "@repo/api/src/types/branch-view";
import {
  BranchViewCommentAction,
  BranchViewCommentActionResultCode,
} from "@repo/api/src/types/branch-view";
import {
  type BranchViewCommentGithubIdentity,
  type BranchViewCommentPermissionAuth,
  type BranchViewCommentPermissionTarget,
  BranchViewGithubIdentityStatus,
  canPerformBranchViewCommentAction,
} from "./permissions";

/**
 * Build server-owned prompt eligibility for one Branch View comment action.
 * Non-identity blockers intentionally return `prompt: false`.
 */
export function buildIdentityPromptEligibility(input: {
  action: BranchViewCommentActionType;
  auth: BranchViewCommentPermissionAuth;
  githubIdentity: BranchViewCommentGithubIdentity;
  target: BranchViewCommentPermissionTarget;
}): BranchViewCommentIdentityPromptEligibility {
  const result = canPerformBranchViewCommentAction(input);
  if (
    !(
      result.code ===
        BranchViewCommentActionResultCode.GithubIdentityRequired ||
      result.code === BranchViewCommentActionResultCode.GithubIdentityExpired
    )
  ) {
    return noIdentityPrompt();
  }

  const identityBlocker = toIdentityBlocker(input.githubIdentity);
  return identityBlocker
    ? { prompt: true, identityBlocker }
    : noIdentityPrompt();
}

/** Build prompt eligibility for Branch View create surfaces. */
export function buildCreatePromptEligibility(input: {
  auth: BranchViewCommentPermissionAuth;
  branchReady: boolean;
  githubIdentity: BranchViewCommentGithubIdentity;
  organizationId: string;
}): BranchViewCommentCreatePromptEligibility {
  if (!input.branchReady) {
    return {
      createConversation: noIdentityPrompt(),
      createInline: noIdentityPrompt(),
    };
  }

  const base = {
    auth: input.auth,
    githubIdentity: input.githubIdentity,
    target: { organizationId: input.organizationId },
  };
  return {
    createConversation: buildIdentityPromptEligibility({
      ...base,
      action: BranchViewCommentAction.CreateConversation,
    }),
    createInline: buildIdentityPromptEligibility({
      ...base,
      action: BranchViewCommentAction.CreateInline,
    }),
  };
}

/** Build prompt eligibility for all per-comment action surfaces. */
export function buildActionPromptEligibility(input: {
  auth: BranchViewCommentPermissionAuth;
  githubIdentity: BranchViewCommentGithubIdentity;
  target: BranchViewCommentPermissionTarget;
}): BranchViewCommentActionPromptEligibility {
  return {
    reply: buildIdentityPromptEligibility({
      ...input,
      action: BranchViewCommentAction.Reply,
    }),
    edit: buildIdentityPromptEligibility({
      ...input,
      action: BranchViewCommentAction.Edit,
    }),
    delete: buildIdentityPromptEligibility({
      ...input,
      action: BranchViewCommentAction.Delete,
    }),
    resolve: buildIdentityPromptEligibility({
      ...input,
      action: BranchViewCommentAction.Resolve,
    }),
    unresolve: buildIdentityPromptEligibility({
      ...input,
      action: BranchViewCommentAction.Unresolve,
    }),
  };
}

function noIdentityPrompt(): BranchViewCommentIdentityPromptEligibility {
  return { prompt: false };
}

function toIdentityBlocker(
  identity: BranchViewCommentGithubIdentity
): BranchViewCommentIdentityBlocker | null {
  if (identity.status === BranchViewGithubIdentityStatus.Active) {
    return null;
  }
  return { status: identity.status };
}
