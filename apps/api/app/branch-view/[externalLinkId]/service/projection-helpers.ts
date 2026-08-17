/**
 * @file projection-helpers.ts
 * @description Pure value mappers, thread ordering, and sync-outcome
 * presentation for the Branch View service.
 *
 * Extracted from `../service.ts`, which is on the shrink-only
 * `noExcessiveLinesPerFile` grandfather list at ~2,800 lines against the 1,000
 * ceiling — the root `AGENTS.md` asks that a substantive change to such a file
 * leave it meaningfully smaller by extracting the cohesive units it touches.
 * These functions are the most cohesive unit in there: every one is pure (no
 * `withDb`, no GitHub client, no I/O), which is also what makes them directly
 * testable rather than reachable only through the whole service.
 *
 * Follows the `apps/api` nested-concern convention (`app/<resource>/service/
 * <concern>.ts`) alongside the existing `sync-results.ts` and
 * `provider-refresh.ts` siblings; `../service.ts` stays the only module routes
 * consume.
 */

import type { BranchViewSyncOutcome } from "@repo/api/src/types/branch-view";
import {
  BranchViewFileCacheSyncErrorCode,
  BranchViewSyncErrorCode,
  ChecksStatus,
  FileChangeStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-view";
import { GitHubPRState } from "@repo/api/src/types/github";
import { log } from "@repo/observability/log";

/** Map a GitHub file status string onto the served `FileChangeStatus`. */
export function mapFileStatus(status: string): FileChangeStatus {
  switch (status) {
    case "added":
      return FileChangeStatus.Added;
    case "removed":
      return FileChangeStatus.Removed;
    case "renamed":
      return FileChangeStatus.Renamed;
    case "copied":
      return FileChangeStatus.Copied;
    default:
      return FileChangeStatus.Modified;
  }
}

/**
 * Map the stored checks state onto the API contract. Prisma's enum values match
 * the const-object values, so an unrecognized one degrades to `null` (unknown)
 * rather than being asserted into the union.
 */
export function mapChecksStatus(dbValue: string | null): ChecksStatus | null {
  if (!dbValue) {
    return null;
  }
  const mapping: Record<string, ChecksStatus> = {
    UNKNOWN: ChecksStatus.Unknown,
    PENDING: ChecksStatus.Pending,
    PASSING: ChecksStatus.Passing,
    FAILING: ChecksStatus.Failing,
  };
  return mapping[dbValue] ?? null;
}

/** Map the stored review decision onto the API contract; unknown → `null`. */
export function mapReviewDecision(
  dbValue: string | null | undefined
): ReviewDecision | null {
  if (!dbValue) {
    return null;
  }
  const mapping: Record<string, ReviewDecision> = {
    APPROVED: ReviewDecision.Approved,
    CHANGES_REQUESTED: ReviewDecision.ChangesRequested,
    COMMENTED: ReviewDecision.Commented,
    DISMISSED: ReviewDecision.Dismissed,
  };
  return mapping[dbValue] ?? null;
}

/**
 * Narrow a stored PR state onto the union. An unrecognized value is a store
 * defect, not a normal state, so it is reported before defaulting to OPEN —
 * the default keeps the read serving rather than failing it.
 */
export function mapPrState(dbValue: string | null | undefined): GitHubPRState {
  switch (dbValue) {
    case GitHubPRState.Open:
    case GitHubPRState.Merged:
    case GitHubPRState.Closed:
      return dbValue;
    default:
      log.warn("[branch-view] Invalid PR state, defaulting to OPEN", {
        prState: dbValue,
      });
      return GitHubPRState.Open;
  }
}

/** ISO-serialize a nullable date, preserving `null` rather than emitting an epoch. */
export function isoOrNull(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/** Split `owner/repo`, rejecting anything that is not exactly two segments. */
export function parseBranchViewRepositoryFullName(
  fullName: string
): { owner: string; repo: string } | null {
  const [owner, repo, ...extra] = fullName.split("/");
  if (!(owner && repo) || extra.length > 0) {
    return null;
  }
  return { owner, repo };
}

/** The ordering-relevant projection of one unified comment thread. */
export type UnifiedThreadRow = {
  id: string;
  createdAt: Date;
  githubProjection: {
    path: string | null;
    line: number | null;
  } | null;
};

/** Nulls sort LAST, so unanchored threads never displace anchored ones. */
export function compareNullableStringsLast(
  a: string | null,
  b: string | null
): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a.localeCompare(b);
}

/** Nulls sort LAST — see {@link compareNullableStringsLast}. */
export function compareNullableNumbersLast(
  a: number | null,
  b: number | null
): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a - b;
}

