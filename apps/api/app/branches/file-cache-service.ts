import {
  BranchFileCacheStatus,
  BranchSyncStatus,
} from "@repo/api/src/types/artifact";
import {
  BRANCH_VIEW_PROVIDER_RETRY_FALLBACK_SECONDS,
  BranchViewFileCacheSyncErrorCode,
  BranchViewSyncThrottleReason,
} from "@repo/api/src/types/branch-view";
import { Result, Status } from "@repo/api/src/types/result";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import {
  compareBranchFileChangesWithProviderResult,
  GITHUB_COMPARE_FILE_LIMIT,
  type GitHubChangedFile,
  GitHubProviderResultStatus,
} from "@repo/github";
import { log } from "@repo/observability/log";
import { readWithInstallationClient } from "@/lib/github/installation-client";
import { branchFileChangePersistenceCap } from "./branch-file-change-read-bounds";
import {
  markBranchSyncCompleted,
  markBranchSyncFailed,
  markBranchSyncProviderRateLimited,
  parseBranchSyncStatus,
  startBranchSync,
} from "./branch-sync-status";

const MAX_PATCH_BYTES = 64 * 1024;
const MAX_TOTAL_PATCH_BYTES = 2 * 1024 * 1024;

export type RefreshBranchFileChangeCacheResult =
  | { throttled: false; fileCount: number; patchBytes: number }
  | {
      throttled: true;
      retryAfterSeconds: number;
      throttleReason: BranchViewSyncThrottleReason;
    };

type PreparedFileChange = {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
  changes: number | null;
  patch: string | null;
  patchBytes: number;
  patchOmittedReason: string | null;
  isBinary: boolean;
};

/**
 * Refresh the bounded branch file-change cache for an already-materialized
 * branch. Existing cached rows are replaced only after GitHub returns an
 * accepted compare result; failure states preserve the previous cache.
 */
