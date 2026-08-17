import {
  BranchViewSyncErrorCode,
  BranchViewSyncFailureReason,
  BranchViewSyncScope,
} from "@repo/api/src/types/branch-view";
import { GitHubFetchTrigger } from "@repo/api/src/types/github-read-model";
import { withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  queryStatusCheckRollupWithProviderResult,
} from "@repo/github";
import type { Octokit } from "@repo/github/user-token-auth";
import { log } from "@repo/observability/log";
import { markBranchSyncFailed } from "@/app/branches/branch-sync-status";
import { persistBranchStatusChecksFromRollup } from "@/lib/branch-status-checks";
import { acquireInstallationClient } from "@/lib/github/installation-client";
import { githubAppGraphqlFetchProvenance } from "@/lib/github-fetch-provenance";
import {
  type PrLifecycleRefreshResult,
  prLifecycleFailureFromClientAcquisition,
  refreshPullRequestLifecycle,
} from "@/lib/pr-lifecycle-refresh";
import type { PrContext } from "@/lib/resolve-pr-context";

import {
  type BranchViewProviderThrottle,
  type BranchViewSyncFailure,
  providerThrottleFromRetry,
  type SyncResult,
} from "./sync-results";

/**
 * Resolve one installation client shared by the lifecycle refresh and the
 * checks rollup (PLN-1525: resolve once per operation, thread down). A mint
 * failure folds into the lifecycle result union so the sync path keeps its
 * errors-as-values contract instead of bubbling a route 500; the checks
 * refresh is skipped because no client exists to run it.
 */
export async function refreshLifecycleAndChecks(ctx: PrContext): Promise<{
  lifecycleFailure: ReturnType<typeof toLifecycleSyncFailure>;
  throttles: BranchViewProviderThrottle[];
}> {
  const throttles: BranchViewProviderThrottle[] = [];
  const acquired = await acquireInstallationClient(ctx.installationId);
  if (acquired.status !== GitHubProviderResultStatus.Success) {
    log.warn("[branch-view/sync] Installation client mint failed", {
      externalLinkId: ctx.externalLink.id,
      branchArtifactId: ctx.branch?.artifactId ?? null,
      status: acquired.status,
    });
    const clientFailure = prLifecycleFailureFromClientAcquisition(acquired);
    if (clientFailure.status === GitHubProviderResultStatus.ProviderRateLimit) {
      throttles.push(
        providerThrottleFromRetry(clientFailure.retryAfterSeconds)
      );
    }
    return {
      lifecycleFailure: toLifecycleSyncFailure(clientFailure),
      throttles,
    };
  }

  const lifecycleResult = await refreshPullRequestLifecycle({
    organizationId: ctx.externalLink.organizationId,
    octokit: acquired.value,
    owner: ctx.owner,
    repo: ctx.repo,
    pullNumber: ctx.pullNumber,
    branchArtifactId: ctx.branch?.artifactId ?? null,
    pullRequestDetailId: ctx.gitHubPullRequest?.id ?? null,
    repositoryId:
      ctx.gitHubPullRequest?.repositoryId ?? ctx.repositoryId ?? null,
    requireCurrentRelation: Boolean(ctx.gitHubPullRequest),
  });
  if (lifecycleResult.status === GitHubProviderResultStatus.ProviderRateLimit) {
    throttles.push(
      providerThrottleFromRetry(lifecycleResult.retryAfterSeconds)
    );
  }

  const lifecycleFailure = toLifecycleSyncFailure(lifecycleResult);
  if (!lifecycleFailure) {
    const checksThrottle = await refreshBranchChecksStatus(
      ctx,
      acquired.value,
      lifecycleResult.status === "refreshed" ? lifecycleResult.headSha : null
    );
    if (checksThrottle) {
      throttles.push(checksThrottle);
    }
  }
  return { lifecycleFailure, throttles };
}

async function refreshBranchChecksStatus(
  ctx: PrContext,
  octokit: Octokit,
  headShaOverride: string | null = null
): Promise<BranchViewProviderThrottle | null> {
  const branch = ctx.branch;
  const headSha = headShaOverride ?? branch?.headSha;
  if (!(branch && headSha)) {
    return null;
  }

  const rollupResult = await queryStatusCheckRollupWithProviderResult(
    octokit,
    ctx.owner,
    ctx.repo,
    headSha
  );
  if (rollupResult.status === GitHubProviderResultStatus.ProviderRateLimit) {
    return providerThrottleFromRetry(rollupResult.retryAfterSeconds);
  }
  if (rollupResult.status !== GitHubProviderResultStatus.Success) {
    return null;
  }

  const persistResult = await withDb.tx((tx) =>
    persistBranchStatusChecksFromRollup(tx, {
      branchArtifactId: branch.artifactId,
      organizationId: ctx.externalLink.organizationId,
      headSha,
      rollup: rollupResult.value,
      fetchProvenance: githubAppGraphqlFetchProvenance({
        trigger: GitHubFetchTrigger.SurfaceOpen,
      }),
    })
  );
  if (persistResult.status === "skipped") {
    log.warn("[branch-view/sync] Skipped stale checksStatus update", {
      externalLinkId: ctx.externalLink.id,
      branchArtifactId: branch.artifactId,
      headSha,
      reason: persistResult.reason,
    });
  }
  return null;
}

function toLifecycleSyncFailure(
  result: PrLifecycleRefreshResult
): BranchViewSyncFailure | null {
  if (
    result.status !== GitHubProviderResultStatus.ProviderUnavailable &&
    result.status !== "guarded_write_failed"
  ) {
    return null;
  }
  return {
    synced: false,
    error: result.message,
    code: result.code,
    httpStatus: result.httpStatus,
    details: result.details,
    scope: BranchViewSyncScope.Branch,
  };
}

export async function handleFileCacheFailure({
  ctx,
  error,
  lifecycleFailure,
  startedAt,
}: {
  ctx: PrContext;
  error: unknown;
  lifecycleFailure: BranchViewSyncFailure | null;
  startedAt: Date;
}): Promise<BranchViewSyncFailure | SyncResult> {
  if (lifecycleFailure) {
    await persistLifecycleFailure(ctx, lifecycleFailure, startedAt);
    log.warn("[branch-view/sync] File cache and lifecycle failed", {
      externalLinkId: ctx.externalLink.id,
      branchArtifactId: ctx.branch?.artifactId,
      status: error,
      lifecycleCode: lifecycleFailure.code,
    });
    return lifecycleFailure;
  }
  await markBranchSyncFailed({
    organizationId: ctx.externalLink.organizationId,
    branchArtifactId: ctx.branch!.artifactId,
    code: BranchViewSyncErrorCode.FileCacheRefreshFailed,
    message: "Failed to refresh branch file cache",
    completedAt: new Date(),
    startedAt,
  });
  return {
    synced: false,
    error: "Failed to refresh branch file cache",
    code: BranchViewSyncErrorCode.FileCacheRefreshFailed,
    httpStatus: 500,
    details: { reason: BranchViewSyncFailureReason.FileCacheRefreshFailed },
    scope: BranchViewSyncScope.Branch,
  };
}

export async function persistLifecycleFailure(
  ctx: PrContext,
  failure: BranchViewSyncFailure,
  startedAt: Date
): Promise<void> {
  if (!ctx.branch) {
    return;
  }
  await markBranchSyncFailed({
    organizationId: ctx.externalLink.organizationId,
    branchArtifactId: ctx.branch.artifactId,
    code: failure.code,
    message: failure.error,
    completedAt: new Date(),
    startedAt,
  });
}
