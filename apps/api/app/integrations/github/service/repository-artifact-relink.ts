/**
 * Repository artifact relink — re-points Branch and PullRequest detail rows at
 * an ACTIVE repository row after a GitHub App reinstall mints a replacement
 * `GitHubInstallationRepository` for the same GitHub repo. Split out of
 * `service.ts`, which owns the rest of the installation/OAuth service surface
 * and drives this sweep from `syncRepositories`, `addRepositories`, and
 * `relinkBranchViewRepositoryCredential`.
 */

import type {
  GitHubInstallationRepository,
  TransactionClient,
} from "@repo/database";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  addRelinkReason,
  createRepositoryArtifactRelinkResult,
  emitRepositoryArtifactRelinkCompletedMetric,
  emitRepositoryArtifactRelinkFailedMetric,
  finalizeRepositoryArtifactRelinkResult,
  RepositoryArtifactRelinkFailureReason,
  type RepositoryArtifactRelinkFailureStage,
  RepositoryArtifactRelinkReason,
  type RepositoryArtifactRelinkResult,
} from "./repository-relink-telemetry";

export type RepositoryRelinkCandidate = Pick<
  GitHubInstallationRepository,
  "id" | "githubRepoId" | "fullName"
>;

type RelinkPullRequestDetailsInput = {
  activeRepositoryId: string;
  branchArtifactId: string;
  currentPullRequestDetailId: string | null;
  oldRepositoryId: string;
  organizationId: string;
};

function repositoryIdentityKey(repo: { githubRepoId: string }): string {
  return repo.githubRepoId;
}

/** Validate that an existing current-PR pointer still belongs to this branch. */
async function loadValidCurrentPullRequestDetailId(
  tx: TransactionClient,
  input: RelinkPullRequestDetailsInput
): Promise<string | null> {
  if (!input.currentPullRequestDetailId) {
    return null;
  }

  const currentDetail = await tx.pullRequestDetail.findFirst({
    where: {
      id: input.currentPullRequestDetailId,
      branchArtifactId: input.branchArtifactId,
      branchArtifact: { organizationId: input.organizationId },
      OR: [
        { repositoryId: input.oldRepositoryId },
        { repositoryId: input.activeRepositoryId },
      ],
    },
    select: { id: true },
  });
  if (currentDetail) {
    return currentDetail.id;
  }

  log.warn(
    "[github] Cleared invalid current PR pointer before stale repository relink",
    {
      activeRepositoryId: input.activeRepositoryId,
      branchArtifactId: input.branchArtifactId,
      currentPullRequestDetailId: input.currentPullRequestDetailId,
      oldRepositoryId: input.oldRepositoryId,
    }
  );
  return null;
}

type ActivePrCollision = {
  id: string;
  number: number;
  branchArtifactId: string;
  branchArtifact: { organizationId: string };
};

/**
 * Load active-repository PR details that share a number with any stale detail,
 * keyed by number. (repositoryId, number) is unique, so each number maps to at
 * most one active row, and stale details carry distinct numbers within their
 * repository, so this single read losslessly replaces the per-detail findFirst.
 */
async function loadActivePrCollisionsByNumber(
  tx: TransactionClient,
  activeRepositoryId: string,
  numbers: number[]
): Promise<Map<number, ActivePrCollision>> {
  if (numbers.length === 0) {
    return new Map();
  }
  const collisions = await tx.pullRequestDetail.findMany({
    where: {
      repositoryId: activeRepositoryId,
      number: { in: numbers },
    },
    select: {
      id: true,
      number: true,
      branchArtifactId: true,
      branchArtifact: { select: { organizationId: true } },
    },
  });
  return new Map(collisions.map((collision) => [collision.number, collision]));
}

/**
 * Move branch-owned PR details to the active repository row while preserving
 * the invariant that a branch has at most one current PR detail. A PR-number
 * collision can only be reused when it already belongs to the same branch
 * artifact and organization; collisions for any other branch block the branch
 * relink so tenant isolation and current-detail ownership stay intact.
 */
