import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import {
  BranchViewSyncErrorCode,
  BranchViewSyncFailureReason,
} from "@repo/api/src/types/branch-view";
import type { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  type GitHubFetchTrigger,
  GitHubFetchTrigger as GitHubFetchTriggerValue,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
  type getSinglePullRequest,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import type { Octokit } from "@repo/github/user-token-auth";
import { log } from "@repo/observability/log";
import {
  createPullRequestRestAuthorityProvenance,
  persistPullRequestProviderFailure,
  toPullRequestRestAuthorityObservation,
} from "@/app/branches/pull-request-authority-producer";
import {
  persistPullRequestHeadRepositoryAuthority,
  pullRequestHeadRepositoryObservation,
} from "@/app/branches/pull-request-head-authority";
import { pullRequestLocData } from "@/app/branches/pull-request-loc-data";
import { invalidateBranchStatusChecksForHeadChange } from "@/lib/branch-status-checks";
import {
  gitHubFetchProvenanceData,
  githubAppRestFetchProvenance,
} from "@/lib/github-fetch-provenance";

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

/** The rows a refresh targets, independent of which client reads GitHub. */
export type PrLifecycleRefreshTarget = {
  organizationId: string;
  owner: string;
  repo: string;
  pullNumber: number | null;
  branchArtifactId: string | null;
  pullRequestDetailId: string | null;
  repositoryId: string | null;
  requireCurrentRelation: boolean;
  fetchTrigger?: GitHubFetchTrigger;
  artifactPatch?: {
    updateBranchIdentity?: boolean;
  };
};

type RefreshPullRequestLifecycleInput = PrLifecycleRefreshTarget & {
  /** The caller's GitHub client (PLN-1525: resolved once per operation). */
  octokit: Octokit;
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
  const now = new Date();
  const attemptProvenance = githubAppRestFetchProvenance({
    observedAt: now,
    resultReason: GitHubSyncResultReason.Unknown,
    trigger: input.fetchTrigger,
  });
  const successProvenance = githubAppRestFetchProvenance({
    observedAt: now,
    trigger: input.fetchTrigger,
  });

  if (input.requireCurrentRelation) {
    const currentRelation = await withDb((db) =>
      db.branchDetail.count({ where: guardedBranchWhere(input) })
    );
    if (currentRelation === 0) {
      return guardedWriteFailed(input, "current_relation");
    }
  }

  const stamp = await withDb((db) =>
    db.pullRequestDetail.updateMany({
      where: guardedPullRequestWhere(input),
      data: {
        lastRefreshAttemptAt: now,
        ...gitHubFetchProvenanceData(attemptProvenance),
      },
    })
  );
  if (stamp.count === 0) {
    return guardedWriteFailed(input, "stamp");
  }

  const authorityProvenance = createPullRequestRestAuthorityProvenance({
    trigger: input.fetchTrigger ?? GitHubFetchTriggerValue.Backfill,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observedAt: now,
  });
  const freshPrResult = await getSinglePullRequestWithProviderResult(
    input.octokit,
    input.owner,
    input.repo,
    input.pullNumber,
    toPullRequestRestAuthorityObservation(authorityProvenance)
  );
  if (freshPrResult.status === GitHubProviderResultStatus.ProviderRateLimit) {
    await persistLifecycleFailureAuthority(
      input,
      freshPrResult,
      authorityProvenance
    );
    await stampRefreshResultReason(
      input,
      GitHubSyncResultReason.ProviderUnavailable
    );
    return {
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: freshPrResult.retryAfterSeconds,
    };
  }
  if (freshPrResult.status !== GitHubProviderResultStatus.Success) {
    await persistLifecycleFailureAuthority(
      input,
      freshPrResult,
      authorityProvenance
    );
    await stampRefreshResultReason(
      input,
      GitHubSyncResultReason.ProviderUnavailable
    );
    return {
      status: GitHubProviderResultStatus.ProviderUnavailable,
      code: BranchViewSyncErrorCode.PrLifecycleUnavailable,
      message: "Failed to refresh pull request lifecycle",
      httpStatus: 502,
      details: { reason: BranchViewSyncFailureReason.GitHubPrUnavailable },
    };
  }
  const freshPr = freshPrResult.value;

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
          ...gitHubFetchProvenanceData(successProvenance),
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
        data: {
          ...pullRequestLifecycleData(freshPr, now),
          ...gitHubFetchProvenanceData(successProvenance),
        },
      });
      if (detail.count === 0) {
        throw new GuardedWriteFailed("pull_request_detail");
      }
      await persistPullRequestHeadRepositoryAuthority(
        tx,
        {
          organizationId: input.organizationId,
          pullRequestDetailId: input.pullRequestDetailId!,
        },
        pullRequestHeadRepositoryObservation(freshPr)
      );
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

