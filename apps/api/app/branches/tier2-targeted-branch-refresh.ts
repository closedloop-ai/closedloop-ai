import { randomUUID } from "node:crypto";
import {
  BranchRefreshReason,
  type BranchRefreshResponse,
  BranchRefreshStatus,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import { parseRepositoryFullName } from "@repo/api/src/types/branch-repository";
import {
  GitHubAccessDenialReason,
  type GitHubCredentialKind,
} from "@repo/api/src/types/github";
import {
  type GitHubBundledPullRequestsObservation,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  type RepositoryDefaultProvenance,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { withDb } from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import type { GitHubProviderResult } from "@repo/github/provider-result";
import {
  type GitHubPullRequestsByNumberResult,
  getRepositoryPullRequestsByNumberWithProviderResult,
} from "@repo/github/pull-request-point-read";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  isPullRequestCurrentOwnerChangedError,
  promoteBranchCurrentPullRequest,
} from "@/app/branches/pull-request-current-promotion";
import { RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS } from "@/app/cron/reconcile-pull-requests/constants";
import {
  writeReconciledPullRequest,
  writeReconciledPullRequestFailures,
} from "@/app/cron/reconcile-pull-requests/reconcile-projection-write";
import { selectSessionLinkedPullRequestTargets } from "@/app/cron/reconcile-pull-requests/session-linked-targets";
import type { GitHubAccessError } from "@/lib/github/github-access";
import {
  recordSyncClientNoAccessIfRepoDenied,
  recordSyncClientRateLimits,
  recordSyncClientRepoReached,
} from "@/lib/github/github-sync-client-feedback";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { fetchCredentialTypeFromKind } from "@/lib/github-fetch-provenance";
import type { BranchDetailArtifactRow } from "./branch-read-service/persisted-row-read";
import {
  BRANCH_REFRESH_RETRY_AFTER_SECONDS,
  consumeRefreshBudget,
  type RefreshActor,
} from "./branch-refresh-support";
import { getOwnedCurrentPullRequestDetail } from "./branch-remote-evidence";

const TIER2_ON_READ_REFRESH_STALE_MS = 15 * 60 * 1000;
const TIER2_ON_READ_UNVERIFIED_ATTEMPT_DEBOUNCE_MS =
  RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS;

export type Tier2TargetedBranchRefreshOutcome = {
  status: BranchRefreshStatus;
  reason?: BranchRefreshReason;
  retryAfterSeconds?: number;
  shouldReloadBranch: boolean;
};

type Tier2TargetedPullRequestDetail = {
  id: string;
  branchArtifactId: string;
  repositoryId: string | null;
  repositoryFullName?: string | null;
  repository?: { fullName: string } | null;
  isCurrent: boolean;
  number: number;
  lastVerifiedAt: Date | null;
  lastRefreshAttemptAt: Date | null;
};

type Tier2BranchPullRequestOnReadOptions = {
  actor?: RefreshActor;
  promoteCurrent?: boolean;
  pullRequestDetail?: Tier2TargetedPullRequestDetail | null;
};

/**
 * PRD-683 P2-B: refresh one repo-less, session-linked PR through the P0-A
 * point-read/write/promote path. It never enumerates repository history.
 */
export async function refreshTier2TargetedBranchPullRequest(input: {
  organizationId: string;
  target: BranchDetailArtifactRow;
  pullRequestDetail?: Tier2TargetedPullRequestDetail | null;
  pullRequestDetailId: string;
  pullRequestNumber: number;
  now: Date;
  trigger: GitHubFetchTrigger;
  attemptDebounceMs?: number;
  promoteCurrent?: boolean;
}): Promise<Tier2TargetedBranchRefreshOutcome> {
  const repository = resolveTier2Repository(
    input.target,
    input.pullRequestDetail
  );
  if (!repository) {
    return nonRefreshableOutcome();
  }

  const [sessionLinkedTarget] = await selectSessionLinkedPullRequestTargets({
    organizationId: input.organizationId,
    repositoryId: null,
    repositoryFullName: repository.repositoryFullName,
    branchArtifactId: input.target.id,
    pullRequestDetailId: input.pullRequestDetailId,
    ignoreAttemptDebounce: true,
    limit: 1,
    now: input.now,
  });
  if (sessionLinkedTarget?.number !== input.pullRequestNumber) {
    return nonRefreshableOutcome();
  }

  const clientResult = await getGitHubSyncClient(
    {
      organizationId: input.organizationId,
      target: { owner: repository.owner, repo: repository.repo },
    },
    { now: input.now }
  );
  if (!clientResult.ok) {
    return accessDenialOutcome(clientResult.error);
  }

  const attemptDebounceMs =
    input.attemptDebounceMs ?? BRANCH_REFRESH_RETRY_AFTER_SECONDS * 1000;
  const claimed = await claimTier2PullRequestRefresh({
    organizationId: input.organizationId,
    branchArtifactId: input.target.id,
    pullRequestDetailId: input.pullRequestDetailId,
    repositoryFullName: repository.repositoryFullName,
    now: input.now,
    attemptDebounceMs,
  });
  if (!claimed) {
    return {
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.AlreadyRefreshing,
      retryAfterSeconds: Math.ceil(attemptDebounceMs / 1000),
      shouldReloadBranch: false,
    };
  }

  const client = clientResult.value;
  const observations: GitHubBundledPullRequestsObservation[] = [];
  const provenance = createPullRequestGraphqlProvenance({
    clientKind: client.kind,
    credentialOwnerId: client.credentialOwnerId,
    now: input.now,
    trigger: input.trigger,
  });
  const providerResult =
    await getRepositoryPullRequestsByNumberWithProviderResult(
      client.octokit,
      repository.owner,
      repository.repo,
      [input.pullRequestNumber],
      (observation) => observations.push(observation),
      {
        mechanism: provenance.mechanism,
        trigger: provenance.trigger,
        credentialType: provenance.credentialType,
        ...(provenance.credentialOwnerId
          ? { credentialOwnerId: provenance.credentialOwnerId }
          : {}),
        observationKey: provenance.observationKey,
        observedAt: provenance.observedAt,
      }
    );
  await recordSyncClientRateLimits(client, observations, {
    logPrefix: "[branches/tier2-targeted-refresh]",
    organizationId: input.organizationId,
    repositoryFullName: repository.repositoryFullName,
  });

  if (providerResult.status !== GitHubProviderResultStatus.Success) {
    await recordSyncClientNoAccessIfRepoDenied(client, providerResult.status, {
      logPrefix: "[branches/tier2-targeted-refresh]",
      organizationId: input.organizationId,
      repositoryFullName: repository.repositoryFullName,
    });
    await writeReconciledPullRequestFailures({
      organizationId: input.organizationId,
      repositoryId: null,
      repositoryFullName: repository.repositoryFullName,
      pullRequestNumbers: [input.pullRequestNumber],
      result: providerResult,
      provenance,
    });
    return providerFailureOutcome(providerResult);
  }

  await recordSyncClientRepoReached(client, {
    logPrefix: "[branches/tier2-targeted-refresh]",
    organizationId: input.organizationId,
    repositoryFullName: repository.repositoryFullName,
  });
  const pullRequest = providerResult.value.pullRequests.find(
    (candidate) => candidate.number === input.pullRequestNumber
  );
  if (!pullRequest) {
    return {
      status: BranchRefreshStatus.Stale,
      shouldReloadBranch: true,
    };
  }

  const wrote = await writeReconciledPullRequest(pullRequest, {
    organizationId: input.organizationId,
    repositoryId: null,
    repositoryFullName: repository.repositoryFullName,
    credentialKind: client.kind,
    credentialOwnerId: client.credentialOwnerId,
    fetchTrigger: input.trigger,
    now: input.now,
  });
  if (!wrote) {
    return {
      status: BranchRefreshStatus.Stale,
      shouldReloadBranch: true,
    };
  }

  if (input.promoteCurrent === false) {
    return { status: BranchRefreshStatus.Refreshed, shouldReloadBranch: true };
  }

  const promoted = await promoteTier2TargetedPullRequest({
    organizationId: input.organizationId,
    branchArtifactId: input.target.id,
    pullRequestDetailId: input.pullRequestDetailId,
  });
  return promoted
    ? { status: BranchRefreshStatus.Refreshed, shouldReloadBranch: true }
    : {
        status: BranchRefreshStatus.Failed,
        reason: BranchRefreshReason.GuardedWriteFailed,
        shouldReloadBranch: true,
      };
}

export function shouldRefreshTier2BranchPullRequestOnRead(
  target: BranchDetailArtifactRow,
  now: Date,
  pullRequestDetail?: Tier2TargetedPullRequestDetail | null
): boolean {
  const refreshTarget =
    pullRequestDetail ?? getOwnedCurrentPullRequestDetail(target);
  if (!(refreshTarget && resolveTier2Repository(target, refreshTarget))) {
    return false;
  }
  if (isRecentOnReadAttempt(refreshTarget, now)) {
    return false;
  }
  if (refreshTarget.lastVerifiedAt === null) {
    return true;
  }
  return (
    refreshTarget.lastVerifiedAt.getTime() <=
    now.getTime() - TIER2_ON_READ_REFRESH_STALE_MS
  );
}

/**
 * Run the on-read tier-2 refresh when one is due. ISS-12278: the caller runs it
 * after the detail response, so it reloads nothing and returns nothing.
 */
export async function refreshTier2BranchPullRequestOnRead(
  organizationId: string,
  branchId: string,
  row: BranchDetailArtifactRow,
  options: Tier2BranchPullRequestOnReadOptions = {}
): Promise<void> {
  const now = new Date();
  const refreshTarget =
    options.pullRequestDetail ?? getOwnedCurrentPullRequestDetail(row);
  if (!shouldRefreshTier2BranchPullRequestOnRead(row, now, refreshTarget)) {
    return;
  }
  if (!(options.actor && refreshTarget?.number)) {
    return;
  }
  try {
    const budget = await consumeRefreshBudget(
      organizationId,
      options.actor,
      now
    );
    if (!budget.ok) {
      return;
    }
    await refreshTier2TargetedBranchPullRequest({
      organizationId,
      target: row,
      pullRequestDetailId: refreshTarget.id,
      pullRequestNumber: refreshTarget.number,
      now,
      trigger: GitHubFetchTrigger.SurfaceOpen,
      attemptDebounceMs: onReadAttemptDebounceMs(refreshTarget),
      promoteCurrent: options.promoteCurrent ?? true,
      pullRequestDetail: refreshTarget,
    });
  } catch (error) {
    log.warn("branch_detail_tier2_on_read_refresh_failed", {
      organizationId,
      branchId,
      error: parseError(error),
    });
  }
}

export function refreshResponseFromTier2Outcome(
  outcome: Tier2TargetedBranchRefreshOutcome,
  branch: BranchRefreshResponse["branch"]
): BranchRefreshResponse {
  return {
    branch,
    status: outcome.status,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.retryAfterSeconds
      ? { retryAfterSeconds: outcome.retryAfterSeconds }
      : {}),
  };
}

