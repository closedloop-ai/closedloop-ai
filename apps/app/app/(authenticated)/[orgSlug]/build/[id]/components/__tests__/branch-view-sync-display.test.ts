import { BranchFileCacheStatus } from "@repo/api/src/types/artifact";
import {
  BranchViewFileCacheSyncErrorCode,
  BranchViewSyncErrorCode,
  BranchViewSyncOutcomeSource,
  BranchViewSyncPresentationState,
  type BranchViewSyncState,
  BranchViewSyncThrottleReason,
} from "@repo/api/src/types/branch-view";
import { describe, expect, it } from "vitest";
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
});
