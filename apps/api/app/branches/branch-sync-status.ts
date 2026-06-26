import { BranchSyncStatus } from "@repo/api/src/types/artifact";
import {
  BRANCH_VIEW_IN_FLIGHT_STALE_MS,
  BRANCH_VIEW_LOCAL_DEDUPE_MS,
  BRANCH_VIEW_PROVIDER_RETRY_FALLBACK_SECONDS,
  BranchViewSyncErrorCode,
  BranchViewSyncThrottleReason,
} from "@repo/api/src/types/branch-view";
import { withDb } from "@repo/database";

const PROVIDER_RATE_LIMITED_SYNC_MESSAGE =
  "GitHub rate limited Branch View refresh";
const BRANCH_SYNC_STATUS_VALUES = new Set<string>(
  Object.values(BranchSyncStatus)
);

export type BranchSyncStartResult =
  | { throttled: false; fileCount: number; patchBytes: number }
  | {
      throttled: true;
      retryAfterSeconds: number;
      throttleReason: BranchViewSyncThrottleReason;
    };

/** Parse persisted branch-sync status strings before using them as contracts. */
export function parseBranchSyncStatus(
  value: string | null | undefined
): BranchSyncStatus | null {
  if (!(value && isBranchSyncStatus(value))) {
    return null;
  }
  return value;
}

function isBranchSyncStatus(value: string): value is BranchSyncStatus {
  return BRANCH_SYNC_STATUS_VALUES.has(value);
}

/**
 * Acquire the branch-level sync throttle used by Branch View refreshes before
 * any provider work starts. A throttled result means callers must avoid all
 * downstream GitHub calls for this user-initiated sync.
 */
export async function startBranchSync(input: {
  organizationId: string;
  branchArtifactId: string;
  headSha: string | null;
  currentFileCacheHeadSha: string | null;
  currentLastSyncStartedAt: Date | null;
  currentLastSyncCompletedAt?: Date | null;
  currentLastSyncErrorCode?: string | null;
  currentSyncStatus?: BranchSyncStatus | null;
  startedAt: Date;
  allowStaleCacheHeadBypass?: boolean;
}): Promise<BranchSyncStartResult> {
  const canBypassThrottle = canBypassRecentSyncForStaleCacheHead(input);
  const currentThrottle = getSyncThrottle({
    lastSyncCompletedAt: input.currentLastSyncCompletedAt ?? null,
    lastSyncErrorCode: input.currentLastSyncErrorCode ?? null,
    lastSyncStartedAt: input.currentLastSyncStartedAt,
    now: input.startedAt,
    syncStatus: input.currentSyncStatus ?? null,
    canBypassLocalDedupe: canBypassThrottle,
  });
  if (currentThrottle) {
    return currentThrottle;
  }

  const inFlightCutoff = new Date(
    input.startedAt.getTime() - BRANCH_VIEW_IN_FLIGHT_STALE_MS
  );
  const localDedupeCutoff = new Date(
    input.startedAt.getTime() - BRANCH_VIEW_LOCAL_DEDUPE_MS
  );
  const providerThrottleCutoff = new Date(
    input.startedAt.getTime() -
      BRANCH_VIEW_PROVIDER_RETRY_FALLBACK_SECONDS * 1000
  );
  const providerThrottleElapsedPredicate = {
    OR: [
      { lastSyncErrorCode: null },
      { lastSyncErrorCode: { not: BranchViewSyncErrorCode.SyncThrottled } },
      { lastSyncCompletedAt: { lt: providerThrottleCutoff } },
      {
        AND: [
          { lastSyncCompletedAt: null },
          { lastSyncStartedAt: { lt: providerThrottleCutoff } },
        ],
      },
    ],
  };
  const staleCacheHeadPredicates =
    canBypassThrottle && input.headSha
      ? [
          {
            AND: [
              { syncStatus: { not: BranchSyncStatus.Syncing } },
              providerThrottleElapsedPredicate,
              {
                OR: [
                  { fileCacheHeadSha: null },
                  { fileCacheHeadSha: { not: input.headSha } },
                ],
              },
            ],
          },
        ]
      : [];
  const updated = await withDb((db) =>
    db.branchDetail.updateMany({
      where: {
        artifactId: input.branchArtifactId,
        artifact: { organizationId: input.organizationId },
        OR: [
          { lastSyncStartedAt: null },
          {
            AND: [
              { syncStatus: BranchSyncStatus.Syncing },
              { lastSyncStartedAt: { lt: inFlightCutoff } },
            ],
          },
          {
            AND: [
              { syncStatus: { not: BranchSyncStatus.Syncing } },
              { lastSyncStartedAt: { lt: localDedupeCutoff } },
              providerThrottleElapsedPredicate,
            ],
          },
          ...staleCacheHeadPredicates,
        ],
      },
      data: {
        syncStatus: BranchSyncStatus.Syncing,
        lastSyncStartedAt: input.startedAt,
      },
    })
  );
  if (updated.count === 0) {
    const current = await withDb((db) =>
      db.branchDetail.findFirst({
        where: {
          artifactId: input.branchArtifactId,
          artifact: { organizationId: input.organizationId },
        },
        select: {
          lastSyncCompletedAt: true,
          lastSyncErrorCode: true,
          lastSyncStartedAt: true,
          syncStatus: true,
        },
      })
    );
    return (
      getSyncThrottle({
        lastSyncCompletedAt:
          current?.lastSyncCompletedAt ??
          input.currentLastSyncCompletedAt ??
          null,
        lastSyncErrorCode:
          current?.lastSyncErrorCode ?? input.currentLastSyncErrorCode ?? null,
        lastSyncStartedAt:
          current?.lastSyncStartedAt ?? input.currentLastSyncStartedAt,
        now: input.startedAt,
        syncStatus:
          parseBranchSyncStatus(current?.syncStatus) ??
          input.currentSyncStatus ??
          null,
        canBypassLocalDedupe: canBypassThrottle,
      }) ?? {
        throttled: true,
        retryAfterSeconds: 1,
        throttleReason: BranchViewSyncThrottleReason.InFlight,
      }
    );
  }
  return { throttled: false, fileCount: 0, patchBytes: 0 };
}