export async function refreshBranchFileChangeCache(
  branchArtifactId: string,
  options: { organizationId: string; syncAlreadyStarted?: boolean }
): Promise<Result<RefreshBranchFileChangeCacheResult>> {
  // ISS-6127: the persist bound is the PROVIDER's limit, not a second number.
  // This was its own 500 — unreachable for the same reason the compare helper's
  // was, and a second phantom threshold is how the first one went unnoticed.
  // ISS-8480: checked per refresh rather than at module scope, so a provider
  // limit that outruns the bounded reads fails THIS refresh instead of refusing
  // to load the module — `route.ts` imports it statically for every GitHub event
  // type, and a cap mismatch has nothing to do with a `check_run` payload. And
  // checked FIRST, before the sync token is acquired and before any provider or
  // write work: this refusal has no per-branch failure to record, so settling it
  // through `markCacheRefreshFailed` would stamp `Failed` over a real cache's
  // status for a build-time misconfiguration, and throwing after
  // `startBranchSync` would strand the branch in `Syncing` for the full
  // BRANCH_VIEW_IN_FLIGHT_STALE_MS lease with nothing settling it.
  const maxFileChanges = branchFileChangePersistenceCap(
    GITHUB_COMPARE_FILE_LIMIT
  );
  const startedAt = new Date();
  const branch = await withDb((db) =>
    db.branchDetail.findFirst({
      where: {
        artifactId: branchArtifactId,
        artifact: { organizationId: options.organizationId },
        repository: {
          removedAt: null,
          installation: {
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
      },
      select: {
        artifactId: true,
        baseBranch: true,
        headSha: true,
        fileCacheHeadSha: true,
        lastSyncCompletedAt: true,
        lastSyncErrorCode: true,
        lastSyncStartedAt: true,
        syncStatus: true,
        repository: {
          select: {
            owner: true,
            name: true,
            installation: { select: { installationId: true, status: true } },
          },
        },
      },
    })
  );

  if (!branch) {
    return Result.err(Status.NotFound);
  }
  // Non-App branch (PRD-510 D2/FR8): no installation-repo, so there is no GitHub
  // compare source to refresh the file-change cache from. Treat as not found.
  // (The query's `repository` relation filter already excludes these branches;
  // this guard also narrows the optional relation for the compare call below.)
  const repository = branch.repository;
  if (!repository) {
    return Result.err(Status.NotFound);
  }
  if (!(branch.baseBranch && branch.headSha)) {
    const failedAt = new Date();
    await markCacheRefreshFailed(
      options.organizationId,
      branchArtifactId,
      BranchViewFileCacheSyncErrorCode.MissingCompareRefs,
      "Branch cache refresh requires both baseBranch and headSha.",
      {
        completedAt: failedAt,
        settleBranchSync: !options.syncAlreadyStarted,
        startedAt: failedAt,
      }
    );
    return Result.err(Status.BadRequest);
  }
  const baseBranch = branch.baseBranch;
  const headSha = branch.headSha;
  let locallyAcquiredStartedAt: Date | null = null;

  if (!options.syncAlreadyStarted) {
    const syncStart = await startBranchSync({
      branchArtifactId,
      organizationId: options.organizationId,
      headSha,
      currentFileCacheHeadSha: branch.fileCacheHeadSha,
      currentLastSyncStartedAt: branch.lastSyncStartedAt,
      currentLastSyncCompletedAt: branch.lastSyncCompletedAt,
      currentLastSyncErrorCode: branch.lastSyncErrorCode,
      currentSyncStatus: parseBranchSyncStatus(branch.syncStatus),
      startedAt,
      allowStaleCacheHeadBypass: true,
    });
    if (syncStart.throttled) {
      return Result.ok(syncStart);
    }
    locallyAcquiredStartedAt = startedAt;
  }

  // A failed client acquisition classifies as the same provider result the
  // compare read would produce, so cache refresh always settles (throttle or
  // marked failure) instead of rejecting.
  const filesResult = await readWithInstallationClient(
    repository.installation.installationId,
    (octokit) =>
      compareBranchFileChangesWithProviderResult(
        octokit,
        repository.owner,
        repository.name,
        baseBranch,
        headSha
      )
  );

  if (filesResult.status === GitHubProviderResultStatus.ProviderRateLimit) {
    if (locallyAcquiredStartedAt) {
      await markBranchSyncProviderRateLimited({
        organizationId: options.organizationId,
        branchArtifactId,
        completedAt: new Date(),
        startedAt: locallyAcquiredStartedAt,
      });
    }
    return Result.ok({
      throttled: true,
      retryAfterSeconds:
        filesResult.retryAfterSeconds ??
        BRANCH_VIEW_PROVIDER_RETRY_FALLBACK_SECONDS,
      throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
    });
  }
  const compared =
    filesResult.status === GitHubProviderResultStatus.Success
      ? filesResult.value
      : null;
  if (!compared) {
    await markCacheRefreshFailed(
      options.organizationId,
      branchArtifactId,
      BranchViewFileCacheSyncErrorCode.CompareFailed,
      "GitHub compare failed while refreshing branch file cache.",
      {
        completedAt: new Date(),
        settleBranchSync: !options.syncAlreadyStarted,
        branchSyncStartedAt: locallyAcquiredStartedAt ?? undefined,
      }
    );
    return Result.err(Status.Error);
  }

  const prepared = await persistBranchFileChangeCache({
    organizationId: options.organizationId,
    branchArtifactId,
    headSha,
    files: compared.files,
    capped: compared.capped,
    maxFileChanges,
  });
  if (locallyAcquiredStartedAt) {
    await markBranchSyncCompleted({
      organizationId: options.organizationId,
      branchArtifactId,
      completedAt: new Date(),
      startedAt: locallyAcquiredStartedAt,
    });
  }

  return Result.ok({
    throttled: false,
    fileCount: prepared.fileCount,
    patchBytes: prepared.patchBytes,
  });
}

async function markCacheRefreshFailed(
  organizationId: string,
  branchArtifactId: string,
  code: string,
  message: string,
  timestamps: {
    completedAt: Date;
    settleBranchSync?: boolean;
    startedAt?: Date;
    branchSyncStartedAt?: Date;
  }
) {
  const settleBranchSync = timestamps.settleBranchSync ?? true;
  const settleBranchSyncBroadly =
    settleBranchSync && !timestamps.branchSyncStartedAt;
  await withDb((db) =>
    db.branchDetail.updateMany({
      where: {
        artifactId: branchArtifactId,
        artifact: { organizationId },
      },
      data: {
        fileCacheStatus: BranchFileCacheStatus.Failed,
        ...(settleBranchSyncBroadly
          ? { syncStatus: BranchSyncStatus.Failed }
          : {}),
        ...(settleBranchSyncBroadly && timestamps.startedAt
          ? { lastSyncStartedAt: timestamps.startedAt }
          : {}),
        ...(settleBranchSyncBroadly
          ? { lastSyncCompletedAt: timestamps.completedAt }
          : {}),
        ...(settleBranchSyncBroadly
          ? {
              lastSyncErrorCode: code,
              lastSyncErrorMessage: message,
            }
          : {}),
      },
    })
  );
  if (settleBranchSync && timestamps.branchSyncStartedAt) {
    await markBranchSyncFailed({
      organizationId,
      branchArtifactId,
      code,
      message,
      completedAt: timestamps.completedAt,
      startedAt: timestamps.branchSyncStartedAt,
    });
  }
  log.warn("[branch-file-cache] Refresh failed", {
    branchArtifactId,
    code,
  });
}

function prepareFileChanges(
  files: GitHubChangedFile[],
  maxFileChanges: number
): {
  rows: PreparedFileChange[];
  patchBytes: number;
} {
  let totalPatchBytes = 0;
  const rows = files.slice(0, maxFileChanges).map((file) => {
    const patch = preparePatch(file.patch, totalPatchBytes);
    totalPatchBytes += patch.patchBytes;
    return {
      path: file.filename,
      previousPath: file.previousFilename ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: patch.patch,
      patchBytes: patch.patchBytes,
      patchOmittedReason: patch.patchOmittedReason,
      isBinary: false,
    };
  });

  return { rows, patchBytes: totalPatchBytes };
}

function preparePatch(
  patch: string | undefined,
  currentTotalPatchBytes: number
): {
  patch: string | null;
  patchBytes: number;
  patchOmittedReason: string | null;
} {
  if (!patch) {
    return {
      patch: null,
      patchBytes: 0,
      patchOmittedReason: "patch_unavailable",
    };
  }

  const patchBytes = Buffer.byteLength(patch, "utf8");
  if (patchBytes > MAX_PATCH_BYTES) {
    return {
      patch: null,
      patchBytes: 0,
      patchOmittedReason: "patch_too_large",
    };
  }
  if (currentTotalPatchBytes + patchBytes > MAX_TOTAL_PATCH_BYTES) {
    return {
      patch: null,
      patchBytes: 0,
      patchOmittedReason: "total_patch_budget_exceeded",
    };
  }

  return { patch, patchBytes, patchOmittedReason: null };
}

/**
 * Replace a branch's file-change cache with one compare result for `headSha`
 * and mark the cache fresh. The write half of `refreshBranchFileChangeCache`,
 * for a caller that already holds compare-shaped files.
 */
export async function persistBranchFileChangeCache(input: {
  organizationId: string;
  branchArtifactId: string;
  headSha: string;
  files: GitHubChangedFile[];
  capped: boolean;
  maxFileChanges: number;
}): Promise<{ fileCount: number; patchBytes: number }> {
  const { organizationId, branchArtifactId, headSha } = input;
  const prepared = prepareFileChanges(input.files, input.maxFileChanges);
  await withDb.tx(async (tx) => {
    await tx.branchFileChange.deleteMany({
      where: {
        branchArtifactId,
        branch: {
          artifact: { organizationId },
        },
      },
    });
    if (prepared.rows.length > 0) {
      await tx.branchFileChange.createMany({
        data: prepared.rows.map((file) => ({
          branchArtifactId,
          headSha,
          path: file.path,
          previousPath: file.previousPath,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: file.patch,
          patchBytes: file.patchBytes,
          patchOmittedReason: file.patchOmittedReason,
          isBinary: file.isBinary,
        })),
      });
    }
    await tx.branchDetail.updateMany({
      where: {
        artifactId: branchArtifactId,
        artifact: { organizationId },
      },
      data: {
        fileCacheStatus: BranchFileCacheStatus.Fresh,
        fileCacheHeadSha: headSha,
        fileCacheFileCount: prepared.rows.length,
        // ISS-6127: the provider's own completeness verdict, stored beside
        // freshness rather than folded into it. `Fresh` stays true of a capped
        // read — it WAS fetched, at this head SHA — so the two facts need two
        // fields. Reading it back off `fileCacheFileCount` is what the old code
        // effectively did, and `>= cap` stops being knowable the moment the cap
        // moves.
        fileCacheCapped: input.capped,
        fileCachePatchBytes: prepared.patchBytes,
        fileCacheUpdatedAt: new Date(),
      },
    });
  });
  return { fileCount: prepared.rows.length, patchBytes: prepared.patchBytes };
}
