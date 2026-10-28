import type { ReconcileRepoStatus } from "@/app/cron/reconcile-pull-requests/repo-reconcile-status";
import type { GitHubRepoSyncDeferralReason } from "@/lib/github/github-repo-sync-state";

type LoggedActionableTick = readonly [
  org: "019d7347" | "other",
  reconcileOutcome: ReconcileRepoStatus,
  deferredReason: GitHubRepoSyncDeferralReason | null,
  writtenCount: number,
  fetchFailureCount: number,
  sessionLinkedPrCount: number,
  enrichedOrVisiblePrCount: number,
];

/**
 * ISS-12033 replay: all 39 prod repo ticks logged with
 * `@actionableZeroWriteWithSessionLinkedTargets:true` from 2026-10-03T16:20Z to
 * 2026-10-05T16:20Z (`pup logs search`, of 3,283 ticks), oldest first. Values
 * are the logged literals; repo names and every org id but the one ISS-12033
 * cites are dropped.
 */
export const ISS_12033_LOGGED_ACTIONABLE_TICKS: readonly LoggedActionableTick[] =
  [
    ["019d7347", "deferred", "budget", 0, 0, 4, 1],
    ["019d7347", "deferred", "contention", 0, 0, 7, 0],
    ["other", "swept", null, 0, 0, 33, 31],
    ["other", "swept", null, 0, 0, 33, 31],
    ["other", "swept", null, 0, 0, 5284, 5281],
    ["019d7347", "deferred", "budget", 0, 0, 4, 4],
    ["019d7347", "deferred", "budget", 0, 0, 2, 2],
    ["019d7347", "deferred", "budget", 0, 0, 16, 16],
    ["019d7347", "deferred", "budget", 0, 0, 69, 62],
    ["019d7347", "deferred", "budget", 0, 0, 7, 7],
    ["other", "swept", null, 0, 0, 33, 31],
    ["other", "swept", null, 0, 0, 5284, 5281],
    ["019d7347", "deferred", "contention", 0, 0, 9, 9],
    ["other", "swept", null, 0, 0, 33, 31],
    ["019d7347", "deferred", "budget", 0, 0, 69, 67],
    ["019d7347", "deferred", "budget", 0, 0, 9, 9],
    ["other", "swept", null, 0, 0, 33, 31],
    ["other", "swept", null, 0, 0, 5284, 5281],
    ["019d7347", "deferred", "contention", 0, 0, 9, 9],
    ["other", "swept", null, 0, 0, 33, 31],
    ["019d7347", "deferred", "contention", 0, 0, 1, 1],
    ["019d7347", "deferred", "budget", 0, 0, 5, 5],
    ["019d7347", "deferred", "budget", 0, 0, 16, 16],
    ["other", "swept", null, 0, 0, 33, 31],
    ["other", "swept", null, 0, 0, 5284, 5281],
    ["019d7347", "deferred", "contention", 0, 0, 9, 9],
    ["other", "swept", null, 0, 0, 33, 31],
    ["other", "swept", null, 0, 0, 5284, 5281],
    ["019d7347", "deferred", "budget", 0, 0, 9, 9],
    ["019d7347", "deferred", "budget", 0, 0, 69, 69],
    ["other", "swept", null, 0, 0, 33, 31],
    ["019d7347", "deferred", "contention", 0, 0, 1, 1],
    ["019d7347", "deferred", "budget", 0, 0, 1, 1],
    ["other", "swept", null, 0, 0, 5284, 5281],
    ["019d7347", "deferred", "contention", 0, 0, 9, 9],
    ["other", "swept", null, 0, 0, 33, 31],
    ["019d7347", "deferred", "contention", 0, 0, 16, 16],
    ["019d7347", "deferred", "budget", 0, 0, 9, 9],
    ["019d7347", "deferred", "budget", 0, 0, 69, 69],
  ];
