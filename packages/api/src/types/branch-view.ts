/**
 * Branch View API types.
 * Used by both apps/api (backend) and apps/app (frontend).
 */

import { PrCommentAuthorKind as SharedPrCommentAuthorKind } from "@closedloop-ai/loops-api/branch-view";
import type { ChecksStatus, ReviewDecision } from "./branch-checks";
import { ThreadSource, ThreadStatus } from "./comment";
import type { GitHubPRState, StatusCheckRollupFailureReason } from "./github";

// `ChecksStatus`/`ReviewDecision` are defined in `./branch-checks` (see that
// file for why they cannot live here) and re-exported so existing `branch-view`
// consumers keep importing them from this module.
// biome-ignore lint/performance/noBarrelFile: targeted re-export of two enums to preserve branch-view's public surface; the canonical definitions live in ./branch-checks so branch-view.ts stays out of the desktop nodenext program.
export { ChecksStatus, ReviewDecision } from "./branch-checks";

// --- Const objects mirroring Prisma enums for frontend use ---

export const PRReviewCommentState = {
  Pending: "PENDING",
  Addressed: "ADDRESSED",
  Dismissed: "DISMISSED",
} as const;
export type PRReviewCommentState =
  (typeof PRReviewCommentState)[keyof typeof PRReviewCommentState];

export const FileChangeStatus = {
  Added: "added",
  Modified: "modified",
  Removed: "removed",
  Renamed: "renamed",
  Copied: "copied",
} as const;
export type FileChangeStatus =
  (typeof FileChangeStatus)[keyof typeof FileChangeStatus];

export const PrCommentAuthorKind = SharedPrCommentAuthorKind;
export type PrCommentAuthorKind =
  (typeof PrCommentAuthorKind)[keyof typeof PrCommentAuthorKind];

export const BranchViewCommentSource = {
  Github: "github",
} as const;
export type BranchViewCommentSource =
  (typeof BranchViewCommentSource)[keyof typeof BranchViewCommentSource];

export const THREAD_SOURCE_TO_BRANCH_VIEW_COMMENT_SOURCE = {
  [ThreadSource.Github]: BranchViewCommentSource.Github,
} as const satisfies Partial<Record<ThreadSource, BranchViewCommentSource>>;

export const GitHubCommentThreadKind = {
  ReviewThread: "REVIEW_THREAD",
  IssueComment: "ISSUE_COMMENT",
} as const;
export type GitHubCommentThreadKind =
  (typeof GitHubCommentThreadKind)[keyof typeof GitHubCommentThreadKind];

export const GitHubDiffSide = {
  Left: "LEFT",
  Right: "RIGHT",
} as const;
export type GitHubDiffSide =
  (typeof GitHubDiffSide)[keyof typeof GitHubDiffSide];

export const GITHUB_LEGACY_COMMENT_STATE_TO_THREAD_STATUS = {
  [PRReviewCommentState.Pending]: ThreadStatus.Open,
  [PRReviewCommentState.Addressed]: ThreadStatus.Resolved,
  [PRReviewCommentState.Dismissed]: ThreadStatus.Resolved,
} as const satisfies Record<PRReviewCommentState, ThreadStatus>;

export const BranchViewCommentAction = {
  CreateConversation: "create_conversation",
  CreateInline: "create_inline",
  Reply: "reply",
  Edit: "edit",
  Delete: "delete",
  Resolve: "resolve",
  Unresolve: "unresolve",
} as const;
export type BranchViewCommentAction =
  (typeof BranchViewCommentAction)[keyof typeof BranchViewCommentAction];

