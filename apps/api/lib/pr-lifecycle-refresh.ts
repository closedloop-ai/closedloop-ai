import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import {
  BranchViewSyncErrorCode,
  BranchViewSyncFailureReason,
} from "@repo/api/src/types/branch-view";
import type { GitHubPRState } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  type getSinglePullRequest,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import { log } from "@repo/observability/log";
import { invalidateBranchStatusChecksForHeadChange } from "@/lib/branch-status-checks";

export type PrLifecycleRefreshResult =
  | { status: "not_applicable" }
  | {
      status: "refreshed";
      headSha: string;
      baseBranch: string;
      state: GitHubPRState;
      pullRequestDetailId: string;
    }
  | {
      status: typeof GitHubProviderResultStatus.ProviderRateLimit;
      retryAfterSeconds: number | null;
    }
  | {
      status: typeof GitHubProviderResultStatus.ProviderUnavailable;
      code: typeof BranchViewSyncErrorCode.PrLifecycleUnavailable;
      message: "Failed to refresh pull request lifecycle";
      httpStatus: 502;
      details: {
        reason: typeof BranchViewSyncFailureReason.GitHubPrUnavailable;
      };
    }
  | {
      status: "guarded_write_failed";
      code: typeof BranchViewSyncErrorCode.PrLifecycleGuardFailed;
      message: "Failed to apply pull request lifecycle refresh";
      httpStatus: 409;
      details: {
        reason: typeof BranchViewSyncFailureReason.GuardedWriteFailed;
      };
    };

export type GitHubPullRequestLifecycle = NonNullable<
  Awaited<ReturnType<typeof getSinglePullRequest>>
>;

type RefreshPullRequestLifecycleInput = {
  organizationId: string;
  installationId: string;
  owner: string;
  repo: string;
  pullNumber: number | null;
  branchArtifactId: string | null;
  pullRequestDetailId: string | null;
  repositoryId: string | null;
  requireCurrentRelation: boolean;
  artifactPatch?: {
    updateBranchIdentity?: boolean;
  };
};

class GuardedWriteFailed extends Error {}

/**
 * Refresh the current GitHub PR lifecycle and apply the provider-owned
 * projection to existing Artifact, BranchDetail, and PullRequestDetail rows.
 */
export async function refreshPullRequestLifecycle(
  input: RefreshPullRequestLifecycleInput
): Promise<PrLifecycleRefreshResult> {
  if (
    !(
      input.branchArtifactId &&
      input.pullRequestDetailId &&
      input.repositoryId &&
      input.pullNumber
    )
  ) {
    return { status: "not_applicable" };
  }

  const branchArtifactId = input.branchArtifactId;

  if (input.requireCurrentRelation) {
    const currentRelation = await withDb((db) =>
      db.branchDetail.count({ where: guardedBranchWhere(input) })
    );
    if (currentRelation === 0) {
      return guardedWriteFailed(input, "current_relation");
    }
  }

  const now = new Date();
  const stamp = await withDb((db) =>
    db.pullRequestDetail.updateMany({
      where: guardedPullRequestWhere(input),
      data: { lastRefreshAttemptAt: now },
    })
  );
  if (stamp.count === 0) {
    return guardedWriteFailed(input, "stamp");
  }

  const freshPrResult = await getSinglePullRequestWithProviderResult(
    input.installationId,
    input.owner,
    input.repo,
    input.pullNumber
  );
  if (freshPrResult.status === GitHubProviderResultStatus.ProviderRateLimit) {
    return {
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: freshPrResult.retryAfterSeconds,
    };
  }
  const freshPr =
    freshPrResult.status === GitHubProviderResultStatus.Success
      ? freshPrResult.value
      : null;
  if (!freshPr) {
    return {
      status: GitHubProviderResultStatus.ProviderUnavailable,
      code: BranchViewSyncErrorCode.PrLifecycleUnavailable,
      message: "Failed to refresh pull request lifecycle",
      httpStatus: 502,
      details: { reason: BranchViewSyncFailureReason.GitHubPrUnavailable },
    };
  }

  try {
    await withDb.tx(async (tx) => {
      const artifact = await tx.artifact.updateMany({
        where: {
          id: input.branchArtifactId!,
          organizationId: input.organizationId,
        },
        data: {
          status: freshPr.state,
          ...(input.artifactPatch?.updateBranchIdentity
            ? {
                name: freshPr.headBranch,
                externalUrl: buildBranchTreeUrl(
                  input.owner,
                  input.repo,
                  freshPr.headBranch
                ),
              }
            : {}),
        },
      });
      if (artifact.count === 0) {
        throw new GuardedWriteFailed("artifact");
      }

      const currentBranch = await tx.branchDetail.findFirst({
        where: guardedBranchWhere(input),
        select: { headSha: true },
      });
      const branch = await tx.branchDetail.updateMany({
        where: guardedBranchWhere(input),
        data: {
          ...(input.artifactPatch?.updateBranchIdentity
            ? { branchName: freshPr.headBranch }
            : {}),
          baseBranch: freshPr.baseBranch,
          baseBranchSource: BranchBaseBranchSource.PullRequestBase,
          headSha: freshPr.headSha,
          headShaSource: BranchHeadShaSource.PullRequestWebhook,
          headShaObservedAt: now,
          lastPushBeforeSha: null,
        },
      });
      if (branch.count === 0) {
        throw new GuardedWriteFailed("branch");
      }
      if (currentBranch?.headSha !== freshPr.headSha) {
        await invalidateBranchStatusChecksForHeadChange(tx, branchArtifactId);
      }

      const detail = await tx.pullRequestDetail.updateMany({
        where: guardedPullRequestWhere(input),
        data: pullRequestLifecycleData(freshPr, now),
      });
      if (detail.count === 0) {
        throw new GuardedWriteFailed("pull_request_detail");
      }
    });
  } catch (error) {
    if (error instanceof GuardedWriteFailed) {
      return guardedWriteFailed(input, error.message);
    }
    throw error;
  }

  return {
    status: "refreshed",
    headSha: freshPr.headSha,
    baseBranch: freshPr.baseBranch,
    state: freshPr.state,
    pullRequestDetailId: input.pullRequestDetailId,
  };
}

