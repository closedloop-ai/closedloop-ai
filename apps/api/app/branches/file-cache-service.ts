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
  type GitHubChangedFile,
  GitHubProviderResultStatus,
} from "@repo/github";
import { log } from "@repo/observability/log";
import {
  markBranchSyncCompleted,
  markBranchSyncFailed,
  markBranchSyncProviderRateLimited,
  parseBranchSyncStatus,
  startBranchSync,
} from "./branch-sync-status";

const MAX_FILE_CHANGES = 500;
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

  const filesResult = await compareBranchFileChangesWithProviderResult(
    repository.installation.installationId,
    repository.owner,
    repository.name,
    baseBranch,
    headSha
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
  const files =
    filesResult.status === GitHubProviderResultStatus.Success
      ? filesResult.value
      : null;
  if (!files) {
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

  const prepared = prepareFileChanges(files);
  await withDb.tx(async (tx) => {
    await tx.branchFileChange.deleteMany({
      where: {
        branchArtifactId,
        branch: {
          artifact: { organizationId: options.organizationId },
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
        artifact: { organizationId: options.organizationId },
      },
      data: {
        fileCacheStatus: BranchFileCacheStatus.Fresh,
        fileCacheHeadSha: headSha,
        fileCacheFileCount: prepared.rows.length,
        fileCachePatchBytes: prepared.patchBytes,
        fileCacheUpdatedAt: new Date(),
      },
    });
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
    fileCount: prepared.rows.length,
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

function prepareFileChanges(files: GitHubChangedFile[]): {
  rows: PreparedFileChange[];
  patchBytes: number;
} {
  let totalPatchBytes = 0;
  const rows = files.slice(0, MAX_FILE_CHANGES).map((file) => {
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
