import { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  BranchViewCommentAction,
  type BranchViewCommentAction as BranchViewCommentActionType,
  BranchViewCommentWriteIdentityStatus,
  type BranchViewCommentWriteIdentityStatus as BranchViewCommentWriteIdentityStatusType,
  CommentKind,
} from "@repo/api/src/types/branch-view";
import { describe, expect, it } from "vitest";
import {
  buildActionPromptEligibility,
  buildCreatePromptEligibility,
  buildIdentityPromptEligibility,
} from "./identity-prompt-service";
import type {
  BranchViewCommentGithubIdentity,
  BranchViewCommentPermissionAuth,
  BranchViewCommentPermissionTarget,
} from "./permissions";

const organizationId = "org-1";
const githubUserId = "123";

const sessionAuth = {
  authMethod: "session",
  organizationId,
} satisfies BranchViewCommentPermissionAuth;

const activeIdentity = {
  status: BranchViewCommentWriteIdentityStatus.Active,
  githubUserId,
  login: "octocat",
} satisfies BranchViewCommentGithubIdentity;

const missingIdentity = {
  status: BranchViewCommentWriteIdentityStatus.Missing,
} satisfies BranchViewCommentGithubIdentity;

function makeReviewTarget(
  overrides: Partial<BranchViewCommentPermissionTarget> = {}
): BranchViewCommentPermissionTarget {
  return {
    organizationId,
    kind: CommentKind.ReviewComment,
    authorGithubUserId: githubUserId,
    authorLogin: "octocat",
    reviewThreadNodeId: "thread-1",
    resolvable: true,
    resolved: false,
    ...overrides,
  };
}

function buildForAction(input: {
  action?: BranchViewCommentActionType;
  auth?: BranchViewCommentPermissionAuth;
  githubIdentity?: BranchViewCommentGithubIdentity;
  target?: BranchViewCommentPermissionTarget;
}) {
  return buildIdentityPromptEligibility({
    action: input.action ?? BranchViewCommentAction.Reply,
    auth: input.auth ?? sessionAuth,
    githubIdentity: input.githubIdentity ?? missingIdentity,
    target: input.target ?? makeReviewTarget(),
  });
}

describe("buildIdentityPromptEligibility", () => {
  it.each<
    [
      string,
      Exclude<
        BranchViewCommentWriteIdentityStatusType,
        typeof BranchViewCommentWriteIdentityStatus.Active
      >,
    ]
  >([
    ["missing", BranchViewCommentWriteIdentityStatus.Missing],
    ["expired", BranchViewCommentWriteIdentityStatus.Expired],
    ["revoked", BranchViewCommentWriteIdentityStatus.Revoked],
    [
      "decryption failed",
      BranchViewCommentWriteIdentityStatus.DecryptionFailed,
    ],
  ])("prompts for an identity-owned %s blocker", (_label, status) => {
    expect(buildForAction({ githubIdentity: { status } })).toEqual({
      prompt: true,
      identityBlocker: { status },
    });
  });

  it("does not prompt when the action succeeds with an active identity", () => {
    expect(buildForAction({ githubIdentity: activeIdentity })).toEqual({
      prompt: false,
    });
  });

  it.each<
    [
      string,
      Pick<
        Parameters<typeof buildIdentityPromptEligibility>[0],
        "action" | "auth" | "target"
      >,
    ]
  >([
    [
      "organization mismatch",
      {
        action: BranchViewCommentAction.Reply,
        auth: sessionAuth,
        target: makeReviewTarget({ organizationId: "org-2" }),
      },
    ],
    [
      "insufficient API-key scope",
      {
        action: BranchViewCommentAction.Reply,
        auth: {
          authMethod: "api_key",
          organizationId,
          apiKeyScopes: [ApiKeyScope.Read],
        },
        target: makeReviewTarget(),
      },
    ],
    [
      "unsupported reply target",
      {
        action: BranchViewCommentAction.Reply,
        auth: sessionAuth,
        target: makeReviewTarget({ kind: CommentKind.IssueComment }),
      },
    ],
    [
      "app-authored edit target",
      {
        action: BranchViewCommentAction.Edit,
        auth: sessionAuth,
        target: makeReviewTarget({ isAppAuthored: true }),
      },
    ],
    [
      "missing review thread",
      {
        action: BranchViewCommentAction.Resolve,
        auth: sessionAuth,
        target: makeReviewTarget({ reviewThreadNodeId: null }),
      },
    ],
    [
      "non-resolvable review thread",
      {
        action: BranchViewCommentAction.Resolve,
        auth: sessionAuth,
        target: makeReviewTarget({ resolvable: false }),
      },
    ],
    [
      "null review-thread resolvability",
      {
        action: BranchViewCommentAction.Resolve,
        auth: sessionAuth,
        target: makeReviewTarget({ resolvable: null }),
      },
    ],
    [
      "missing review-thread resolvability",
      {
        action: BranchViewCommentAction.Resolve,
        auth: sessionAuth,
        target: makeReviewTarget({ resolvable: undefined }),
      },
    ],
    [
      "already-resolved thread",
      {
        action: BranchViewCommentAction.Resolve,
        auth: sessionAuth,
        target: makeReviewTarget({ resolved: true }),
      },
    ],
    [
      "already-unresolved thread",
      {
        action: BranchViewCommentAction.Unresolve,
        auth: sessionAuth,
        target: makeReviewTarget({ resolved: false }),
      },
    ],
    [
      "null review-thread resolution state",
      {
        action: BranchViewCommentAction.Unresolve,
        auth: sessionAuth,
        target: makeReviewTarget({ resolved: null }),
      },
    ],
    [
      "missing review-thread resolution state",
      {
        action: BranchViewCommentAction.Unresolve,
        auth: sessionAuth,
        target: makeReviewTarget({ resolved: undefined }),
      },
    ],
  ])("suppresses the prompt for a higher-precedence %s blocker", (_label, input) => {
    expect(buildForAction(input)).toEqual({ prompt: false });
  });
});