export function buildBranchTreeUrl(
  owner: string,
  repo: string,
  branchName: string
) {
  return `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(
    branchName
  )}`;
}

function pullRequestLifecycleData(
  freshPr: GitHubPullRequestLifecycle,
  now: Date
) {
  return {
    number: freshPr.number,
    githubId: freshPr.githubId,
    title: freshPr.title,
    htmlUrl: freshPr.htmlUrl,
    prState: freshPr.state,
    isDraft: freshPr.isDraft,
    closedAt: freshPr.closedAt ? new Date(freshPr.closedAt) : null,
    mergedAt: freshPr.mergedAt ? new Date(freshPr.mergedAt) : null,
    mergeCommitSha: freshPr.mergeCommitSha,
    lastVerifiedAt: now,
  };
}

function guardedPullRequestWhere(input: RefreshPullRequestLifecycleInput) {
  return {
    id: input.pullRequestDetailId!,
    branchArtifactId: input.branchArtifactId!,
    repositoryId: input.repositoryId!,
    branchArtifact: { organizationId: input.organizationId },
    repository: {
      installation: { organizationId: input.organizationId },
    },
    ...(input.requireCurrentRelation
      ? { currentForBranches: { some: guardedBranchWhere(input) } }
      : {}),
  };
}

function guardedBranchWhere(input: RefreshPullRequestLifecycleInput) {
  return {
    artifactId: input.branchArtifactId!,
    repositoryId: input.repositoryId!,
    artifact: { organizationId: input.organizationId },
    repository: {
      installation: { organizationId: input.organizationId },
    },
    ...(input.requireCurrentRelation
      ? { currentPullRequestDetailId: input.pullRequestDetailId! }
      : {}),
  };
}

function guardedWriteFailed(
  input: RefreshPullRequestLifecycleInput,
  stage: string
): PrLifecycleRefreshResult {
  log.warn("[pr-lifecycle-refresh] Guarded lifecycle write failed", {
    branchArtifactId: input.branchArtifactId,
    pullRequestDetailId: input.pullRequestDetailId,
    repositoryId: input.repositoryId,
    stage,
    reason: BranchViewSyncFailureReason.GuardedWriteFailed,
  });
  return {
    status: "guarded_write_failed",
    code: BranchViewSyncErrorCode.PrLifecycleGuardFailed,
    message: "Failed to apply pull request lifecycle refresh",
    httpStatus: 409,
    details: { reason: BranchViewSyncFailureReason.GuardedWriteFailed },
  };
}