export const BranchViewCommentActionResultCode = {
  Success: "success",
  FeatureDisabled: "feature_disabled",
  InvalidRequest: "invalid_request",
  CommentNotFound: "comment_not_found",
  UnsupportedCommentKind: "unsupported_comment_kind",
  CommentNotResolvable: "comment_not_resolvable",
  GithubThreadMissing: "github_thread_missing",
  GithubWriteFailed: "github_write_failed",
  GithubProjectionFailed: "github_projection_failed",
  GithubIdentityRequired: "github_identity_required",
  GithubIdentityExpired: "github_identity_expired",
  UnauthorizedCommentAction: "unauthorized_comment_action",
  StaleHeadSha: "stale_head_sha",
  AnchorNotInDiff: "anchor_not_in_diff",
  InvalidAnchor: "invalid_anchor",
  AppAuthoredCommentReadOnly: "app_authored_comment_read_only",
} as const;
export type BranchViewCommentActionResultCode =
  (typeof BranchViewCommentActionResultCode)[keyof typeof BranchViewCommentActionResultCode];

/**
 * Token-free presentation values for the current user's Branch View comment
 * write identity. These values describe status only; authorization decisions
 * must come from server-owned per-action policy.
 */
export const BranchViewCommentWriteIdentityStatus = {
  Active: "active",
  Missing: "missing",
  Expired: "expired",
  Revoked: "revoked",
  DecryptionFailed: "decryption_failed",
} as const;
export type BranchViewCommentWriteIdentityStatus =
  (typeof BranchViewCommentWriteIdentityStatus)[keyof typeof BranchViewCommentWriteIdentityStatus];

/** Public subset of the server-local GitHub write identity. */
export type BranchViewCommentWriteIdentity = {
  status: BranchViewCommentWriteIdentityStatus;
};

/** Exact token-free identity blocker shape exposed to app clients. */
export type BranchViewCommentIdentityBlocker = {
  status: Exclude<
    BranchViewCommentWriteIdentityStatus,
    typeof BranchViewCommentWriteIdentityStatus.Active
  >;
};

/** Server-owned per-action prompt eligibility for Branch View comment actions. */
export type BranchViewCommentIdentityPromptEligibility =
  | { prompt: false }
  | { prompt: true; identityBlocker: BranchViewCommentIdentityBlocker };

export type BranchViewCommentCreatePromptEligibility = {
  createConversation: BranchViewCommentIdentityPromptEligibility;
  createInline: BranchViewCommentIdentityPromptEligibility;
};

export type BranchViewCommentActionPromptEligibility = {
  reply: BranchViewCommentIdentityPromptEligibility;
  edit: BranchViewCommentIdentityPromptEligibility;
  delete: BranchViewCommentIdentityPromptEligibility;
  resolve: BranchViewCommentIdentityPromptEligibility;
  unresolve: BranchViewCommentIdentityPromptEligibility;
};

export const BranchViewSyncErrorCode = {
  SyncThrottled: "branch_view_sync_throttled",
  CurrentPullRequestStale: "branch_view_current_pull_request_stale",
  PrLifecycleUnavailable: "branch_view_pr_lifecycle_unavailable",
  PrLifecycleGuardFailed: "branch_view_pr_lifecycle_guard_failed",
  FileCacheRefreshFailed: "branch_view_file_cache_refresh_failed",
  PrSyncFailed: "branch_view_pr_sync_failed",
} as const;
export type BranchViewSyncErrorCode =
  (typeof BranchViewSyncErrorCode)[keyof typeof BranchViewSyncErrorCode];

export const BranchViewLoadErrorCode = {
  LinkNotFound: "branch_view_link_not_found",
  PullRequestUnavailable: "branch_view_pull_request_unavailable",
  TransientLoadError: "branch_view_transient_load_error",
} as const;
export type BranchViewLoadErrorCode =
  (typeof BranchViewLoadErrorCode)[keyof typeof BranchViewLoadErrorCode];

/**
 * Optional read-only recovery hints for failed Branch View loads.
 * Absent fields are omitted from JSON instead of serialized as null.
 */
