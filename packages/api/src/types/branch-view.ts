/**
 * Branch View API types: the Branch sync, file-cache, check and file-diff
 * contract shared by apps/api (backend) and packages/app (frontend).
 */

import { PrCommentAuthorKind as SharedPrCommentAuthorKind } from "@closedloop-ai/loops-api/branch-view";

// ISS-8241: the check-detail projection moved to `./branch-check-projection`
// for the same nodenext reason, and is re-exported so every existing
// `branch-view` consumer keeps its import path.
// biome-ignore lint/performance/noBarrelFile: targeted re-exports preserving branch-view's public surface; the canonical definitions live in ./branch-check-projection and ./branch-checks so branch-view.ts stays out of the desktop nodenext program. The rule reports once per file, on this first re-export, so the sibling below carries no second suppression.
export {
  type BranchViewCheck,
  BranchViewCheckKind,
  type BranchViewCheckProjection,
  BranchViewChecksProviderState,
} from "./branch-check-projection";
// `ChecksStatus`/`ReviewDecision` are defined in `./branch-checks` (see that
// file for why they cannot live here) and re-exported so existing `branch-view`
// consumers keep importing them from this module.
export { ChecksStatus, ReviewDecision } from "./branch-checks";

// --- Const objects mirroring Prisma enums for frontend use ---

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

export const GitHubCommentThreadKind = {
  ReviewThread: "REVIEW_THREAD",
  IssueComment: "ISSUE_COMMENT",
  /** Reserved for the PLN-2122 review-summary thread producer and its readers. */
  ReviewSummary: "REVIEW_SUMMARY",
} as const;
export type GitHubCommentThreadKind =
  (typeof GitHubCommentThreadKind)[keyof typeof GitHubCommentThreadKind];

export const GitHubDiffSide = {
  Left: "LEFT",
  Right: "RIGHT",
} as const;
export type GitHubDiffSide =
  (typeof GitHubDiffSide)[keyof typeof GitHubDiffSide];

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

export const BranchViewFileCacheSyncErrorCode = {
  MissingCompareRefs: "missing_compare_refs",
  CompareFailed: "compare_failed",
} as const;
export type BranchViewFileCacheSyncErrorCode =
  (typeof BranchViewFileCacheSyncErrorCode)[keyof typeof BranchViewFileCacheSyncErrorCode];

export const BranchViewSyncThrottleReason = {
  LocalDedupe: "local_dedupe",
  InFlight: "in_flight",
  ProviderRateLimit: "provider_rate_limit",
} as const;
export type BranchViewSyncThrottleReason =
  (typeof BranchViewSyncThrottleReason)[keyof typeof BranchViewSyncThrottleReason];

export const BRANCH_VIEW_LOCAL_DEDUPE_MS = 5000;
export const BRANCH_VIEW_IN_FLIGHT_STALE_MS = 60_000;
export const BRANCH_VIEW_PROVIDER_RETRY_FALLBACK_SECONDS = 60;

// --- Data types ---

export type BranchViewFileDiff = {
  path: string;
  oldContent: string;
  newContent: string;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
};
