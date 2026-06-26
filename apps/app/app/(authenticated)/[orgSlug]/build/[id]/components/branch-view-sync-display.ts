import { BranchFileCacheStatus } from "@repo/api/src/types/artifact";
import {
  BranchViewFileCacheSyncErrorCode,
  BranchViewSyncErrorCode,
  BranchViewSyncOutcomeSource,
  BranchViewSyncPresentationState,
  type BranchViewSyncState,
  BranchViewSyncThrottleReason,
} from "@repo/api/src/types/branch-view";
import type { BranchViewSyncRetryState } from "@repo/app/documents/hooks/use-branch-view";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import type { BranchViewData } from "../types";

type LifecycleSyncDisplayInput = {
  isBranchSyncPending: boolean;
  syncRetryState: BranchViewSyncRetryState | null;
  syncState: BranchViewSyncState | undefined;
};

type FileCacheDisplayInput = {
  branch: BranchViewData["branch"];
  committedFileCount: number;
  syncState: BranchViewSyncState | undefined;
};

const LIFECYCLE_SYNC_ERROR_LABELS: Partial<Record<string, string>> = {
  [BranchViewSyncErrorCode.CurrentPullRequestStale]:
    "Refreshing PR status. Showing last-known data.",
  [BranchViewSyncErrorCode.PrLifecycleGuardFailed]:
    "Refreshing PR status. Showing last-known data.",
  [BranchViewSyncErrorCode.PrLifecycleUnavailable]:
    "Could not reach GitHub. Showing last-known PR status.",
};

/**
 * Client-owned Branch View sync display labels. API `lastOutcome.message`
 * remains a safe wire diagnostic, but UI surfaces read labels from this helper
 * so lifecycle and file-cache fallbacks cannot drift independently.
 */
export function getLifecycleSyncDisplayLabel({
  isBranchSyncPending,
  syncRetryState,
  syncState,
}: LifecycleSyncDisplayInput): string | null {
  if (syncRetryState) {
    return getSyncRetryLabel(syncRetryState);
  }
  if (!syncState) {
    return isBranchSyncPending ? "Refreshing" : null;
  }
  if (syncState.presentation === BranchViewSyncPresentationState.Refreshing) {
    return "Refreshing";
  }
  const lifecycleLastSyncedAt =
    syncState.lifecycleLastSyncedAt ?? syncState.branchLastSyncedAt;
  const outcome = syncState.lastOutcome;
  const lifecycleOutcome =
    outcome.source === BranchViewSyncOutcomeSource.PullRequestLifecycle ||
    outcome.source === BranchViewSyncOutcomeSource.BranchSync
      ? outcome
      : null;
  if (lifecycleOutcome?.code) {
    const label =
      LIFECYCLE_SYNC_ERROR_LABELS[lifecycleOutcome.code] ??
      "Sync did not complete. Showing last-known data.";
    return lifecycleLastSyncedAt ? label : "PR sync status unavailable";
  }
  if (
    syncState.presentation === BranchViewSyncPresentationState.ShowingLastKnown
  ) {
    return lifecycleLastSyncedAt
      ? `Showing last synced ${formatRelativeTime(lifecycleLastSyncedAt)}`
      : "Showing last known";
  }
  if (lifecycleLastSyncedAt) {
    return `Synced ${formatRelativeTime(lifecycleLastSyncedAt)}`;
  }
  return "Sync status unknown";
}

export function getSyncRetryLabel({
  retryAfterSeconds,
  throttleReason,
}: BranchViewSyncRetryState): string {
  switch (throttleReason) {
    case BranchViewSyncThrottleReason.LocalDedupe:
      return `Refresh available in ${retryAfterSeconds}s`;
    case BranchViewSyncThrottleReason.InFlight:
      return `Refresh already running. Try again in ${retryAfterSeconds}s`;
    case BranchViewSyncThrottleReason.ProviderRateLimit:
      return `GitHub rate limited. Try again in ${retryAfterSeconds}s`;
    default:
      return `Try again in ${retryAfterSeconds}s`;
  }
}

export function getFileCacheDisplayMessage({
  branch,
  committedFileCount,
  syncState,
}: FileCacheDisplayInput): string | null {
  if (!branch) {
    return null;
  }
  const fileCacheOutcome =
    syncState?.lastOutcome.source === BranchViewSyncOutcomeSource.FileCache
      ? syncState.lastOutcome
      : null;
  if (
    fileCacheOutcome?.code ===
    BranchViewFileCacheSyncErrorCode.MissingCompareRefs
  ) {
    return "File comparison is unavailable for this branch.";
  }
  if (
    fileCacheOutcome?.code === BranchViewFileCacheSyncErrorCode.CompareFailed
  ) {
    const label = "Could not refresh file changes from GitHub.";
    return committedFileCount > 0
      ? `Showing last synced file changes. ${label}`
      : label;
  }
  if (branch.fileCacheStatus === BranchFileCacheStatus.Stale) {
    return "Showing last synced file changes for this branch.";
  }
  if (branch.fileCacheStatus === BranchFileCacheStatus.Failed) {
    const message = "The latest file refresh failed.";
    return committedFileCount > 0
      ? "Showing last synced file changes. The latest file refresh failed."
      : message;
  }
  return null;
}