async function relinkPullRequestDetailsForBranch(
  tx: TransactionClient,
  input: RelinkPullRequestDetailsInput
): Promise<{
  blocked: boolean;
  currentPullRequestDetailId: string | null;
  pullRequestCount: number;
  pullRequestCollisionSkippedCount: number;
}> {
  let currentPullRequestDetailId = await loadValidCurrentPullRequestDetailId(
    tx,
    input
  );
  let pullRequestCount = 0;
  let pullRequestCollisionSkippedCount = 0;

  const stalePrDetails = await tx.pullRequestDetail.findMany({
    where: {
      branchArtifactId: input.branchArtifactId,
      repositoryId: input.oldRepositoryId,
      branchArtifact: {
        organizationId: input.organizationId,
      },
    },
    select: { id: true, isCurrent: true, number: true },
  });
  if (!currentPullRequestDetailId) {
    currentPullRequestDetailId =
      stalePrDetails.find((detail) => detail.isCurrent)?.id ?? null;
  }
  const collisionByStaleDetailId = new Map<string, string>();

  // Batch the active-repository collision lookups into a single read keyed by
  // PR number instead of one findFirst per stale detail.
  const activeCollisionByNumber = await loadActivePrCollisionsByNumber(
    tx,
    input.activeRepositoryId,
    stalePrDetails.map((detail) => detail.number)
  );

  for (const detail of stalePrDetails) {
    const candidate = activeCollisionByNumber.get(detail.number);
    // A stale detail lives in oldRepositoryId, so it never matches the active
    // query; the id guard preserves the original `id: { not: detail.id }` skip.
    if (candidate && candidate.id !== detail.id) {
      const collision = candidate;
      if (
        collision.branchArtifact.organizationId !== input.organizationId ||
        collision.branchArtifactId !== input.branchArtifactId
      ) {
        log.warn(
          "[github] Skipped stale PR relink because active PR number collision belongs to another branch artifact",
          {
            activeRepositoryId: input.activeRepositoryId,
            branchArtifactId: input.branchArtifactId,
            collisionBranchArtifactId: collision.branchArtifactId,
            oldRepositoryId: input.oldRepositoryId,
            prNumber: detail.number,
          }
        );
        return {
          blocked: true,
          currentPullRequestDetailId: input.currentPullRequestDetailId,
          pullRequestCount,
          pullRequestCollisionSkippedCount:
            pullRequestCollisionSkippedCount + 1,
        };
      }
      collisionByStaleDetailId.set(detail.id, collision.id);
      pullRequestCollisionSkippedCount++;
    }
  }

  for (const detail of stalePrDetails) {
    const collisionId = collisionByStaleDetailId.get(detail.id);
    if (collisionId) {
      if (currentPullRequestDetailId === detail.id) {
        currentPullRequestDetailId = collisionId;
      }
      continue;
    }

    await tx.pullRequestDetail.update({
      where: { id: detail.id },
      data: {
        isCurrent: detail.id === currentPullRequestDetailId,
        repositoryId: input.activeRepositoryId,
      },
      select: { id: true },
    });
    pullRequestCount++;
  }

  if (currentPullRequestDetailId) {
    await tx.pullRequestDetail.updateMany({
      where: {
        branchArtifactId: input.branchArtifactId,
        isCurrent: true,
        id: { not: currentPullRequestDetailId },
      },
      data: { isCurrent: false },
    });
    const updateCurrentResult = await tx.pullRequestDetail.updateMany({
      where: {
        id: currentPullRequestDetailId,
        branchArtifactId: input.branchArtifactId,
        branchArtifact: { organizationId: input.organizationId },
        repositoryId: input.activeRepositoryId,
      },
      data: { isCurrent: true },
    });
    if (updateCurrentResult.count !== 1) {
      log.warn(
        "[github] Cleared current PR pointer because current detail ownership changed",
        {
          activeRepositoryId: input.activeRepositoryId,
          branchArtifactId: input.branchArtifactId,
          currentPullRequestDetailId,
          oldRepositoryId: input.oldRepositoryId,
        }
      );
      currentPullRequestDetailId = null;
      await tx.pullRequestDetail.updateMany({
        where: {
          branchArtifactId: input.branchArtifactId,
          isCurrent: true,
        },
        data: { isCurrent: false },
      });
    }
  }

  return {
    blocked: false,
    currentPullRequestDetailId,
    pullRequestCount,
    pullRequestCollisionSkippedCount,
  };
}

