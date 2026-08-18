import { BranchFileCacheStatus } from "@repo/api/src/types/artifact";
import {
  BranchViewFileCacheSyncErrorCode,
  BranchViewSyncErrorCode,
  BranchViewSyncOutcomeSource,
  BranchViewSyncPresentationState,
  type BranchViewSyncState,
  BranchViewSyncThrottleReason,
} from "@repo/api/src/types/branch-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchViewData } from "../../types";
import {
  getFileCacheDisplayMessage,
  getLifecycleSyncDisplayLabel,
  getSyncRetryLabel,
} from "../branch-view-sync-display";

function syncState(
  overrides: Partial<BranchViewSyncState> = {}
): BranchViewSyncState {
  return {
    backgroundRefreshAfterAt: null,
    branchLastAttemptedAt: null,
    branchLastSyncedAt: null,
    inProgress: false,
    lastOutcome: {
      code: null,
      httpStatus: null,
      message: null,
      retryAfterSeconds: null,
      source: null,
      synced: null,
    },
    lifecycleLastAttemptedAt: null,
    lifecycleLastSyncedAt: null,
    presentation: BranchViewSyncPresentationState.Unknown,
    ...overrides,
  };
}

function branch(
  overrides: Partial<NonNullable<BranchViewData["branch"]>> = {}
): NonNullable<BranchViewData["branch"]> {
  return {
    artifactId: "branch-1",
    baseBranch: "main",
    baseBranchSource: "repository_default",
    branchName: "feature/test",
    checksStatus: null,
    fileCacheFileCount: 0,
    fileCacheHeadSha: null,
    fileCachePatchBytes: 0,
    fileCacheStatus: BranchFileCacheStatus.Failed,
    fileCacheUpdatedAt: null,
    headSha: null,
    headShaObservedAt: null,
    headShaSource: null,
    lastPushBeforeSha: null,
    lastSyncCompletedAt: null,
    lastSyncErrorCode: null,
    lastSyncErrorMessage: null,
    lastSyncStartedAt: null,
    syncStatus: "idle",
    ...overrides,
  };
}