async function claimTier2PullRequestRefresh(input: {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  repositoryFullName: string;
  now: Date;
  attemptDebounceMs: number;
}): Promise<boolean> {
  const staleBefore = new Date(input.now.getTime() - input.attemptDebounceMs);
  const result = await withDb((db) =>
    db.pullRequestDetail.updateMany({
      where: {
        id: input.pullRequestDetailId,
        branchArtifactId: input.branchArtifactId,
        branchArtifact: { organizationId: input.organizationId },
        organizationId: input.organizationId,
        repositoryId: null,
        repositoryFullName: input.repositoryFullName,
        OR: [
          { lastRefreshAttemptAt: null },
          { lastRefreshAttemptAt: { lt: staleBefore } },
        ],
      },
      data: { lastRefreshAttemptAt: input.now },
    })
  );
  return result.count === 1;
}

async function promoteTier2TargetedPullRequest(input: {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
}): Promise<boolean> {
  try {
    return await withDb.tx((db) =>
      promoteBranchCurrentPullRequest(db, input, {
        onlyWhenCurrentMissingOrStub: true,
      })
    );
  } catch (error) {
    if (!isPullRequestCurrentOwnerChangedError(error)) {
      throw error;
    }
    return false;
  }
}

function resolveTier2Repository(
  target: BranchDetailArtifactRow,
  pullRequestDetail: Pick<
    Tier2TargetedPullRequestDetail,
    "branchArtifactId" | "repository" | "repositoryFullName" | "repositoryId"
  > | null = getOwnedCurrentPullRequestDetail(target)
): { owner: string; repo: string; repositoryFullName: string } | null {
  if (
    target.branch.repositoryId !== null ||
    target.branch.repository !== null
  ) {
    return null;
  }
  if (
    !pullRequestDetail ||
    pullRequestDetail.branchArtifactId !== target.id ||
    pullRequestDetail.repositoryId !== null
  ) {
    return null;
  }
  const branchRepositoryFullName = normalizeRepoFullName(
    target.branch.repositoryFullName
  );
  const repositoryFullName = normalizeRepoFullName(
    pullRequestDetail.repository?.fullName ??
      pullRequestDetail.repositoryFullName ??
      target.branch.repositoryFullName
  );
  if (
    pullRequestDetail.repositoryFullName &&
    repositoryFullName !== branchRepositoryFullName
  ) {
    return null;
  }
  if (
    pullRequestDetail.repository?.fullName &&
    repositoryFullName !== branchRepositoryFullName
  ) {
    return null;
  }
  const parsed = parseRepositoryFullName(repositoryFullName);
  return parsed ? { ...parsed, repositoryFullName } : null;
}