async function relinkBranchDetailsToActiveRepository(
  tx: TransactionClient,
  oldRepositoryId: string,
  activeRepositoryId: string,
  organizationId: string
): Promise<{
  branchCount: number;
  pullRequestCount: number;
  branchCollisionSkippedCount: number;
  pullRequestCollisionSkippedCount: number;
  blockedBranchCount: number;
}> {
  let branchCount = 0;
  let pullRequestCount = 0;
  let branchCollisionSkippedCount = 0;
  let pullRequestCollisionSkippedCount = 0;
  let blockedBranchCount = 0;
  const staleBranches = await tx.branchDetail.findMany({
    where: {
      repositoryId: oldRepositoryId,
      artifact: {
        organizationId,
      },
    },
    select: {
      artifactId: true,
      branchName: true,
      currentPullRequestDetailId: true,
    },
  });

  // Batch the active-repository branch-name collision lookups into a single
  // read instead of one findUnique per stale branch. (repositoryId, branchName)
  // is unique and stale branches all live in oldRepositoryId with distinct
  // names, so the map captures every collision without loss.
  const staleBranchNames = staleBranches.map((branch) => branch.branchName);
  const activeBranchCollisions =
    staleBranchNames.length > 0
      ? await tx.branchDetail.findMany({
          where: {
            repositoryId: activeRepositoryId,
            branchName: { in: staleBranchNames },
          },
          select: { artifactId: true, branchName: true },
        })
      : [];
  const activeBranchCollisionByName = new Map<
    string,
    (typeof activeBranchCollisions)[number]
  >();
  for (const collision of activeBranchCollisions) {
    activeBranchCollisionByName.set(collision.branchName, collision);
  }

  for (const branch of staleBranches) {
    const branchCollision =
      activeBranchCollisionByName.get(branch.branchName) ?? null;

    if (branchCollision) {
      branchCollisionSkippedCount++;
      continue;
    }

    const prRelink = await relinkPullRequestDetailsForBranch(tx, {
      activeRepositoryId,
      branchArtifactId: branch.artifactId,
      currentPullRequestDetailId: branch.currentPullRequestDetailId,
      oldRepositoryId,
      organizationId,
    });
    if (prRelink.blocked) {
      blockedBranchCount++;
      pullRequestCollisionSkippedCount +=
        prRelink.pullRequestCollisionSkippedCount;
      continue;
    }

    await tx.branchDetail.update({
      where: { artifactId: branch.artifactId },
      data: {
        currentPullRequestDetailId: prRelink.currentPullRequestDetailId,
        repositoryId: activeRepositoryId,
      },
      select: { artifactId: true },
    });
    branchCount++;
    pullRequestCount += prRelink.pullRequestCount;
    pullRequestCollisionSkippedCount +=
      prRelink.pullRequestCollisionSkippedCount;
  }

  return {
    branchCount,
    pullRequestCount,
    branchCollisionSkippedCount,
    pullRequestCollisionSkippedCount,
    blockedBranchCount,
  };
}

/**
 * Re-home branch and PR detail rows after a GitHub App reinstall creates a
 * replacement GitHubInstallationRepository row for the same GitHub repo.
 *
 * Branch view intentionally requires the repository's installation to be
 * ACTIVE. Without this reconciliation, existing branch artifacts can keep
 * pointing at a repository row owned by an UNINSTALLED installation and 404
 * even though the branch artifact and pull request still exist.
 */