describe("Branch View sync display helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T17:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [BranchViewSyncThrottleReason.LocalDedupe, "Refresh available in 7s"],
    [
      BranchViewSyncThrottleReason.InFlight,
      "Refresh already running. Try again in 7s",
    ],
    [
      BranchViewSyncThrottleReason.ProviderRateLimit,
      "GitHub rate limited. Try again in 7s",
    ],
    ["future_reason", "Try again in 7s"],
  ])("maps %s retry states to safe labels", (throttleReason, expected) => {
    expect(
      getSyncRetryLabel({
        retryAfterSeconds: 7,
        throttleReason: throttleReason as BranchViewSyncThrottleReason,
      })
    ).toBe(expected);
  });

  it("uses retry-state labels before lifecycle fallback labels", () => {
    const label = getLifecycleSyncDisplayLabel({
      syncRetryState: {
        retryAfterSeconds: 12,
        throttleReason: BranchViewSyncThrottleReason.InFlight,
      },
      isBranchSyncPending: false,
      syncState: syncState({
        presentation: BranchViewSyncPresentationState.Refreshing,
      }),
    });

    expect(label).toBe("Refresh already running. Try again in 12s");
  });

  it("maps lifecycle sync codes to client-owned safe labels", () => {
    const label = getLifecycleSyncDisplayLabel({
      syncRetryState: null,
      isBranchSyncPending: false,
      syncState: syncState({
        lastOutcome: {
          code: BranchViewSyncErrorCode.PrLifecycleUnavailable,
          httpStatus: 502,
          message: "server fallback text",
          retryAfterSeconds: null,
          source: BranchViewSyncOutcomeSource.PullRequestLifecycle,
          synced: false,
        },
        lifecycleLastSyncedAt: "2026-05-27T16:55:00.000Z",
        presentation: BranchViewSyncPresentationState.ShowingLastKnown,
      }),
    });

    expect(label).toBe("Could not reach GitHub. Showing last-known PR status.");
  });

  it("falls back safely for unknown lifecycle or branch sync codes", () => {
    const label = getLifecycleSyncDisplayLabel({
      syncRetryState: null,
      isBranchSyncPending: false,
      syncState: syncState({
        branchLastSyncedAt: "2026-05-27T16:55:00.000Z",
        lastOutcome: {
          code: "provider_secret_raw_code",
          httpStatus: null,
          message: "token ghp_secret leaked by provider",
          retryAfterSeconds: null,
          source: BranchViewSyncOutcomeSource.BranchSync,
          synced: false,
        },
      }),
    });

    expect(label).toBe("Sync did not complete. Showing last-known data.");
  });

  it("returns no label for omitted syncState unless a local overlay exists", () => {
    expect(
      getLifecycleSyncDisplayLabel({
        syncRetryState: null,
        isBranchSyncPending: false,
        syncState: undefined,
      })
    ).toBeNull();
    expect(
      getLifecycleSyncDisplayLabel({
        syncRetryState: null,
        isBranchSyncPending: true,
        syncState: undefined,
      })
    ).toBe("Refreshing");
  });

  it("maps file-cache codes to safe labels without using raw messages", () => {
    const message = getFileCacheDisplayMessage({
      branch: branch(),
      committedFileCount: 0,
      syncState: syncState({
        lastOutcome: {
          code: BranchViewFileCacheSyncErrorCode.MissingCompareRefs,
          httpStatus: 400,
          message: "raw provider text",
          retryAfterSeconds: null,
          source: BranchViewSyncOutcomeSource.FileCache,
          synced: false,
        },
      }),
    });

    expect(message).toBe("File comparison is unavailable for this branch.");
  });

  it("shows the immediate refreshing label for an in-progress sync without a retry state", () => {
    const label = getLifecycleSyncDisplayLabel({
      syncRetryState: null,
      isBranchSyncPending: false,
      syncState: syncState({
        presentation: BranchViewSyncPresentationState.Refreshing,
      }),
    });

    expect(label).toBe("Refreshing");
  });

  it("reports PR sync status unavailable when a lifecycle error has no synced timestamp yet", () => {
    const label = getLifecycleSyncDisplayLabel({
      syncRetryState: null,
      isBranchSyncPending: false,
      syncState: syncState({
        branchLastSyncedAt: null,
        lastOutcome: {
          code: BranchViewSyncErrorCode.PrLifecycleUnavailable,
          httpStatus: 502,
          message: "server fallback text",
          retryAfterSeconds: null,
          source: BranchViewSyncOutcomeSource.PullRequestLifecycle,
          synced: false,
        },
        lifecycleLastSyncedAt: null,
        presentation: BranchViewSyncPresentationState.ShowingLastKnown,
      }),
    });

    expect(label).toBe("PR sync status unavailable");
  });

  it.each([
    ["2026-05-27T16:55:00.000Z", "Showing last synced 5 min ago"],
    [null, "Showing last known"],
  ])("shows the last-known fallback label for lifecycleLastSyncedAt=%s", (lifecycleLastSyncedAt, expected) => {
    const label = getLifecycleSyncDisplayLabel({
      syncRetryState: null,
      isBranchSyncPending: false,
      syncState: syncState({
        lifecycleLastSyncedAt,
        presentation: BranchViewSyncPresentationState.ShowingLastKnown,
      }),
    });

    expect(label).toBe(expected);
  });

  it("falls back to sync status unknown when no timestamp or outcome is available", () => {
    const label = getLifecycleSyncDisplayLabel({
      syncRetryState: null,
      isBranchSyncPending: false,
      syncState: syncState({
        branchLastSyncedAt: null,
        lifecycleLastSyncedAt: null,
        presentation: BranchViewSyncPresentationState.Unknown,
      }),
    });

    expect(label).toBe("Sync status unknown");
  });

  it("returns no file-cache message when no branch has loaded yet", () => {
    expect(
      getFileCacheDisplayMessage({
        branch: null,
        committedFileCount: 3,
        syncState: undefined,
      })
    ).toBeNull();
  });

  it.each([
    [0, "Could not refresh file changes from GitHub."],
    [
      5,
      "Showing last synced file changes. Could not refresh file changes from GitHub.",
    ],
  ])("reports the compare-failed file-cache message for committedFileCount=%s", (committedFileCount, expected) => {
    const message = getFileCacheDisplayMessage({
      branch: branch(),
      committedFileCount,
      syncState: syncState({
        lastOutcome: {
          code: BranchViewFileCacheSyncErrorCode.CompareFailed,
          httpStatus: 502,
          message: "raw provider text",
          retryAfterSeconds: null,
          source: BranchViewSyncOutcomeSource.FileCache,
          synced: false,
        },
      }),
    });

    expect(message).toBe(expected);
  });

  it.each([
    [0, "The latest file refresh failed."],
    [5, "Showing last synced file changes. The latest file refresh failed."],
  ])("reports the failed file-cache-status message for committedFileCount=%s", (committedFileCount, expected) => {
    const message = getFileCacheDisplayMessage({
      branch: branch({ fileCacheStatus: BranchFileCacheStatus.Failed }),
      committedFileCount,
      syncState: undefined,
    });

    expect(message).toBe(expected);
  });
});