export type BranchViewLoadErrorDetails = {
  githubPullRequestUrl?: string;
  featureSlug?: string;
  featureTitle?: string;
  producedByPlanSlug?: string;
  producedByPlanTitle?: string;
  projectId?: string;
  projectName?: string;
  teamId?: string;
  teamName?: string;
};

export const BranchViewFileCacheSyncErrorCode = {
  MissingCompareRefs: "missing_compare_refs",
  CompareFailed: "compare_failed",
} as const;
export type BranchViewFileCacheSyncErrorCode =
  (typeof BranchViewFileCacheSyncErrorCode)[keyof typeof BranchViewFileCacheSyncErrorCode];

export const BranchViewSyncFailureReason = {
  StaleCurrentPullRequestRelation: "stale_current_pull_request_relation",
  MissingCurrentPullRequest: "missing_current_pull_request",
  GitHubPrSyncUnavailable: "github_pr_sync_unavailable",
  GitHubPrUnavailable: "github_pr_unavailable",
  GuardedWriteFailed: "guarded_write_failed",
  FileCacheRefreshFailed: "file_cache_refresh_failed",
} as const;
export type BranchViewSyncFailureReason =
  (typeof BranchViewSyncFailureReason)[keyof typeof BranchViewSyncFailureReason];

export const BranchViewSyncScope = {
  Branch: "branch",
  Comments: "comments",
} as const;
export type BranchViewSyncScope =
  (typeof BranchViewSyncScope)[keyof typeof BranchViewSyncScope];

export const BranchViewSyncThrottleReason = {
  LocalDedupe: "local_dedupe",
  InFlight: "in_flight",
  ProviderRateLimit: "provider_rate_limit",
} as const;
export type BranchViewSyncThrottleReason =
  (typeof BranchViewSyncThrottleReason)[keyof typeof BranchViewSyncThrottleReason];

export const BranchViewSyncPresentationState = {
  Unknown: "unknown",
  Fresh: "fresh",
  Refreshing: "refreshing",
  ShowingLastKnown: "showing_last_known",
  /** Reserved for a future UI state that projects provider throttling directly. */
  RateLimited: "rate_limited",
  Failed: "failed",
} as const;
export type BranchViewSyncPresentationState =
  (typeof BranchViewSyncPresentationState)[keyof typeof BranchViewSyncPresentationState];

export const BranchViewSyncOutcomeSource = {
  BranchSync: "branch_sync",
  PullRequestLifecycle: "pull_request_lifecycle",
  FileCache: "file_cache",
  /** Reserved for future manual-sync attribution separate from scoped sources. */
  ManualRequest: "manual_request",
  Comments: "comments",
} as const;
export type BranchViewSyncOutcomeSource =
  (typeof BranchViewSyncOutcomeSource)[keyof typeof BranchViewSyncOutcomeSource];

export const BRANCH_VIEW_LOCAL_DEDUPE_MS = 5000;
export const BRANCH_VIEW_IN_FLIGHT_STALE_MS = 60_000;
export const BRANCH_VIEW_PROVIDER_RETRY_FALLBACK_SECONDS = 60;
export const BRANCH_VIEW_BACKGROUND_STALE_MS = 300_000;

export type BranchViewSyncRequest = {
  scope?: BranchViewSyncScope;
};

export type BranchViewSyncResponse = {
  synced: boolean;
  scope: BranchViewSyncScope;
  retryAfterSeconds?: number;
  throttleReason?: BranchViewSyncThrottleReason | null;
};

export type BranchViewSyncOutcome = {
  synced: boolean | null;
  code: string | null;
  message: string | null;
  httpStatus: 400 | 409 | 429 | 500 | 502 | null;
  retryAfterSeconds: number | null;
  throttleReason?: BranchViewSyncThrottleReason | null;
  source: BranchViewSyncOutcomeSource | null;
};

