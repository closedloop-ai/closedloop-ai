export const GitHubDirtyScopeKind = {
  Repository: "repository",
  Branch: "branch",
  PullRequest: "pull_request",
  Checks: "checks",
  Review: "review",
  Comment: "comment",
  Generic: "generic",
} as const;
export type GitHubDirtyScopeKind =
  (typeof GitHubDirtyScopeKind)[keyof typeof GitHubDirtyScopeKind];

export const GitHubDirtyTrigger = {
  Push: "push",
  PullRequest: "pull_request",
  CheckRun: "check_run",
  Review: "review",
  ReviewComment: "review_comment",
  IssueComment: "issue_comment",
  InstallationRepositories: "installation_repositories",
} as const;
export type GitHubDirtyTrigger =
  (typeof GitHubDirtyTrigger)[keyof typeof GitHubDirtyTrigger];

export const GitHubDirtyFallbackReason = {
  UnknownScope: "unknown_scope",
  ScopeOverflow: "scope_overflow",
  UnauthorizedSpecificity: "unauthorized_specificity",
  MalformedPayload: "malformed_payload",
  OlderDesktop: "older_desktop",
} as const;
export type GitHubDirtyFallbackReason =
  (typeof GitHubDirtyFallbackReason)[keyof typeof GitHubDirtyFallbackReason];

export const GITHUB_RESYNC_NUDGE_OPERATION_ID = "github_resync_nudge" as const;
export const GITHUB_RESYNC_NUDGE_PATH =
  "/api/gateway/github/resync-nudge" as const;
export const GITHUB_RESYNC_NUDGE_METHOD = "POST" as const;
export const GITHUB_DIRTY_SCOPE_MAX_SCOPES_PER_REPO = 100;
export const GITHUB_DIRTY_SCOPE_COMMAND_TIMEOUT_MS = 30_000;

export type GitHubDirtyScope = {
  kind: GitHubDirtyScopeKind;
  repositoryId?: string;
  repositoryFullName?: string;
  branchName?: string;
  pullRequestNumber?: number;
  reviewId?: string;
  commentId?: string;
  checkRunId?: string;
};

export type GitHubResyncNudgeBody = {
  scopes: GitHubDirtyScope[];
  triggers?: GitHubDirtyTrigger[];
  fallbackReason?: GitHubDirtyFallbackReason;
  computeTargetId?: string;
  gatewayId?: string;
  profileId?: string;
};