function isRecentOnReadAttempt(
  pullRequestDetail: Tier2TargetedPullRequestDetail,
  now: Date
): boolean {
  if (!pullRequestDetail.lastRefreshAttemptAt) {
    return false;
  }
  return (
    pullRequestDetail.lastRefreshAttemptAt.getTime() >
    now.getTime() - onReadAttemptDebounceMs(pullRequestDetail)
  );
}

function onReadAttemptDebounceMs(
  pullRequestDetail: Tier2TargetedPullRequestDetail
): number {
  return pullRequestDetail.lastVerifiedAt === null
    ? TIER2_ON_READ_UNVERIFIED_ATTEMPT_DEBOUNCE_MS
    : BRANCH_REFRESH_RETRY_AFTER_SECONDS * 1000;
}

function createPullRequestGraphqlProvenance(input: {
  clientKind: GitHubCredentialKind;
  credentialOwnerId: string | null;
  now: Date;
  trigger: GitHubFetchTrigger;
}): RepositoryDefaultProvenance {
  return {
    source: RepositoryDefaultSource.PullRequestGraphql,
    mechanism: GitHubFetchMechanism.Graphql,
    trigger: input.trigger,
    credentialType: fetchCredentialTypeFromKind(input.clientKind),
    ...(input.credentialOwnerId
      ? { credentialOwnerId: input.credentialOwnerId }
      : {}),
    observationKey: randomUUID(),
    observedAt: input.now.toISOString(),
  };
}

