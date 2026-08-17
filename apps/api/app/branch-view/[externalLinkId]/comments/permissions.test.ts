import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  BranchViewCommentAction,
  BranchViewCommentActionResultCode,
  type BranchViewCommentActionResultCode as BranchViewCommentActionResultCodeType,
  type BranchViewCommentAction as BranchViewCommentActionType,
  CommentKind,
} from "@repo/api/src/types/branch-view";
import { API_KEY_SCOPES_UNRESOLVABLE_EVENT } from "@repo/api/src/utils/api-key-scope-resolution";
import { describe, expect, it, vi } from "vitest";
import {
  type BranchViewCommentGithubIdentity,
  type BranchViewCommentPermissionAuth,
  type BranchViewCommentPermissionTarget,
  BranchViewGithubIdentityStatus,
  canPerformBranchViewCommentAction,
  getRequiredBranchViewCommentApiKeyScopes,
} from "./permissions";

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError },
}));

const ORG_ID = "org-1";
const OTHER_ORG_ID = "org-2";
const AUTHOR_LOGIN = "octocat";
const AUTHOR_GITHUB_USER_ID = "123";
const OTHER_GITHUB_USER_ID = "456";

const activeIdentity = {
  status: BranchViewGithubIdentityStatus.Active,
  githubUserId: AUTHOR_GITHUB_USER_ID,
  login: AUTHOR_LOGIN,
} satisfies BranchViewCommentGithubIdentity;

function makeAuth(
  overrides: Partial<BranchViewCommentPermissionAuth> = {}
): BranchViewCommentPermissionAuth {
  return {
    authMethod: "session",
    organizationId: ORG_ID,
    ...overrides,
  };
}

function makeTarget(
  overrides: Partial<BranchViewCommentPermissionTarget> = {}
): BranchViewCommentPermissionTarget {
  return {
    organizationId: ORG_ID,
    kind: CommentKind.ReviewComment,
    authorGithubUserId: AUTHOR_GITHUB_USER_ID,
    authorLogin: AUTHOR_LOGIN,
    reviewThreadNodeId: "github-thread-node-1",
    resolvable: true,
    resolved: false,
    ...overrides,
  };
}

function permissionCode(input: {
  action: BranchViewCommentActionType;
  auth?: Partial<BranchViewCommentPermissionAuth>;
  githubIdentity?: BranchViewCommentGithubIdentity;
  target?: Partial<BranchViewCommentPermissionTarget>;
}): BranchViewCommentActionResultCodeType {
  return canPerformBranchViewCommentAction({
    action: input.action,
    auth: makeAuth(input.auth),
    githubIdentity: input.githubIdentity ?? activeIdentity,
    target: makeTarget(input.target),
  }).code;
}

describe("getRequiredBranchViewCommentApiKeyScopes", () => {
  it.each<
    [
      string,
      { method: string; action?: BranchViewCommentActionType },
      ApiKeyScope[],
    ]
  >([
    ["GET requests require read", { method: "GET" }, ["read"]],
    ["HEAD requests require read", { method: "HEAD" }, ["read"]],
    [
      "create conversation requires write",
      {
        method: "POST",
        action: BranchViewCommentAction.CreateConversation,
      },
      ["write"],
    ],
    [
      "create inline requires write",
      { method: "POST", action: BranchViewCommentAction.CreateInline },
      ["write"],
    ],
    [
      "reply requires write",
      { method: "POST", action: BranchViewCommentAction.Reply },
      ["write"],
    ],
    [
      "edit requires write",
      { method: "PATCH", action: BranchViewCommentAction.Edit },
      ["write"],
    ],
    [
      "delete action requires delete even on action-routed POST",
      { method: "POST", action: BranchViewCommentAction.Delete },
      ["delete"],
    ],
    ["DELETE method requires delete", { method: "DELETE" }, ["delete"]],
  ])("%s", (_label, input, expectedScopes) => {
    expect(getRequiredBranchViewCommentApiKeyScopes(input)).toEqual(
      expectedScopes
    );
  });
});