async function persistLifecycleFailureAuthority(
  input: RefreshPullRequestLifecycleInput,
  result: Parameters<typeof persistPullRequestProviderFailure>[2],
  provenance: Parameters<typeof persistPullRequestProviderFailure>[3]
): Promise<void> {
  if (!input.pullRequestDetailId) {
    return;
  }
  await withDb((db) =>
    persistPullRequestProviderFailure(
      db,
      {
        organizationId: input.organizationId,
        pullRequestDetailId: input.pullRequestDetailId!,
      },
      result,
      provenance
    )
  );
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
    ...pullRequestLocData(freshPr),
    lastVerifiedAt: now,
  };
}

function guardedPullRequestWhere(input: PrLifecycleRefreshTarget) {
  return {
    id: input.pullRequestDetailId!,
    branchArtifactId: input.branchArtifactId!,
    repositoryId: input.repositoryId!,
    branchArtifact: { organizationId: input.organizationId },
    repository: {
      removedAt: null,
      installation: {
        organizationId: input.organizationId,
        status: GitHubInstallationStatus.ACTIVE,
      },
    },
    ...(input.requireCurrentRelation
      ? { currentForBranches: { some: guardedBranchWhere(input) } }
      : {}),
  };
}

function guardedBranchWhere(input: PrLifecycleRefreshTarget) {
  return {
    artifactId: input.branchArtifactId!,
    repositoryId: input.repositoryId!,
    artifact: { organizationId: input.organizationId },
    repository: {
      removedAt: null,
      installation: {
        organizationId: input.organizationId,
        status: GitHubInstallationStatus.ACTIVE,
      },
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

async function stampRefreshResultReason(
  input: RefreshPullRequestLifecycleInput,
  resultReason: GitHubSyncResultReason
): Promise<void> {
  await withDb((db) =>
    db.pullRequestDetail.updateMany({
      where: guardedPullRequestWhere(input),
      data: gitHubFetchProvenanceData(
        githubAppRestFetchProvenance({
          resultReason,
          trigger: input.fetchTrigger,
        })
      ),
    })
  );
}

/**
 * Record a refresh attempt that never reached GitHub because the caller could
 * not resolve a client. `lastRefreshAttemptAt` is the read-repair debounce key
 * (`isPrReadRepairEligible`), so a caller that resolves its own client and
 * skips this stamp leaves the row looking un-attempted and every later read
 * reschedules the same repair.
 */
export async function stampPrLifecycleRefreshAttemptFailure(
  target: PrLifecycleRefreshTarget
): Promise<void> {
  if (
    !(
      target.branchArtifactId &&
      target.pullRequestDetailId &&
      target.repositoryId
    )
  ) {
    return;
  }
  const now = new Date();
  await withDb((db) =>
    db.pullRequestDetail.updateMany({
      where: guardedPullRequestWhere(target),
      data: {
        lastRefreshAttemptAt: now,
        ...gitHubFetchProvenanceData(
          githubAppRestFetchProvenance({
            observedAt: now,
            resultReason: GitHubSyncResultReason.ProviderUnavailable,
            trigger: target.fetchTrigger,
          })
        ),
      },
    })
  );
}

/**
 * Report a failed installation-client acquisition as the same result member
 * `refreshPullRequestLifecycle` produces for a failed provider read, so a
 * caller that resolves its own client handles both identically. The rate-limit
 * member passes through to preserve its retry window, and no refresh-attempt
 * provenance is stamped because GitHub was never reached.
 */
export function prLifecycleFailureFromClientAcquisition(
  acquired: Exclude<
    GitHubProviderResult<unknown>,
    { status: typeof GitHubProviderResultStatus.Success }
  >
): PrLifecycleRefreshResult {
  if (acquired.status === GitHubProviderResultStatus.ProviderRateLimit) {
    return acquired;
  }
  return {
    status: GitHubProviderResultStatus.ProviderUnavailable,
    code: BranchViewSyncErrorCode.PrLifecycleUnavailable,
    message: "Failed to refresh pull request lifecycle",
    httpStatus: 502,
    details: { reason: BranchViewSyncFailureReason.GitHubPrUnavailable },
  };
}