function accessDenialOutcome(
  error: GitHubAccessError
): Tier2TargetedBranchRefreshOutcome {
  switch (error.reason) {
    case GitHubAccessDenialReason.BudgetDeferred:
      return {
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.BudgetExhausted,
        ...(error.retryAfterSeconds
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
        shouldReloadBranch: false,
      };
    case GitHubAccessDenialReason.RateLimited:
      return {
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.ProviderRateLimited,
        ...(error.retryAfterSeconds
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
        shouldReloadBranch: false,
      };
    // A peer draw holds the pool this instant (ISS-8270) — retryable, and
    // explicitly NOT the identity-required copy the durable denials get.
    case GitHubAccessDenialReason.Contention:
    case GitHubAccessDenialReason.Unavailable:
      return retryableProviderUnavailableOutcome(false);
    case GitHubAccessDenialReason.InsufficientScope:
      return {
        status: BranchRefreshStatus.Failed,
        reason: BranchRefreshReason.GitHubIdentityInsufficientScope,
        shouldReloadBranch: false,
      };
    case GitHubAccessDenialReason.Revoked:
      return {
        status: BranchRefreshStatus.Failed,
        reason: BranchRefreshReason.GitHubIdentityExpired,
        shouldReloadBranch: false,
      };
    case GitHubAccessDenialReason.NoInstallation:
    case GitHubAccessDenialReason.NotConnected:
      return {
        status: BranchRefreshStatus.Failed,
        reason: BranchRefreshReason.GitHubIdentityRequired,
        shouldReloadBranch: false,
      };
    default:
      return retryableProviderUnavailableOutcome(false);
  }
}

function providerFailureOutcome(
  result: Exclude<
    GitHubProviderResult<GitHubPullRequestsByNumberResult>,
    { status: typeof GitHubProviderResultStatus.Success }
  >
): Tier2TargetedBranchRefreshOutcome {
  if (result.status === GitHubProviderResultStatus.ProviderRateLimit) {
    return {
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderRateLimited,
      ...(result.retryAfterSeconds
        ? { retryAfterSeconds: result.retryAfterSeconds }
        : {}),
      shouldReloadBranch: true,
    };
  }
  return retryableProviderUnavailableOutcome(true);
}

function retryableProviderUnavailableOutcome(
  shouldReloadBranch: boolean
): Tier2TargetedBranchRefreshOutcome {
  return {
    status: BranchRefreshStatus.Retryable,
    reason: BranchRefreshReason.ProviderUnavailable,
    shouldReloadBranch,
  };
}

function nonRefreshableOutcome(): Tier2TargetedBranchRefreshOutcome {
  return {
    status: BranchRefreshStatus.NotApplicable,
    reason: BranchRefreshReason.NoCurrentPullRequest,
    shouldReloadBranch: false,
  };
}

/**
 * ISS-12278: an on-read refresh claimed its attempt (the stamp is newer than
 * the last verification) within the last refresh window and has not landed
 * yet, so a reader should look again for its result.
 */
export function isTier2BranchPullRequestRefreshInFlight(
  target: BranchDetailArtifactRow,
  now: Date,
  pullRequestDetail?: Tier2TargetedPullRequestDetail | null
): boolean {
  const refreshTarget =
    pullRequestDetail ?? getOwnedCurrentPullRequestDetail(target);
  const attemptAt = refreshTarget?.lastRefreshAttemptAt;
  if (
    !(
      refreshTarget &&
      attemptAt &&
      resolveTier2Repository(target, refreshTarget)
    )
  ) {
    return false;
  }
  if (
    attemptAt.getTime() <=
    now.getTime() - BRANCH_REFRESH_RETRY_AFTER_SECONDS * 1000
  ) {
    return false;
  }
  return (
    refreshTarget.lastVerifiedAt === null ||
    attemptAt.getTime() > refreshTarget.lastVerifiedAt.getTime()
  );
}