describe("canPerformBranchViewCommentAction", () => {
  it.each<
    [
      string,
      BranchViewCommentActionType,
      Partial<BranchViewCommentPermissionAuth>,
      BranchViewCommentActionResultCodeType,
    ]
  >([
    [
      "session auth can create conversation",
      BranchViewCommentAction.CreateConversation,
      { authMethod: "session" },
      BranchViewCommentActionResultCode.Success,
    ],
    [
      "api key with write can create conversation",
      BranchViewCommentAction.CreateConversation,
      { authMethod: "api_key", apiKeyScopes: ["write"] },
      BranchViewCommentActionResultCode.Success,
    ],
    [
      "api key with read cannot create conversation",
      BranchViewCommentAction.CreateConversation,
      { authMethod: "api_key", apiKeyScopes: ["read"] },
      BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    ],
    [
      "api key with read cannot edit",
      BranchViewCommentAction.Edit,
      { authMethod: "api_key", apiKeyScopes: ["read"] },
      BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    ],
    [
      "api key with read cannot delete",
      BranchViewCommentAction.Delete,
      { authMethod: "api_key", apiKeyScopes: ["read"] },
      BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    ],
    [
      "api key with read cannot create inline comments",
      BranchViewCommentAction.CreateInline,
      { authMethod: "api_key", apiKeyScopes: ["read"] },
      BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    ],
    [
      "api key with read cannot reply to review comments",
      BranchViewCommentAction.Reply,
      { authMethod: "api_key", apiKeyScopes: ["read"] },
      BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    ],
    [
      "api key with write cannot delete",
      BranchViewCommentAction.Delete,
      { authMethod: "api_key", apiKeyScopes: ["write"] },
      BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    ],
    [
      "api key with delete can delete",
      BranchViewCommentAction.Delete,
      { authMethod: "api_key", apiKeyScopes: ["delete"] },
      BranchViewCommentActionResultCode.Success,
    ],
    // ISS-4905: an api key whose scope set is absent, empty, or entirely
    // unrecognized is missing data, not a grant. It used to inherit a hardcoded
    // ["read","write","delete"] fallback, which made the least-specified
    // credential the most privileged one.
    [
      "api key without an explicit scope list fails closed",
      BranchViewCommentAction.Delete,
      { authMethod: "api_key", apiKeyScopes: undefined },
      BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    ],
    [
      "api key with an empty scope array fails closed",
      BranchViewCommentAction.CreateConversation,
      { authMethod: "api_key", apiKeyScopes: [] },
      BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    ],
    [
      "api key with only unrecognized scopes fails closed",
      BranchViewCommentAction.CreateConversation,
      {
        authMethod: "api_key",
        apiKeyScopes: ["superuser"] as unknown as ApiKeyScope[],
      },
      BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    ],
  ])("%s", (_label, action, auth, expectedCode) => {
    expect(permissionCode({ action, auth })).toBe(expectedCode);
  });

  it.each<[string, ApiKeyScope[] | undefined, string]>([
    ["absent", undefined, "absent"],
    ["empty", [], "empty"],
    [
      "all-unrecognized",
      ["superuser"] as unknown as ApiKeyScope[],
      "all_unrecognized",
    ],
  ])("reports an %s api-key scope set on the shared monitor", (_label, apiKeyScopes, expectedReason) => {
    logError.mockReset();

    permissionCode({
      action: BranchViewCommentAction.CreateConversation,
      auth: { authMethod: "api_key", apiKeyScopes },
    });

    expect(logError).toHaveBeenCalledWith(
      API_KEY_SCOPES_UNRESOLVABLE_EVENT,
      expect.objectContaining({
        surface: "branch_view_comment_permissions",
        reason: expectedReason,
      })
    );
  });

  it("denies actions outside the caller organization", () => {
    expect(
      permissionCode({
        action: BranchViewCommentAction.CreateInline,
        target: { organizationId: OTHER_ORG_ID },
      })
    ).toBe(BranchViewCommentActionResultCode.UnauthorizedCommentAction);
  });

  it.each<
    [
      string,
      BranchViewCommentGithubIdentity,
      BranchViewCommentActionResultCodeType,
    ]
  >([
    [
      "missing identity requires GitHub connection",
      { status: BranchViewGithubIdentityStatus.Missing },
      BranchViewCommentActionResultCode.GithubIdentityRequired,
    ],
    [
      "expired identity requires reconnect",
      { status: BranchViewGithubIdentityStatus.Expired, login: AUTHOR_LOGIN },
      BranchViewCommentActionResultCode.GithubIdentityExpired,
    ],
    [
      "revoked identity requires reconnect",
      { status: BranchViewGithubIdentityStatus.Revoked, login: AUTHOR_LOGIN },
      BranchViewCommentActionResultCode.GithubIdentityExpired,
    ],
    [
      "decryption failure requires reconnect",
      {
        status: BranchViewGithubIdentityStatus.DecryptionFailed,
        login: AUTHOR_LOGIN,
      },
      BranchViewCommentActionResultCode.GithubIdentityExpired,
    ],
  ])("%s", (_label, githubIdentity, expectedCode) => {
    expect(
      permissionCode({
        action: BranchViewCommentAction.CreateConversation,
        githubIdentity,
      })
    ).toBe(expectedCode);
  });

  it("requires active GitHub identity for reply", () => {
    expect(
      permissionCode({
        action: BranchViewCommentAction.Reply,
        githubIdentity: { status: BranchViewGithubIdentityStatus.Missing },
      })
    ).toBe(BranchViewCommentActionResultCode.GithubIdentityRequired);
  });

  it("does not support replying to issue comments", () => {
    expect(
      permissionCode({
        action: BranchViewCommentAction.Reply,
        target: { kind: CommentKind.IssueComment },
      })
    ).toBe(BranchViewCommentActionResultCode.UnsupportedCommentKind);
  });

  it.each<
    [
      string,
      BranchViewCommentActionType,
      Partial<BranchViewCommentPermissionTarget>,
      BranchViewCommentActionResultCodeType,
    ]
  >([
    [
      "edit succeeds when active GitHub identity owns the comment",
      BranchViewCommentAction.Edit,
      { authorGithubUserId: AUTHOR_GITHUB_USER_ID, authorLogin: "renamed" },
      BranchViewCommentActionResultCode.Success,
    ],
    [
      "delete succeeds when active GitHub identity owns the comment",
      BranchViewCommentAction.Delete,
      { authorGithubUserId: ` ${AUTHOR_GITHUB_USER_ID} ` },
      BranchViewCommentActionResultCode.Success,
    ],
    [
      "edit denies non-author identity",
      BranchViewCommentAction.Edit,
      { authorGithubUserId: OTHER_GITHUB_USER_ID, authorLogin: AUTHOR_LOGIN },
      BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    ],
    [
      "delete denies non-author identity",
      BranchViewCommentAction.Delete,
      { authorGithubUserId: OTHER_GITHUB_USER_ID, authorLogin: AUTHOR_LOGIN },
      BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    ],
    [
      "delete denies missing stable author identity",
      BranchViewCommentAction.Delete,
      { authorGithubUserId: null },
      BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    ],
    [
      "edit denies login-only matches without stable provider identity",
      BranchViewCommentAction.Edit,
      { authorGithubUserId: null, authorLogin: AUTHOR_LOGIN },
      BranchViewCommentActionResultCode.UnauthorizedCommentAction,
    ],
    [
      "edit returns app-authored read-only for legacy app comments",
      BranchViewCommentAction.Edit,
      { isAppAuthored: true, authorLogin: "closedloop-ai[bot]" },
      BranchViewCommentActionResultCode.AppAuthoredCommentReadOnly,
    ],
    [
      "delete returns app-authored read-only for legacy app comments",
      BranchViewCommentAction.Delete,
      { isAppAuthored: true, authorLogin: "closedloop-ai[bot]" },
      BranchViewCommentActionResultCode.AppAuthoredCommentReadOnly,
    ],
  ])("%s", (_label, action, target, expectedCode) => {
    expect(permissionCode({ action, target })).toBe(expectedCode);
  });

  it.each<
    [
      string,
      BranchViewCommentActionType,
      Partial<BranchViewCommentPermissionTarget>,
      BranchViewCommentActionResultCodeType,
    ]
  >([
    [
      "resolve rejects issue comments",
      BranchViewCommentAction.Resolve,
      { kind: CommentKind.IssueComment },
      BranchViewCommentActionResultCode.UnsupportedCommentKind,
    ],
    [
      "unresolve rejects issue comments",
      BranchViewCommentAction.Unresolve,
      { kind: CommentKind.IssueComment, resolved: true },
      BranchViewCommentActionResultCode.UnsupportedCommentKind,
    ],
    [
      "resolve requires review thread node id",
      BranchViewCommentAction.Resolve,
      { reviewThreadNodeId: null },
      BranchViewCommentActionResultCode.GithubThreadMissing,
    ],
    [
      "resolve rejects non-resolvable comments",
      BranchViewCommentAction.Resolve,
      { resolvable: false },
      BranchViewCommentActionResultCode.CommentNotResolvable,
    ],
    [
      "resolve rejects already resolved comments",
      BranchViewCommentAction.Resolve,
      { resolved: true },
      BranchViewCommentActionResultCode.CommentNotResolvable,
    ],
    [
      "resolve allows open resolvable review comments",
      BranchViewCommentAction.Resolve,
      { resolved: false, resolvable: true },
      BranchViewCommentActionResultCode.Success,
    ],
    [
      "unresolve rejects open comments",
      BranchViewCommentAction.Unresolve,
      { resolved: false },
      BranchViewCommentActionResultCode.CommentNotResolvable,
    ],
    [
      "unresolve allows resolved review comments",
      BranchViewCommentAction.Unresolve,
      { resolved: true, resolvable: true },
      BranchViewCommentActionResultCode.Success,
    ],
  ])("%s", (_label, action, target, expectedCode) => {
    expect(permissionCode({ action, target })).toBe(expectedCode);
  });
});