export type BranchViewSyncState = {
  lifecycleLastSyncedAt: string | null;
  lifecycleLastAttemptedAt: string | null;
  branchLastSyncedAt: string | null;
  branchLastAttemptedAt: string | null;
  inProgress: boolean;
  presentation: BranchViewSyncPresentationState;
  backgroundRefreshAfterAt: string | null;
  lastOutcome: BranchViewSyncOutcome;
};

export const BranchViewPrLifecycleRepairStatus = {
  Idle: "idle",
  Pending: "pending",
} as const;
export type BranchViewPrLifecycleRepairStatus =
  (typeof BranchViewPrLifecycleRepairStatus)[keyof typeof BranchViewPrLifecycleRepairStatus];

export type BranchViewPrLifecycleRepair = {
  /** Server-derived read-repair state; clients should not infer freshness from timestamps. */
  status: BranchViewPrLifecycleRepairStatus;
};

export const BranchViewCommentActionRecovery = {
  BranchViewSync: "branch_view_sync",
  DirectReprojection: "direct_reprojection",
} as const;
export type BranchViewCommentActionRecovery =
  (typeof BranchViewCommentActionRecovery)[keyof typeof BranchViewCommentActionRecovery];

export const BRANCH_VIEW_COMMENT_ACTION_RESULT_HTTP_STATUS = {
  [BranchViewCommentActionResultCode.Success]: 200,
  [BranchViewCommentActionResultCode.InvalidRequest]: 400,
  [BranchViewCommentActionResultCode.FeatureDisabled]: 403,
  [BranchViewCommentActionResultCode.GithubIdentityRequired]: 403,
  [BranchViewCommentActionResultCode.GithubIdentityExpired]: 403,
  [BranchViewCommentActionResultCode.UnauthorizedCommentAction]: 403,
  [BranchViewCommentActionResultCode.AppAuthoredCommentReadOnly]: 403,
  [BranchViewCommentActionResultCode.CommentNotFound]: 404,
  [BranchViewCommentActionResultCode.UnsupportedCommentKind]: 409,
  [BranchViewCommentActionResultCode.CommentNotResolvable]: 409,
  [BranchViewCommentActionResultCode.GithubThreadMissing]: 409,
  [BranchViewCommentActionResultCode.StaleHeadSha]: 409,
  [BranchViewCommentActionResultCode.AnchorNotInDiff]: 422,
  [BranchViewCommentActionResultCode.InvalidAnchor]: 422,
  [BranchViewCommentActionResultCode.GithubWriteFailed]: 502,
  [BranchViewCommentActionResultCode.GithubProjectionFailed]: 202,
} as const satisfies Record<BranchViewCommentActionResultCode, number>;

export const BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES = {
  canReply: "canReply",
  canEdit: "canEdit",
  canDelete: "canDelete",
  canResolve: "canResolve",
  canUnresolve: "canUnresolve",
} as const;
export type BranchViewGithubCommentCapabilities = {
  [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canReply]: boolean;
  [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canEdit]: boolean;
  [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canDelete]: boolean;
  [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canResolve]: boolean;
  [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canUnresolve]: boolean;
};

// --- Data types ---

export type BranchViewFile = {
  path: string;
  previousPath: string | null;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  patch: string | null;
};

export const CommentKind = {
  ReviewComment: "review_comment",
  IssueComment: "issue_comment",
} as const;
export type CommentKind = (typeof CommentKind)[keyof typeof CommentKind];

export const GITHUB_COMMENT_THREAD_KIND_TO_COMMENT_KIND = {
  [GitHubCommentThreadKind.ReviewThread]: CommentKind.ReviewComment,
  [GitHubCommentThreadKind.IssueComment]: CommentKind.IssueComment,
} as const satisfies Record<GitHubCommentThreadKind, CommentKind>;