/**
 * Settle a successful branch sync attempt without overwriting a newer attempt
 * that may have superseded the acquired `startedAt` token.
 */
export async function markBranchSyncCompleted(input: {
  organizationId: string;
  branchArtifactId: string;
  completedAt: Date;
  startedAt: Date;
}): Promise<{ updated: boolean }> {
  const updated = await withDb((db) =>
    db.branchDetail.updateMany({
      where: {
        artifactId: input.branchArtifactId,
        artifact: { organizationId: input.organizationId },
        syncStatus: BranchSyncStatus.Syncing,
        lastSyncStartedAt: input.startedAt,
      },
      data: {
        syncStatus: BranchSyncStatus.Fresh,
        lastSyncCompletedAt: input.completedAt,
        lastSyncErrorCode: null,
        lastSyncErrorMessage: null,
      },
    })
  );
  return { updated: updated.count > 0 };
}

/**
 * Mark the full Branch View sync failed without overwriting file-cache fields.
 * When `startedAt` is supplied, settlement is scoped to that acquired attempt
 * so stale workers cannot overwrite a newer terminal sync outcome.
 */
export async function markBranchSyncFailed(input: {
  organizationId: string;
  branchArtifactId: string;
  code: string;
  message: string;
  completedAt: Date;
  startedAt?: Date;
}): Promise<{ updated: boolean }> {
  const updated = await withDb((db) =>
    db.branchDetail.updateMany({
      where: {
        artifactId: input.branchArtifactId,
        artifact: { organizationId: input.organizationId },
        ...(input.startedAt
          ? {
              syncStatus: BranchSyncStatus.Syncing,
              lastSyncStartedAt: input.startedAt,
            }
          : {}),
      },
      data: {
        syncStatus: BranchSyncStatus.Failed,
        ...(input.startedAt ? { lastSyncStartedAt: input.startedAt } : {}),
        lastSyncCompletedAt: input.completedAt,
        lastSyncErrorCode: input.code,
        lastSyncErrorMessage: input.message,
      },
    })
  );
  return { updated: updated.count > 0 };
}