/**
 * Order threads by file path, then line, then creation time, with `id` as the
 * final tiebreak so the sort is TOTAL — two threads created in the same
 * millisecond on the same anchor must still order deterministically, or the
 * served list can reshuffle between reads.
 */
export function compareUnifiedThreadRows(
  a: UnifiedThreadRow,
  b: UnifiedThreadRow
): number {
  const pathComparison = compareNullableStringsLast(
    a.githubProjection?.path ?? null,
    b.githubProjection?.path ?? null
  );
  if (pathComparison !== 0) {
    return pathComparison;
  }

  const lineComparison = compareNullableNumbersLast(
    a.githubProjection?.line ?? null,
    b.githubProjection?.line ?? null
  );
  if (lineComparison !== 0) {
    return lineComparison;
  }

  const createdAtComparison = a.createdAt.getTime() - b.createdAt.getTime();
  return createdAtComparison === 0
    ? a.id.localeCompare(b.id)
    : createdAtComparison;
}

/**
 * HTTP status for a sync outcome. `null` means "no dedicated status" — the
 * caller keeps serving last-known data rather than turning a partial sync into
 * an error response.
 */
export function getBranchViewSyncOutcomeHttpStatus(
  code: string | null
): BranchViewSyncOutcome["httpStatus"] {
  switch (code) {
    case BranchViewSyncErrorCode.SyncThrottled:
      return 429;
    case BranchViewSyncErrorCode.CurrentPullRequestStale:
    case BranchViewSyncErrorCode.PrLifecycleGuardFailed:
      return 409;
    case BranchViewSyncErrorCode.PrLifecycleUnavailable:
      return 502;
    case BranchViewSyncErrorCode.FileCacheRefreshFailed:
    case BranchViewFileCacheSyncErrorCode.CompareFailed:
      return 500;
    case BranchViewSyncErrorCode.PrSyncFailed:
      return null;
    case BranchViewFileCacheSyncErrorCode.MissingCompareRefs:
      return 400;
    default:
      return null;
  }
}

/**
 * User-facing message for a sync outcome. An unrecognized non-null code still
 * gets a generic message — a code this build does not know about is a
 * version-skew case, not a reason to say nothing went wrong.
 */
export function getBranchViewSyncOutcomeMessage(
  code: string | null
): string | null {
  switch (code) {
    case BranchViewSyncErrorCode.SyncThrottled:
      return "Rate limited. Try again later.";
    case BranchViewSyncErrorCode.CurrentPullRequestStale:
    case BranchViewSyncErrorCode.PrLifecycleGuardFailed:
      return "Refreshing PR status. Showing last-known data.";
    case BranchViewSyncErrorCode.PrLifecycleUnavailable:
      return "Could not reach GitHub. Showing last-known PR status.";
    case BranchViewSyncErrorCode.FileCacheRefreshFailed:
      return "Could not refresh file changes. Showing last-known files when available.";
    case BranchViewSyncErrorCode.PrSyncFailed:
      return "Could not sync PR comments from GitHub.";
    case BranchViewFileCacheSyncErrorCode.MissingCompareRefs:
      return "File comparison is unavailable for this branch.";
    case BranchViewFileCacheSyncErrorCode.CompareFailed:
      return "Could not refresh file changes from GitHub.";
    default:
      return code ? "Sync did not complete. Showing last-known data." : null;
  }
}