export type BranchViewComment = {
  id: string;
  /** Raw GitHub comment id. Provider action routes still use this value. */
  githubCommentId: string;
  source?: BranchViewCommentSource;
  /** Local unified thread id. Prefer this, with commentId, for UI identity. */
  threadId?: string;
  /** Local unified comment id. Prefer this over raw provider ids for UI identity. */
  commentId?: string;
  author: string;
  authorAvatar: string | null;
  authorProfileUrl?: string | null;
  authorKind: PrCommentAuthorKind;
  body: string;
  createdAt: string;
  path: string | null;
  line: number | null;
  /** Provider commit SHA for diff-anchor freshness checks. Null when unavailable or not applicable. */
  anchorCommitSha?: string | null;
  /** Side-aware GitHub diff anchor data. A missing side means clients must not guess a row placement. */
  side?: GitHubDiffSide | null;
  startLine?: number | null;
  startSide?: GitHubDiffSide | null;
  state: PRReviewCommentState;
  reviewId: string | null;
  htmlUrl: string;
  inReplyToId: string | null;
  kind: CommentKind;
  resolvable?: boolean;
  resolved?: boolean;
  canReply?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canResolve?: boolean;
  canUnresolve?: boolean;
  /** Optional for backward compatibility with older Branch View producers. */
  actionPromptEligibility?: BranchViewCommentActionPromptEligibility;
};

export type BranchViewReview = {
  id: string;
  author: string;
  authorAvatar: string | null;
  state: ReviewDecision;
  body: string | null;
  submittedAt: string;
  htmlUrl: string;
};

export type BranchViewBranch = {
  artifactId: string;
  branchName: string;
  baseBranch: string | null;
  baseBranchSource: string | null;
  headSha: string | null;
  headShaSource: string | null;
  headShaObservedAt: string | null;
  lastPushBeforeSha: string | null;
  checksStatus: ChecksStatus | null;
  fileCacheStatus: string;
  fileCacheHeadSha: string | null;
  fileCacheFileCount: number;
  fileCachePatchBytes: number;
  fileCacheUpdatedAt: string | null;
  syncStatus: string;
  lastSyncStartedAt: string | null;
  lastSyncCompletedAt: string | null;
  lastSyncErrorCode: string | null;
  lastSyncErrorMessage: string | null;
};

export type BranchViewCurrentPullRequest = {
  id: string;
  // FEA-2732: nullable for repo-less (non-App) PRs surfaced in Branch View that
  // have no GitHub node id until App adoption / `gh` enrichment supplies one.
  githubId: string | null;
  number: number;
  title: string | null;
  htmlUrl: string | null;
  headBranch: string;
  baseBranch: string;
  headSha: string | null;
  state: GitHubPRState;
  isDraft: boolean;
  checksStatus: ChecksStatus | null;
  reviewDecision: ReviewDecision | null;
};

/** Supported check-detail row kinds projected into Branch View. */
export const BranchViewCheckKind = {
  CheckRun: "check_run",
  StatusContext: "status_context",
} as const;
export type BranchViewCheckKind =
  (typeof BranchViewCheckKind)[keyof typeof BranchViewCheckKind];

/** Durable provider-state metadata for the current Branch View head. */
export const BranchViewChecksProviderState = {
  Available: "available",
  NoChecks: "no_checks",
  ProviderUnavailable: "provider_unavailable",
} as const;
export type BranchViewChecksProviderState =
  (typeof BranchViewChecksProviderState)[keyof typeof BranchViewChecksProviderState];

export type BranchViewCheck = {
  id: string;
  kind: BranchViewCheckKind;
  name: string;
  status: string | null;
  conclusion: string | null;
  targetUrl: string | null;
};

export type BranchViewCheckProjection = {
  headSha: string;
  providerState: BranchViewChecksProviderState;
  unavailableReason: StatusCheckRollupFailureReason | null;
  totalCount: number;
  truncated: boolean;
  items: BranchViewCheck[];
};