async function relinkArtifactsToActiveRepositories(
  tx: TransactionClient,
  activeInstallationId: string,
  repositories: RepositoryRelinkCandidate[],
  expectedOrganizationId?: string
): Promise<RepositoryArtifactRelinkResult> {
  const activeRepositories = repositories.filter(
    (repo) => repo.id && repo.githubRepoId && repo.fullName
  );
  const result = createRepositoryArtifactRelinkResult({
    activeRepositoryCount: activeRepositories.length,
  });
  if (activeRepositories.length === 0) {
    addRelinkReason(
      result,
      RepositoryArtifactRelinkReason.NoActiveRepositories
    );
    return finalizeRepositoryArtifactRelinkResult(result);
  }

  const activeInstallation = await tx.gitHubInstallation.findFirst({
    where: {
      id: activeInstallationId,
      status: GitHubInstallationStatus.ACTIVE,
      ...(expectedOrganizationId
        ? { organizationId: expectedOrganizationId }
        : { organizationId: { not: null } }),
    },
    select: { organizationId: true, status: true },
  });
  if (!activeInstallation?.organizationId) {
    addRelinkReason(
      result,
      RepositoryArtifactRelinkReason.NoActiveInstallation
    );
    return finalizeRepositoryArtifactRelinkResult(result);
  }

  const activeByIdentity = new Map<string, RepositoryRelinkCandidate>();
  const ambiguousActiveIdentities = new Set<string>();
  for (const activeRepository of activeRepositories) {
    const identity = repositoryIdentityKey(activeRepository);
    if (activeByIdentity.has(identity)) {
      activeByIdentity.delete(identity);
      ambiguousActiveIdentities.add(identity);
      result.ambiguousRepositorySkippedCount++;
      addRelinkReason(
        result,
        RepositoryArtifactRelinkReason.ActiveRepositoryAmbiguous
      );
      continue;
    }
    if (!ambiguousActiveIdentities.has(identity)) {
      activeByIdentity.set(identity, activeRepository);
    }
  }
  const staleRepositories = await tx.gitHubInstallationRepository.findMany({
    where: {
      installationId: { not: activeInstallationId },
      githubRepoId: { in: activeRepositories.map((repo) => repo.githubRepoId) },
      branchDetails: {
        some: {
          artifact: {
            organizationId: activeInstallation.organizationId,
          },
        },
      },
      installation: {
        OR: [
          { organizationId: null },
          { status: { not: GitHubInstallationStatus.ACTIVE } },
        ],
      },
    },
    select: {
      id: true,
      githubRepoId: true,
      fullName: true,
    },
  });
  result.staleRepositoryCount = staleRepositories.length;

  for (const staleRepository of staleRepositories) {
    const activeRepository = activeByIdentity.get(
      repositoryIdentityKey(staleRepository)
    );
    if (!activeRepository) {
      result.ambiguousRepositorySkippedCount++;
      addRelinkReason(
        result,
        RepositoryArtifactRelinkReason.ActiveRepositoryAmbiguous
      );
      continue;
    }

    const relinked = await relinkBranchDetailsToActiveRepository(
      tx,
      staleRepository.id,
      activeRepository.id,
      activeInstallation.organizationId
    );
    result.branchRelinkedCount += relinked.branchCount;
    result.pullRequestRelinkedCount += relinked.pullRequestCount;
    result.branchCollisionSkippedCount += relinked.branchCollisionSkippedCount;
    result.pullRequestCollisionSkippedCount +=
      relinked.pullRequestCollisionSkippedCount;
    result.blockedBranchCount += relinked.blockedBranchCount;
  }

  if (result.branchCollisionSkippedCount > 0) {
    addRelinkReason(result, RepositoryArtifactRelinkReason.BranchNameCollision);
  }
  if (result.pullRequestCollisionSkippedCount > 0) {
    addRelinkReason(
      result,
      RepositoryArtifactRelinkReason.PullRequestNumberCollision
    );
  }
  if (result.blockedBranchCount > 0) {
    addRelinkReason(result, RepositoryArtifactRelinkReason.GuardedWriteFailed);
  }

  const finalizedResult = finalizeRepositoryArtifactRelinkResult(result);
  if (
    finalizedResult.branchRelinkedCount > 0 ||
    finalizedResult.pullRequestRelinkedCount > 0
  ) {
    log.info("[github] Relinked stale repository artifacts", {
      activeInstallationId,
      branchCount: finalizedResult.branchRelinkedCount,
      pullRequestCount: finalizedResult.pullRequestRelinkedCount,
    });
  }

  return finalizedResult;
}

export async function runRepositoryArtifactRelink(input: {
  installationId: string;
  repositories: RepositoryRelinkCandidate[];
  expectedOrganizationId?: string;
  failureStage: RepositoryArtifactRelinkFailureStage;
}): Promise<RepositoryArtifactRelinkResult> {
  try {
    const result = await withDb.tx((tx) =>
      relinkArtifactsToActiveRepositories(
        tx,
        input.installationId,
        input.repositories,
        input.expectedOrganizationId
      )
    );
    emitRepositoryArtifactRelinkCompletedMetric(result, input.failureStage);
    return result;
  } catch (error) {
    emitRepositoryArtifactRelinkFailedMetric(
      input.failureStage,
      RepositoryArtifactRelinkFailureReason.TransactionFailed
    );
    log.warn("[github] Failed to relink stale repository artifacts", {
      installationId: input.installationId,
      stage: input.failureStage,
      error: parseError(error),
    });
    return createRepositoryArtifactRelinkResult({
      reasons: [RepositoryArtifactRelinkReason.GuardedWriteFailed],
    });
  }
}