/**
 * Settle a provider-throttled branch sync attempt without overwriting a newer
 * attempt that may have superseded the acquired `startedAt` token.
 */
export async function markBranchSyncProviderRateLimited(input: {
  organizationId: string;
  branchArtifactId: string;
  completedAt: Date;
  startedAt: Date;
}): Promise<{ updated: boolean }> {
  const updated = await withDb((db) =>
    db.branchDetail.updateMany({
      where: {
        artifactId: input.branchArtifactId,
        artifact: { organizationId: input.organizationId },
        syncStatus: BranchSyncStatus.Syncing,
        lastSyncStartedAt: input.startedAt,
      },
      data: {
        syncStatus: BranchSyncStatus.Failed,
        lastSyncCompletedAt: input.completedAt,
        lastSyncErrorCode: BranchViewSyncErrorCode.SyncThrottled,
        lastSyncErrorMessage: PROVIDER_RATE_LIMITED_SYNC_MESSAGE,
      },
    })
  );
  return { updated: updated.count > 0 };
}

function getSyncThrottle(input: {
  lastSyncCompletedAt: Date | null;
  lastSyncErrorCode: string | null;
  lastSyncStartedAt: Date | null;
  now: Date;
  syncStatus: BranchSyncStatus | null;
  canBypassLocalDedupe: boolean;
}): Extract<BranchSyncStartResult, { throttled: true }> | null {
  if (input.syncStatus === BranchSyncStatus.Syncing) {
    const retryAfterSeconds = computeRetryAfterSeconds(
      input.lastSyncStartedAt,
      input.now,
      BRANCH_VIEW_IN_FLIGHT_STALE_MS
    );
    return retryAfterSeconds > 0
      ? {
          throttled: true,
          retryAfterSeconds,
          throttleReason: BranchViewSyncThrottleReason.InFlight,
        }
      : null;
  }
  if (input.lastSyncErrorCode === BranchViewSyncErrorCode.SyncThrottled) {
    const retryAfterSeconds = computeRetryAfterSeconds(
      input.lastSyncCompletedAt ?? input.lastSyncStartedAt,
      input.now,
      BRANCH_VIEW_PROVIDER_RETRY_FALLBACK_SECONDS * 1000
    );
    return retryAfterSeconds > 0
      ? {
          throttled: true,
          retryAfterSeconds,
          throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
        }
      : null;
  }
  if (input.canBypassLocalDedupe) {
    return null;
  }
  const retryAfterSeconds = computeRetryAfterSeconds(
    input.lastSyncStartedAt,
    input.now,
    BRANCH_VIEW_LOCAL_DEDUPE_MS
  );
  return retryAfterSeconds > 0
    ? {
        throttled: true,
        retryAfterSeconds,
        throttleReason: BranchViewSyncThrottleReason.LocalDedupe,
      }
    : null;
}

function computeRetryAfterSeconds(
  lastSyncStartedAt: Date | null,
  now: Date,
  windowMs: number
): number {
  if (!lastSyncStartedAt) {
    return 0;
  }
  const elapsedMs = now.getTime() - lastSyncStartedAt.getTime();
  if (elapsedMs >= windowMs) {
    return 0;
  }
  return Math.max(1, Math.ceil((windowMs - elapsedMs) / 1000));
}

function canBypassRecentSyncForStaleCacheHead(input: {
  allowStaleCacheHeadBypass?: boolean;
  headSha: string | null;
  currentFileCacheHeadSha: string | null;
}): boolean {
  return Boolean(
    input.allowStaleCacheHeadBypass &&
      input.headSha &&
      input.currentFileCacheHeadSha !== input.headSha
  );
}