export type BranchViewData = {
  externalLinkId: string;
  branch: BranchViewBranch | null;
  currentPullRequest: BranchViewCurrentPullRequest | null;
  prTitle: string;
  externalUrl: string;
  prNumber: number;
  prHtmlUrl: string;
  featureSlug: string | null;
  featureTitle: string | null;
  teamId: string | null;
  teamName: string | null;
  projectId: string | null;
  projectName: string | null;
  headBranch: string;
  baseBranch: string;
  headSha: string | null;
  prState: GitHubPRState;
  prLifecycleRepair?: BranchViewPrLifecycleRepair;
  syncState?: BranchViewSyncState;
  reviewDecision: ReviewDecision | null;
  checksStatus: ChecksStatus | null;
  checks?: BranchViewCheckProjection;
  isDraft: boolean;
  authorLogin: string | null;
  isAuthor: boolean;
  canCreateConversationComment: boolean;
  canCreateInlineComment: boolean;
  /** Token-free current-user write-identity status for copy/tests only. */
  commentWriteIdentity?: BranchViewCommentWriteIdentity;
  /** Server-owned prompt eligibility for create surfaces. */
  commentPromptEligibility?: BranchViewCommentCreatePromptEligibility;
  repoFullName: string;
  committedFiles: BranchViewFile[];
  reviews: BranchViewReview[];
  comments: BranchViewComment[];
  producedByPlanSlug: string | null;
  producedByPlanTitle: string | null;
};

export type BranchViewFileDiff = {
  path: string;
  oldContent: string;
  newContent: string;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
};

export type ReplyToCommentInput = {
  commentGithubId: number;
  body: string;
};

export type ReplyToCommentResponse = BranchViewComment;

export type CreateBranchViewConversationCommentRequest = {
  body: string;
};

export type CreateBranchViewInlineCommentRequest = {
  body: string;
  path: string;
  line: number;
  side: GitHubDiffSide;
  expectedHeadSha: string;
  startLine?: number;
  startSide?: GitHubDiffSide;
};

export type UpdateBranchViewCommentRequest = {
  body: string;
};

export type ResolveBranchViewCommentRequest = Record<string, never>;

export type UnresolveBranchViewCommentRequest = Record<string, never>;

export type BranchViewCommentActionSuccessResult = {
  success: true;
  action: BranchViewCommentAction;
  comment: BranchViewComment;
};

export type BranchViewCommentActionFailureResult = {
  success: false;
  action: BranchViewCommentAction;
  code: BranchViewCommentActionResultCode;
  message: string;
  /** Present only when GitHub write identity is the effective blocker. */
  identityBlocker?: BranchViewCommentIdentityBlocker;
  recovery?: BranchViewCommentActionRecovery;
  github?: {
    commentId?: string;
    reviewThreadId?: string;
  };
};

export type BranchViewCommentActionResult =
  | BranchViewCommentActionSuccessResult
  | BranchViewCommentActionFailureResult;

/**
 * Return fail-closed capability hints for GitHub-backed branch-view comments.
 */
export function getDefaultBranchViewGithubCommentCapabilities(): BranchViewGithubCommentCapabilities {
  return {
    [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canReply]: false,
    [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canEdit]: false,
    [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canDelete]: false,
    [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canResolve]: false,
    [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canUnresolve]: false,
  };
}

/**
 * Parse a GitHub issue-comment id string into the positive integer the
 * reply/edit/delete routes expect (`z.number().int().positive()`).
 *
 * Not every comment row carries a numeric `githubCommentId` — review comments
 * and synthetic rows use non-numeric ids — so `Number(...)` can yield `NaN`.
 * Returns the parsed positive safe integer, or `null` when the id is missing or
 * non-numeric. Single source of truth for both the client reply-target guard
 * (`getReplyTargetGithubCommentId`) and the server-side conversation service.
 */
export function parseNumericGithubCommentId(
  githubCommentId: string
): number | null {
  const parsed = Number(githubCommentId.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}
