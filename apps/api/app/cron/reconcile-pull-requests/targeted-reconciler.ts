import type {
  GitHubBundledPullRequestsObservation,
  GitHubReadModelPullRequest,
} from "@repo/api/src/types/github-read-model";
import type { RepositoryDefaultProvenance } from "@repo/api/src/types/repository-default-identity";
import { withDb } from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import type { GitHubProviderResult } from "@repo/github/provider-result";
import {
  GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE,
  type GitHubPullRequestsByNumberResult,
  getRepositoryPullRequestsByNumberWithProviderResult,
} from "@repo/github/pull-request-point-read";
import {
  isPullRequestCurrentOwnerChangedError,
  promoteBranchCurrentPullRequest,
} from "@/app/branches/pull-request-current-promotion";
import type { GitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import {
  resolveReconcileTargets,
  writeReconciledPullRequest,
} from "./reconcile-projection-write";
import {
  type SessionLinkedPullRequestTarget,
  selectSessionLinkedPullRequestTargets,
} from "./session-linked-targets";
import { selectUnlinkedOpenPullRequestTargets } from "./unlinked-open-pull-request-targets";

export const TargetedReconcileStatus = {
  Success: "success",
  FetchFailed: "fetch_failed",
} as const;
export type TargetedReconcileStatus =
  (typeof TargetedReconcileStatus)[keyof typeof TargetedReconcileStatus];

export type TargetedReconcileResult =
  | {
      status: typeof TargetedReconcileStatus.Success;
      observations: GitHubBundledPullRequestsObservation[];
      providerRead: boolean;
      writtenCount: number;
      newestUpdatedAt: Date | null;
      targetNumbers: number[];
      missingNumbers: number[];
    }
  | {
      status: typeof TargetedReconcileStatus.FetchFailed;
      observations: GitHubBundledPullRequestsObservation[];
      targetNumbers: number[];
      result: Exclude<
        GitHubProviderResult<GitHubPullRequestsByNumberResult>,
        { status: typeof GitHubProviderResultStatus.Success }
      >;
    };

/**
 * PRD-683 P0-A targeted tier-2 path: fetch session-linked PR numbers and
 * promote only verified rows whose branch lacks richer current provider data.
 * ISS-12292 adds OPEN rows with no session link to the same read; those are
 * written and never promoted.
 */
export async function reconcileTargetedSessionLinkedPullRequests(input: {
  organizationId: string;
  repositoryId: string | null;
  repositoryFullName: string;
  owner: string;
  repo: string;
  client: GitHubSyncClient;
  provenance: RepositoryDefaultProvenance;
  now: Date;
}): Promise<TargetedReconcileResult> {
  const scope = {
    organizationId: input.organizationId,
    repositoryId: input.repositoryId,
    repositoryFullName: input.repositoryFullName,
    now: input.now,
  };
  const targets = await selectSessionLinkedPullRequestTargets(scope);
  // ISS-12292: only the room left in the one point-read request the
  // session-linked arm already makes. A second request would be new spend, and
  // its failure would fail the whole read, session-linked rows included.
  const unlinkedRoom =
    GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE - targets.length;
  const unlinkedTargets =
    unlinkedRoom > 0
      ? await selectUnlinkedOpenPullRequestTargets({
          ...scope,
          limit: unlinkedRoom,
        })
      : [];
  const targetNumbers = [
    ...new Set([...targets, ...unlinkedTargets].map((target) => target.number)),
  ];
  const observations: GitHubBundledPullRequestsObservation[] = [];
  if (targetNumbers.length === 0) {
    return {
      status: TargetedReconcileStatus.Success,
      observations,
      providerRead: false,
      writtenCount: 0,
      newestUpdatedAt: null,
      targetNumbers,
      missingNumbers: [],
    };
  }

  const result = await getRepositoryPullRequestsByNumberWithProviderResult(
    input.client.octokit,
    input.owner,
    input.repo,
    targetNumbers,
    (observation) => observations.push(observation),
    {
      mechanism: input.provenance.mechanism,
      trigger: input.provenance.trigger,
      credentialType: input.provenance.credentialType,
      ...(input.provenance.credentialOwnerId
        ? { credentialOwnerId: input.provenance.credentialOwnerId }
        : {}),
      observationKey: input.provenance.observationKey,
      observedAt: input.provenance.observedAt,
    }
  );
  if (result.status !== GitHubProviderResultStatus.Success) {
    return {
      status: TargetedReconcileStatus.FetchFailed,
      observations,
      targetNumbers,
      result,
    };
  }

  const targetByNumber = new Map(
    targets.map((target) => [target.number, target])
  );
  const written = await writeAndPromoteTargetedPullRequests(
    result.value.pullRequests,
    targetByNumber,
    new Set(unlinkedTargets.map((target) => target.number)),
    input
  );
  await stampMissingTargetAttempts(
    input.organizationId,
    [...targets, ...unlinkedTargets],
    result.value,
    input.now
  );

  return {
    status: TargetedReconcileStatus.Success,
    observations,
    providerRead: true,
    writtenCount: written.writtenCount,
    newestUpdatedAt: written.newestUpdatedAt,
    targetNumbers,
    missingNumbers: result.value.missingNumbers,
  };
}

async function writeAndPromoteTargetedPullRequests(
  pullRequests: GitHubReadModelPullRequest[],
  targetByNumber: Map<number, SessionLinkedPullRequestTarget>,
  unlinkedNumbers: ReadonlySet<number>,
  context: {
    organizationId: string;
    repositoryId: string | null;
    repositoryFullName: string;
    client: GitHubSyncClient;
    provenance: RepositoryDefaultProvenance;
    now: Date;
  }
): Promise<{ writtenCount: number; newestUpdatedAt: Date | null }> {
  let writtenCount = 0;
  let newestUpdatedAt: Date | null = null;
  const selected: {
    pullRequest: GitHubReadModelPullRequest;
    target: SessionLinkedPullRequestTarget | undefined;
  }[] = [];
  for (const pullRequest of pullRequests) {
    const target = targetByNumber.get(pullRequest.number);
    if (!(target || unlinkedNumbers.has(pullRequest.number))) {
      continue;
    }
    newestUpdatedAt = maxDate(
      newestUpdatedAt,
      pullRequest.updatedAt ? new Date(pullRequest.updatedAt) : null
    );
    selected.push({ pullRequest, target });
  }
  // ISS-8919: one identity read for the batch instead of one per target.
  const detailTargets = await resolveReconcileTargets(
    selected.map((entry) => entry.pullRequest.number),
    context
  );
  for (const { pullRequest, target } of selected) {
    const wrote = await writeReconciledPullRequest(pullRequest, {
      organizationId: context.organizationId,
      repositoryId: context.repositoryId,
      repositoryFullName: context.repositoryFullName,
      credentialKind: context.client.kind,
      credentialOwnerId: context.client.credentialOwnerId,
      fetchTrigger: context.provenance.trigger,
      now: context.now,
      detailTargets,
    });
    if (!wrote) {
      continue;
    }
    writtenCount += 1;
    // PRD-683 D1 scopes promotion to session-linked branches.
    if (target) {
      await promoteTargetedPullRequest(context.organizationId, target);
    }
  }
  return { writtenCount, newestUpdatedAt };
}

async function promoteTargetedPullRequest(
  organizationId: string,
  target: SessionLinkedPullRequestTarget
): Promise<void> {
  try {
    await withDb.tx((db) =>
      promoteBranchCurrentPullRequest(
        db,
        {
          organizationId,
          branchArtifactId: target.branchArtifactId,
          pullRequestDetailId: target.pullRequestDetailId,
        },
        { onlyWhenCurrentMissingOrStub: true }
      )
    );
  } catch (error) {
    if (!isPullRequestCurrentOwnerChangedError(error)) {
      throw error;
    }
  }
}

async function stampMissingTargetAttempts(
  organizationId: string,
  targets: Pick<
    SessionLinkedPullRequestTarget,
    "pullRequestDetailId" | "number"
  >[],
  result: GitHubPullRequestsByNumberResult,
  now: Date
): Promise<void> {
  if (result.missingNumbers.length === 0) {
    return;
  }
  const missingNumbers = new Set(result.missingNumbers);
  const missingIds = targets
    .filter((target) => missingNumbers.has(target.number))
    .map((target) => target.pullRequestDetailId);
  if (missingIds.length === 0) {
    return;
  }
  await withDb((db) =>
    db.pullRequestDetail.updateMany({
      where: { organizationId, id: { in: missingIds } },
      data: { lastRefreshAttemptAt: now },
    })
  );
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a.getTime() >= b.getTime() ? a : b;
}