describe("buildCreatePromptEligibility", () => {
  it("suppresses both create prompts until the branch is ready", () => {
    expect(
      buildCreatePromptEligibility({
        auth: sessionAuth,
        branchReady: false,
        githubIdentity: missingIdentity,
        organizationId,
      })
    ).toEqual({
      createConversation: { prompt: false },
      createInline: { prompt: false },
    });
  });

  it("projects the identity blocker to both ready create surfaces", () => {
    expect(
      buildCreatePromptEligibility({
        auth: sessionAuth,
        branchReady: true,
        githubIdentity: missingIdentity,
        organizationId,
      })
    ).toEqual({
      createConversation: {
        prompt: true,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Missing,
        },
      },
      createInline: {
        prompt: true,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Missing,
        },
      },
    });
  });

  it("suppresses ready create prompts when the organization does not match", () => {
    expect(
      buildCreatePromptEligibility({
        auth: sessionAuth,
        branchReady: true,
        githubIdentity: missingIdentity,
        organizationId: "org-2",
      })
    ).toEqual({
      createConversation: { prompt: false },
      createInline: { prompt: false },
    });
  });

  it("suppresses both ready create prompts for an active identity", () => {
    expect(
      buildCreatePromptEligibility({
        auth: sessionAuth,
        branchReady: true,
        githubIdentity: activeIdentity,
        organizationId,
      })
    ).toEqual({
      createConversation: { prompt: false },
      createInline: { prompt: false },
    });
  });
});

describe("buildActionPromptEligibility", () => {
  it("projects action-appropriate prompts for an open review thread", () => {
    expect(
      buildActionPromptEligibility({
        auth: sessionAuth,
        githubIdentity: missingIdentity,
        target: makeReviewTarget(),
      })
    ).toEqual({
      reply: expectIdentityPrompt(),
      edit: expectIdentityPrompt(),
      delete: expectIdentityPrompt(),
      resolve: expectIdentityPrompt(),
      unresolve: { prompt: false },
    });
  });

  it("switches the resolution prompt for a resolved review thread", () => {
    expect(
      buildActionPromptEligibility({
        auth: sessionAuth,
        githubIdentity: missingIdentity,
        target: makeReviewTarget({ resolved: true }),
      })
    ).toEqual({
      reply: expectIdentityPrompt(),
      edit: expectIdentityPrompt(),
      delete: expectIdentityPrompt(),
      resolve: { prompt: false },
      unresolve: expectIdentityPrompt(),
    });
  });

  it("suppresses action prompts that an issue-comment target cannot perform", () => {
    expect(
      buildActionPromptEligibility({
        auth: sessionAuth,
        githubIdentity: missingIdentity,
        target: makeReviewTarget({ kind: CommentKind.IssueComment }),
      })
    ).toEqual({
      reply: { prompt: false },
      edit: expectIdentityPrompt(),
      delete: expectIdentityPrompt(),
      resolve: { prompt: false },
      unresolve: { prompt: false },
    });
  });

  it("requires delete scope before projecting the delete identity prompt", () => {
    expect(
      buildActionPromptEligibility({
        auth: {
          authMethod: "api_key",
          organizationId,
          apiKeyScopes: [ApiKeyScope.Write],
        },
        githubIdentity: missingIdentity,
        target: makeReviewTarget(),
      })
    ).toEqual({
      reply: expectIdentityPrompt(),
      edit: expectIdentityPrompt(),
      delete: { prompt: false },
      resolve: expectIdentityPrompt(),
      unresolve: { prompt: false },
    });
  });

  it("projects only the delete identity prompt for a delete-only API key", () => {
    expect(
      buildActionPromptEligibility({
        auth: {
          authMethod: "api_key",
          organizationId,
          apiKeyScopes: [ApiKeyScope.Delete],
        },
        githubIdentity: missingIdentity,
        target: makeReviewTarget(),
      })
    ).toEqual({
      reply: { prompt: false },
      edit: { prompt: false },
      delete: expectIdentityPrompt(),
      resolve: { prompt: false },
      unresolve: { prompt: false },
    });
  });
});

function expectIdentityPrompt() {
  return {
    prompt: true,
    identityBlocker: { status: BranchViewCommentWriteIdentityStatus.Missing },
  } as const;
}
