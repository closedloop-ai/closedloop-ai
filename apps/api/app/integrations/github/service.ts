import type {
  GitHubInstallationStatus as ApiGitHubInstallationStatus,
  GetBranchesResponse,
  GetContributorsResponse,
  GetPullRequestsResponse,
  GitHubContributor,
  GitHubIntegrationStatus,
} from "@repo/api/src/types/github";
import { GitHubInstallationStatus as ApiGitHubInstallationStatusValue } from "@repo/api/src/types/github";
import { Result, Status } from "@repo/api/src/types/result";
import type {
  GitHubInstallation,
  GitHubInstallationRepository,
  Prisma,
  TransactionClient,
} from "@repo/database";
import { ArtifactType, GitHubInstallationStatus, withDb } from "@repo/database";
import {
  deleteInstallation,
  getRepositoryBranches,
  getRepositoryContributors,
  getRepositoryPullRequestsWithMetadata,
} from "@repo/github";
import { keys } from "@repo/github/keys";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { parseGitHubPullRequestUrl } from "@/app/artifact-links/pull-requests/pull-request-url";
import { normalizeGitHubLogin } from "@/app/comments/external-authors";
import { projectsService } from "@/app/projects/service";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { encryptTokenPair } from "@/lib/integration-encryption";
import { resolveGitHubDataConnectionStatus } from "./data-connection-status";
import { publicRepositoryService } from "./public-repositories/service";

/**
 * Input type for upserting installation repositories
 */
export type RepositoryInput = {
  githubRepoId: string;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
};

/**
 * Result type for OAuth callback operations.
 *
 * `requires_confirmation` is emitted by the same-vs-different-account
 * detection (PLN-634) when an org reconnects to a GitHub account whose
 * numeric `accountId` differs from the previously connected one. The route
 * returns this payload to the UI so an admin can confirm a destructive
 * cleanup before any state is mutated.
 */
export type OAuthCallbackResult =
  | { status: "connected" }
  | { status: "error"; error: string }
  | {
      status: "requires_confirmation";
      priorAccount: { accountId: string; accountLogin: string };
      newAccount: { accountId: string; accountLogin: string };
      newInstallationId: string;
    };

type RepositoryRelinkCandidate = Pick<
  GitHubInstallationRepository,
  "id" | "githubRepoId" | "fullName"
>;

const TARGET_PULL_REQUEST_MAX_PAGES = 5;
const TARGET_PULL_REQUEST_MAX_ITEMS = 500;

export const RepositoryArtifactRelinkStatus = {
  Completed: "completed",
  Partial: "partial",
  Skipped: "skipped",
} as const;
export type RepositoryArtifactRelinkStatus =
  (typeof RepositoryArtifactRelinkStatus)[keyof typeof RepositoryArtifactRelinkStatus];

export const RepositoryArtifactRelinkReason = {
  None: "none",
  NoActiveInstallation: "no_active_installation",
  NoActiveRepositories: "no_active_repositories",
  ActiveRepositoryAmbiguous: "active_repository_ambiguous",
  BranchNameCollision: "branch_name_collision",
  PullRequestNumberCollision: "pull_request_number_collision",
  GuardedWriteFailed: "guarded_write_failed",
} as const;
export type RepositoryArtifactRelinkReason =
  (typeof RepositoryArtifactRelinkReason)[keyof typeof RepositoryArtifactRelinkReason];

export type RepositoryArtifactRelinkResult = {
  status: RepositoryArtifactRelinkStatus;
  reasons: RepositoryArtifactRelinkReason[];
  activeRepositoryCount: number;
  staleRepositoryCount: number;
  branchRelinkedCount: number;
  pullRequestRelinkedCount: number;
  branchCollisionSkippedCount: number;
  pullRequestCollisionSkippedCount: number;
  ambiguousRepositorySkippedCount: number;
  blockedBranchCount: number;
};

export const RepositoryArtifactRelinkFailureStage = {
  OAuthClaim: "oauth_claim",
  SyncRepositories: "sync_repositories",
  AddRepositories: "add_repositories",
  SyncPreflightRelink: "sync_preflight_relink",
} as const;
export type RepositoryArtifactRelinkFailureStage =
  (typeof RepositoryArtifactRelinkFailureStage)[keyof typeof RepositoryArtifactRelinkFailureStage];

export const RepositoryArtifactRelinkFailureReason = {
  RepositoryFetchFailed: "repository_fetch_failed",
  RepositoryFetchPartial: "repository_fetch_partial",
  TransactionFailed: "transaction_failed",
  TelemetryEmitFailed: "telemetry_emit_failed",
} as const;
export type RepositoryArtifactRelinkFailureReason =
  (typeof RepositoryArtifactRelinkFailureReason)[keyof typeof RepositoryArtifactRelinkFailureReason];

export const RepositoryArtifactRelinkMetricName = {
  Completed: "github.installation_artifact_relink.completed",
  Failed: "github.installation_artifact_relink.failed",
} as const;
export type RepositoryArtifactRelinkMetricName =
  (typeof RepositoryArtifactRelinkMetricName)[keyof typeof RepositoryArtifactRelinkMetricName];

type FetchInstallationRepositoriesResult =
  | { ok: true; repositories: RepositoryInput[] }
  | {
      ok: false;
      repositories: RepositoryInput[];
      error:
        | typeof RepositoryArtifactRelinkFailureReason.RepositoryFetchFailed
        | typeof RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial;
    };

type RelinkPullRequestDetailsInput = {
  activeRepositoryId: string;
  branchArtifactId: string;
  currentPullRequestDetailId: string | null;
  oldRepositoryId: string;
  organizationId: string;
};

type GitHubOAuthToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number | null;
  refreshTokenExpiresInSeconds: number | null;
  scopes: string[];
};

type GitHubOAuthUser = {
  id: number;
  login: string;
  node_id?: string | null;
  avatar_url?: string | null;
  html_url?: string | null;
};

const OAUTH_SCOPE_SEPARATOR_PATTERN = /[,\s]+/;

/**
 * Fetch the authenticated GitHub user's info using an access token.
 */
async function fetchGitHubUser(
  accessToken: string
): Promise<GitHubOAuthUser | null> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    log.warn("[github/oauth] Failed to fetch GitHub user info", {
      status: response.status,
    });
    return null;
  }

  return response.json() as Promise<GitHubOAuthUser>;
}

async function fetchRequiredGitHubUser(
  accessToken: string
): Promise<GitHubOAuthUser> {
  const user = await fetchGitHubUser(accessToken);
  if (!user) {
    throw new Error("Failed to fetch GitHub user info");
  }
  return user;
}

/**
 * Check if an installation can be claimed by the given organization.
 * Returns an error message if claim is blocked, null if allowed.
 *
 * Ownership rules:
 *  - unclaimed (organizationId === null) → claim allowed
 *  - same-org (organizationId === targetOrgId) → claim allowed regardless of
 *    status. Covers idempotent re-claim of an ACTIVE row and re-claim of an
 *    UNINSTALLED row whose org link is preserved across disconnect for the
 *    same-account reconnect path (see disconnectInstallation).
 *  - different-org (organizationId set and ≠ targetOrgId) → claim blocked.
 *    Prevents hijacking when a GitHub admin suspends an installation but the
 *    org link remains, and prevents a fresh installation row from being
 *    claimed for the wrong tenant.
 */
function validateInstallationClaim(
  installation: { organizationId: string | null; status: string },
  targetOrgId: string
): string | null {
  if (
    installation.organizationId &&
    installation.organizationId !== targetOrgId
  ) {
    return "This GitHub installation is already connected to another organization";
  }
  return null;
}

function repositoryIdentityKey(repo: { githubRepoId: string }): string {
  return repo.githubRepoId;
}

function createRepositoryArtifactRelinkResult(
  overrides: Partial<RepositoryArtifactRelinkResult> = {}
): RepositoryArtifactRelinkResult {
  return {
    status: RepositoryArtifactRelinkStatus.Skipped,
    reasons: [RepositoryArtifactRelinkReason.None],
    activeRepositoryCount: 0,
    staleRepositoryCount: 0,
    branchRelinkedCount: 0,
    pullRequestRelinkedCount: 0,
    branchCollisionSkippedCount: 0,
    pullRequestCollisionSkippedCount: 0,
    ambiguousRepositorySkippedCount: 0,
    blockedBranchCount: 0,
    ...overrides,
  };
}

function addRelinkReason(
  result: RepositoryArtifactRelinkResult,
  reason: RepositoryArtifactRelinkReason
) {
  if (reason === RepositoryArtifactRelinkReason.None) {
    return;
  }
  result.reasons = result.reasons.filter(
    (existing) => existing !== RepositoryArtifactRelinkReason.None
  );
  if (!result.reasons.includes(reason)) {
    result.reasons.push(reason);
  }
}

function finalizeRepositoryArtifactRelinkResult(
  result: RepositoryArtifactRelinkResult
): RepositoryArtifactRelinkResult {
  const skippedOrBlocked =
    result.branchCollisionSkippedCount +
    result.pullRequestCollisionSkippedCount +
    result.ambiguousRepositorySkippedCount +
    result.blockedBranchCount;
  if (skippedOrBlocked > 0) {
    return { ...result, status: RepositoryArtifactRelinkStatus.Partial };
  }
  if (result.branchRelinkedCount > 0 || result.pullRequestRelinkedCount > 0) {
    return { ...result, status: RepositoryArtifactRelinkStatus.Completed };
  }
  return { ...result, status: RepositoryArtifactRelinkStatus.Skipped };
}

function emitRepositoryArtifactRelinkCompletedMetric(
  result: RepositoryArtifactRelinkResult,
  failureStage: RepositoryArtifactRelinkFailureStage
) {
  try {
    emitTelemetryMetric({
      metric: RepositoryArtifactRelinkMetricName.Completed,
      count: 1,
      status: result.status,
      reasonCount: result.reasons.filter(
        (reason) => reason !== RepositoryArtifactRelinkReason.None
      ).length,
      activeRepositoryCount: result.activeRepositoryCount,
      staleRepositoryCount: result.staleRepositoryCount,
      branchRelinkedCount: result.branchRelinkedCount,
      pullRequestRelinkedCount: result.pullRequestRelinkedCount,
      branchCollisionSkippedCount: result.branchCollisionSkippedCount,
      pullRequestCollisionSkippedCount: result.pullRequestCollisionSkippedCount,
      ambiguousRepositorySkippedCount: result.ambiguousRepositorySkippedCount,
      blockedBranchCount: result.blockedBranchCount,
    });
  } catch (error) {
    emitRepositoryArtifactRelinkFailedMetric(
      failureStage,
      RepositoryArtifactRelinkFailureReason.TelemetryEmitFailed
    );
    log.warn("[github] Failed to emit artifact relink metric", {
      error: parseError(error),
    });
  }
}

function emitRepositoryArtifactRelinkFailedMetric(
  stage: RepositoryArtifactRelinkFailureStage,
  reason: RepositoryArtifactRelinkFailureReason
) {
  try {
    emitTelemetryMetric({
      metric: RepositoryArtifactRelinkMetricName.Failed,
      count: 1,
      stage,
      reason,
    });
  } catch (error) {
    log.warn("[github] Failed to emit artifact relink failure metric", {
      stage,
      reason,
      error: parseError(error),
    });
  }
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

async function runRepositoryArtifactRelink(input: {
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

/**
 * Subset of the GitHub `installation` payload we actually persist. Anchored
 * to the Octokit `GET /user/installations` response — the upstream type's
 * `account` is `SimpleUser | Enterprise | null`, so we keep this narrower
 * shape (non-null account, only the fields we read) instead of threading
 * null checks through every call site that builds a Prisma row.
 *
 * Source of truth: Endpoints["GET /user/installations"] in `@octokit/types`.
 */
type GitHubRawInstallation = {
  id: number;
  account: { id: number; login: string; type: string };
  permissions: Prisma.InputJsonValue;
  events: Prisma.InputJsonValue;
  repository_selection: string;
};

function parseOAuthScopes(scope: string | null | undefined): string[] {
  return (scope ?? "")
    .split(OAUTH_SCOPE_SEPARATOR_PATTERN)
    .map((value) => value.trim())
    .filter(Boolean);
}

function expiresAtFromSeconds(
  issuedAt: Date,
  seconds: number | null
): Date | null {
  if (seconds === null) {
    return null;
  }
  return new Date(issuedAt.getTime() + seconds * 1000);
}

function parseExpiresInSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function persistGitHubUserConnection(
  tx: TransactionClient,
  input: {
    organizationId: string;
    userId: string;
    githubUser: GitHubOAuthUser;
    token: GitHubOAuthToken;
    encryptedAccessToken: string;
    encryptedRefreshToken: string | null;
    issuedAt: Date;
  }
): Promise<void> {
  const connectionData = {
    githubUserId: String(input.githubUser.id),
    githubNodeId: input.githubUser.node_id ?? null,
    login: input.githubUser.login,
    normalizedLogin: normalizeGitHubLogin(input.githubUser.login),
    avatarUrl: input.githubUser.avatar_url ?? null,
    profileUrl: input.githubUser.html_url ?? null,
    accessTokenEncrypted: input.encryptedAccessToken,
    refreshTokenEncrypted: input.encryptedRefreshToken,
    tokenExpiresAt: expiresAtFromSeconds(
      input.issuedAt,
      input.token.expiresInSeconds
    ),
    refreshTokenExpiresAt: expiresAtFromSeconds(
      input.issuedAt,
      input.token.refreshTokenExpiresInSeconds
    ),
    scopes: input.token.scopes,
  };

  await tx.gitHubUserConnection.upsert({
    where: {
      organizationId_userId: {
        organizationId: input.organizationId,
        userId: input.userId,
      },
    },
    create: {
      organizationId: input.organizationId,
      userId: input.userId,
      ...connectionData,
    },
    update: {
      ...connectionData,
      revokedAt: null,
    },
  });
}

async function claimInstallationAndPersistGitHubUserConnection(input: {
  installationRecordId: string;
  organizationId: string;
  userId: string;
  githubUser: GitHubOAuthUser;
  token: GitHubOAuthToken;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  issuedAt: Date;
}): Promise<number> {
  return await withDb.tx(async (tx) => {
    const claimResult = await tx.gitHubInstallation.updateMany({
      where: {
        id: input.installationRecordId,
        OR: [
          { organizationId: null },
          { organizationId: input.organizationId },
        ],
      },
      data: {
        status: GitHubInstallationStatus.ACTIVE,
        organizationId: input.organizationId,
        claimedAt: new Date(),
        claimedByUserId: input.userId,
      },
    });

    if (claimResult.count !== 1) {
      return claimResult.count;
    }

    await persistGitHubUserConnection(tx, {
      organizationId: input.organizationId,
      userId: input.userId,
      githubUser: input.githubUser,
      token: input.token,
      encryptedAccessToken: input.encryptedAccessToken,
      encryptedRefreshToken: input.encryptedRefreshToken,
      issuedAt: input.issuedAt,
    });

    return claimResult.count;
  });
}

type ResolvedInstallation = {
  id: number;
  info: GitHubRawInstallation;
};

/**
 * Fetch the repository list for a given installation via GitHub's user
 * installations endpoint. Returns null when the request fails so the caller
 * can decide whether to abort or proceed. Extracted from completeOAuthCallback
 * so the same fetch can feed both the regular claim path and the reuse-in-
 * place reconciler (PLN-634).
 */
async function fetchInstallationRepositories(
  userAccessToken: string,
  resolvedInstallationId: number
): Promise<FetchInstallationRepositoriesResult> {
  const repositories: RepositoryInput[] = [];
  let pageUrl: string | null =
    `https://api.github.com/user/installations/${resolvedInstallationId}/repositories?per_page=100`;
  let page = 1;

  try {
    while (pageUrl) {
      const reposResponse = await fetch(pageUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${userAccessToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (!reposResponse.ok) {
        const error =
          page === 1
            ? RepositoryArtifactRelinkFailureReason.RepositoryFetchFailed
            : RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial;
        log.warn("[github/oauth] Failed to fetch repositories", {
          status: reposResponse.status,
          installationId: resolvedInstallationId,
          page,
          error,
        });
        return { ok: false, repositories, error };
      }

      const reposData = (await reposResponse.json()) as {
        repositories?: Array<{
          id: number;
          full_name: string;
          name: string;
          owner: { login: string };
          private: boolean;
        }>;
      };

      repositories.push(
        ...(reposData.repositories ?? []).map((repo) => ({
          githubRepoId: String(repo.id),
          fullName: repo.full_name,
          name: repo.name,
          owner: repo.owner.login,
          private: repo.private,
        }))
      );

      const nextPage = parseNextRepositoryPageUrl(
        reposResponse.headers.get("link"),
        resolvedInstallationId
      );
      if (!nextPage.valid) {
        log.warn("[github/oauth] Ignored invalid repository pagination link", {
          installationId: resolvedInstallationId,
          page,
        });
        return {
          ok: false,
          repositories,
          error: RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial,
        };
      }
      pageUrl = nextPage.url;
      page++;
    }

    return { ok: true, repositories };
  } catch (error) {
    log.warn("[github/oauth] Repository fetch threw", {
      installationId: resolvedInstallationId,
      error: parseError(error),
    });
    return {
      ok: false,
      repositories,
      error:
        repositories.length === 0
          ? RepositoryArtifactRelinkFailureReason.RepositoryFetchFailed
          : RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial,
    };
  }
}

function parseNextRepositoryPageUrl(
  linkHeader: string | null,
  resolvedInstallationId: number
): { valid: true; url: string | null } | { valid: false } {
  if (!linkHeader) {
    return { valid: true, url: null };
  }
  for (const part of linkHeader.split(",")) {
    const [urlPart, ...parameters] = part.trim().split(";");
    const hasNextRel = parameters.some(
      (parameter) => parameter.trim() === 'rel="next"'
    );
    if (hasNextRel && !(urlPart.startsWith("<") && urlPart.endsWith(">"))) {
      return { valid: false };
    }
    if (hasNextRel) {
      const url = urlPart.slice(1, -1);
      if (isAllowedRepositoryPageUrl(url, resolvedInstallationId)) {
        return { valid: true, url };
      }
      return { valid: false };
    }
  }
  return { valid: true, url: null };
}

function isAllowedRepositoryPageUrl(
  candidate: string,
  resolvedInstallationId: number
): boolean {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.hostname !== "api.github.com") {
      return false;
    }
    if (
      url.pathname !==
      `/user/installations/${resolvedInstallationId}/repositories`
    ) {
      return false;
    }
    if (url.searchParams.get("per_page") !== "100") {
      return false;
    }
    const page = url.searchParams.get("page");
    return Boolean(page && Number.isInteger(Number(page)) && Number(page) > 1);
  } catch {
    return false;
  }
}

/**
 * Same-account reconnect path (PLN-634).
 *
 * Reuses the prior UNINSTALLED installation row in place so all dependent
 * UUIDs (TeamRepository, BranchDetail.repositoryId, PullRequestDetail.
 * repositoryId, GitHubInstallationRepository) are preserved across the
 * disconnect/reinstall window.
 *
 * Steps inside a single transaction:
 *  1. Drop a freshly-created row (if any) carrying the new GitHub
 *     installationId — typically created by the `installation.created`
 *     webhook between disconnect and OAuth callback. This frees the
 *     `installationId @unique` slot before step 2.
 *  2. Update the prior row's `installationId` to the new GitHub install ID,
 *     flip status to ACTIVE, refresh GitHub-side fields.
 *  3. Reconcile repositories by `githubRepoId`:
 *     - Upsert each incoming repo (existing rows keep their UUID; fullName
 *       and other fields are refreshed; `removedAt` is cleared if the repo
 *       reappears after a previous tombstone).
 *     - Tombstone each existing repo whose `githubRepoId` is absent from
 *       the new install. We do NOT delete because BranchDetail /
 *       PullRequestDetail rows may still reference the row.
 */
async function reconnectByAccount(input: {
  priorInstallationId: string;
  resolved: ResolvedInstallation;
  organizationId: string;
  userId: string;
  githubUser: GitHubOAuthUser;
  token: GitHubOAuthToken;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  issuedAt: Date;
  repositories: RepositoryInput[];
}): Promise<void> {
  const newGithubInstallationId = String(input.resolved.id);
  await withDb.tx(async (tx) => {
    // Only drop a fresh PENDING_CLAIM row created by the webhook race. The
    // `organizationId: null` + `status: PENDING_CLAIM` filter guarantees we
    // never delete a row that some other tenant has already claimed or that
    // is in any state other than the transient PENDING_CLAIM the webhook
    // creates. If a sibling row exists in a different state the subsequent
    // update will fail on the `installationId @unique` constraint, surfacing
    // the conflict rather than silently corrupting another org's installation.
    await tx.gitHubInstallation.deleteMany({
      where: {
        installationId: newGithubInstallationId,
        id: { not: input.priorInstallationId },
        organizationId: null,
        status: GitHubInstallationStatus.PENDING_CLAIM,
      },
    });

    await tx.gitHubInstallation.update({
      where: { id: input.priorInstallationId },
      data: {
        installationId: newGithubInstallationId,
        status: GitHubInstallationStatus.ACTIVE,
        claimedAt: new Date(),
        claimedByUserId: input.userId,
        accountLogin: input.resolved.info.account.login,
        accountType: input.resolved.info.account.type,
        senderLogin: input.githubUser?.login ?? "oauth",
        senderId: String(input.githubUser?.id ?? 0),
        permissions: input.resolved.info.permissions,
        events: input.resolved.info.events,
        repositorySelection: input.resolved.info.repository_selection,
        // Any prior different-account confirmation is moot now.
        pendingNewInstallationId: null,
      },
    });

    await persistGitHubUserConnection(tx, {
      organizationId: input.organizationId,
      userId: input.userId,
      githubUser: input.githubUser,
      token: input.token,
      encryptedAccessToken: input.encryptedAccessToken,
      encryptedRefreshToken: input.encryptedRefreshToken,
      issuedAt: input.issuedAt,
    });

    const incomingByRepoId = new Set(
      input.repositories.map((repo) => repo.githubRepoId)
    );

    await Promise.all(
      input.repositories.map((repo) =>
        tx.gitHubInstallationRepository.upsert({
          where: {
            installationId_githubRepoId: {
              installationId: input.priorInstallationId,
              githubRepoId: repo.githubRepoId,
            },
          },
          create: {
            installationId: input.priorInstallationId,
            githubRepoId: repo.githubRepoId,
            fullName: repo.fullName,
            name: repo.name,
            owner: repo.owner,
            private: repo.private,
          },
          update: {
            fullName: repo.fullName,
            name: repo.name,
            owner: repo.owner,
            private: repo.private,
            removedAt: null,
          },
        })
      )
    );

    const existing = await tx.gitHubInstallationRepository.findMany({
      where: {
        installationId: input.priorInstallationId,
        removedAt: null,
      },
      select: { id: true, githubRepoId: true },
    });
    const tombstoneIds = existing
      .filter((row) => !incomingByRepoId.has(row.githubRepoId))
      .map((row) => row.id);
    if (tombstoneIds.length > 0) {
      await tx.gitHubInstallationRepository.updateMany({
        where: { id: { in: tombstoneIds } },
        data: { removedAt: new Date() },
      });
    }
  });

  log.info("[github/oauth] Reused prior installation in-place", {
    priorInstallationId: input.priorInstallationId,
    newGithubInstallationId,
    organizationId: input.organizationId,
    repositoryCount: input.repositories.length,
  });
}

/**
 * Detect and execute the same-account reconnect path, or surface a
 * pending-confirmation payload for the different-account path (PLN-634).
 * Returns `null` when no prior UNINSTALLED row exists for this org so the
 * caller falls through to the regular claim flow.
 */
async function tryReconnectExistingInstallation(input: {
  organizationId: string;
  userId: string;
  userAccessToken: string;
  githubUser: GitHubOAuthUser;
  token: GitHubOAuthToken;
  resolved: ResolvedInstallation;
}): Promise<OAuthCallbackResult | null> {
  const priorUninstalled = await withDb((db) =>
    db.gitHubInstallation.findFirst({
      where: {
        organizationId: input.organizationId,
        status: GitHubInstallationStatus.UNINSTALLED,
      },
    })
  );
  if (!priorUninstalled) {
    return null;
  }

  const newAccountId = String(input.resolved.info.account.id);
  const newInstallationId = String(input.resolved.id);
  const sameAccount = priorUninstalled.accountId === newAccountId;
  if (!sameAccount) {
    // Pin the candidate installation server-side so confirm-reset can't be
    // tricked into claiming an attacker-supplied installationId. A fresh
    // OAuth attempt simply overwrites the pinned value.
    await withDb((db) =>
      db.gitHubInstallation.update({
        where: { id: priorUninstalled.id },
        data: { pendingNewInstallationId: newInstallationId },
      })
    );
    log.info("[github/oauth] Detected different-account reconnect", {
      organizationId: input.organizationId,
      priorAccountId: priorUninstalled.accountId,
      newAccountId,
    });
    return {
      status: "requires_confirmation",
      priorAccount: {
        accountId: priorUninstalled.accountId,
        accountLogin: priorUninstalled.accountLogin,
      },
      newAccount: {
        accountId: newAccountId,
        accountLogin: input.resolved.info.account.login,
      },
      newInstallationId,
    };
  }

  const repositoriesResult = await fetchInstallationRepositories(
    input.userAccessToken,
    input.resolved.id
  );
  if (!repositoriesResult.ok) {
    return {
      status: "error",
      error: "Failed to fetch repositories from GitHub",
    };
  }
  const issuedAt = new Date();
  const { encryptedAccessToken, encryptedRefreshToken } =
    await encryptTokenPair(input.token.accessToken, input.token.refreshToken);
  await reconnectByAccount({
    priorInstallationId: priorUninstalled.id,
    resolved: input.resolved,
    organizationId: input.organizationId,
    userId: input.userId,
    githubUser: input.githubUser,
    token: input.token,
    encryptedAccessToken,
    encryptedRefreshToken,
    issuedAt,
    repositories: repositoriesResult.repositories,
  });
  return { status: "connected" };
}

/**
 * Exchange an OAuth authorization code for a user access token.
 */
async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
  config: { GITHUB_APP_CLIENT_ID: string; GITHUB_APP_CLIENT_SECRET: string }
): Promise<
  { success: true; token: GitHubOAuthToken } | { success: false; error: string }
> {
  const tokenResponse = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: config.GITHUB_APP_CLIENT_ID,
        client_secret: config.GITHUB_APP_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    }
  );

  if (!tokenResponse.ok) {
    log.error("[github/oauth] Failed to exchange code for token", {
      status: tokenResponse.status,
      statusText: tokenResponse.statusText,
    });
    return {
      success: false,
      error: "Failed to exchange authorization code for token",
    };
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: unknown;
    refresh_token_expires_in?: unknown;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (tokenData.error || !tokenData.access_token) {
    log.error("[github/oauth] Token exchange returned error", {
      error: tokenData.error,
      description: tokenData.error_description,
    });
    return {
      success: false,
      error: tokenData.error_description || "Failed to obtain access token",
    };
  }

  return {
    success: true,
    token: {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? null,
      expiresInSeconds: parseExpiresInSeconds(tokenData.expires_in),
      refreshTokenExpiresInSeconds: parseExpiresInSeconds(
        tokenData.refresh_token_expires_in
      ),
      scopes: parseOAuthScopes(tokenData.scope),
    },
  };
}

/**
 * Fetch the user's GitHub App installations and resolve which one to use.
 * When installationId is provided, verifies the user has access.
 * When absent (standard OAuth flow), picks from the user's installation list.
 */
export async function resolveInstallation(
  userAccessToken: string,
  installationId: string | undefined,
  userId: string
): Promise<
  | { success: true; id: number; info: GitHubRawInstallation }
  | { success: false; error: string }
> {
  const installationsResponse = await fetch(
    "https://api.github.com/user/installations",
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${userAccessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (!installationsResponse.ok) {
    log.error("[github/oauth] Failed to fetch user installations", {
      status: installationsResponse.status,
    });
    return { success: false, error: "Failed to verify installation access" };
  }

  const installationsData = (await installationsResponse.json()) as {
    installations?: GitHubRawInstallation[];
  };

  const userInstallations = installationsData.installations ?? [];

  if (installationId) {
    const targetId = Number.parseInt(installationId, 10);
    const match = userInstallations.find((inst) => inst.id === targetId);

    if (!match) {
      log.warn("[github/oauth] User does not have access to installation", {
        installationId,
        userId,
      });
      return {
        success: false,
        error: "You do not have access to this installation",
      };
    }

    return { success: true, id: targetId, info: match };
  }

  // Standard OAuth flow -- no installation_id in the callback
  if (userInstallations.length === 0) {
    log.warn("[github/oauth] No installations found for user", { userId });
    return {
      success: false,
      error:
        "No GitHub App installation found. Please install the GitHub App on your organization first.",
    };
  }

  const selected = userInstallations[0];

  if (userInstallations.length > 1) {
    // Multiple installations found. Pick the first one and rely on
    // validateInstallationClaim downstream to block cross-org claims.
    log.warn(
      "[github/oauth] Multiple installations found, using first. Use ?install=true for explicit selection.",
      {
        userId,
        installationCount: userInstallations.length,
        selectedInstallationId: selected.id,
      }
    );
  }

  return { success: true, id: selected.id, info: selected };
}

/**
 * GitHub integration service - handles all business logic and database operations
 */
export const githubService = {
  /**
   * Get the GitHub integration status for an organization.
   * Returns legacy App-installation status plus the additive GitHub data
   * connection predicate used by product-surface gating.
   */
  async getIntegrationStatus(
    organizationId: string,
    userId?: string | null
  ): Promise<GitHubIntegrationStatus> {
    const { githubDataConnection, installation } = await withDb(async (db) => {
      const installationResult = await db.gitHubInstallation.findFirst({
        where: {
          organizationId,
          status: {
            in: [
              GitHubInstallationStatus.ACTIVE,
              GitHubInstallationStatus.SUSPENDED,
            ],
          },
        },
        include: {
          repositories: { where: { removedAt: null } },
        },
      });
      const githubDataConnectionResult =
        await resolveGitHubDataConnectionStatus(db, {
          hasActiveInstallation:
            installationResult?.status === GitHubInstallationStatus.ACTIVE,
          organizationId,
          userId,
        });
      return {
        githubDataConnection: githubDataConnectionResult,
        installation: installationResult,
      };
    });

    if (!installation) {
      return {
        connected: false,
        githubDataConnection,
      };
    }

    return {
      connected: true,
      githubDataConnection,
      installation: {
        id: installation.id,
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        status: installation.status as ApiGitHubInstallationStatus,
        repositorySelection: installation.repositorySelection,
        repositoryCount: installation.repositories.length,
        claimedAt: installation.claimedAt?.toISOString() ?? null,
        createdAt: installation.createdAt.toISOString(),
      },
    };
  },

  /**
   * Complete the OAuth callback by exchanging code for user access token,
   * verifying user access to the installation, claiming the installation,
   * and syncing repositories.
   *
   * @param code - OAuth authorization code from GitHub
   * @param installationId - GitHub installation ID (as string from URL params), or undefined in standard OAuth flow
   * @param redirectUri - Must match the redirect_uri used in OAuth initiation
   * @param organizationId - Our organization ID to claim the installation
   * @param userId - User ID who is claiming the installation
   */
  async completeOAuthCallback(
    code: string,
    installationId: string | undefined,
    redirectUri: string,
    organizationId: string,
    userId: string
  ): Promise<OAuthCallbackResult> {
    try {
      const config = keys();

      // Exchange authorization code for user access token
      const tokenResult = await exchangeCodeForToken(code, redirectUri, config);
      if (!tokenResult.success) {
        return { status: "error", error: tokenResult.error };
      }
      const userAccessToken = tokenResult.token.accessToken;

      // Fetch the authenticated GitHub user's info (for sender fields if we create the record)
      const githubUser = await fetchRequiredGitHubUser(userAccessToken);

      // Resolve installation: verify the provided ID, or pick from user's list
      const resolved = await resolveInstallation(
        userAccessToken,
        installationId,
        userId
      );
      if (!resolved.success) {
        return { status: "error", error: resolved.error };
      }
      const resolvedInstallationId = resolved.id;

      // PLN-634: detect same-vs-different-account reconnect for orgs that
      // previously disconnected. `accountId` is the only stable identifier
      // across reinstalls (installationId churns; accountLogin is renameable).
      const reconnectResult = await tryReconnectExistingInstallation({
        organizationId,
        userId,
        userAccessToken,
        githubUser,
        token: tokenResult.token,
        resolved,
      });
      if (reconnectResult) {
        return reconnectResult;
      }

      // Find the installation record, or create it if the webhook hasn't arrived yet
      // This handles the race condition where OAuth callback arrives before webhook
      let installation = await this.findInstallationByInstallationId(
        String(resolvedInstallationId)
      );

      if (!installation) {
        log.info(
          "[github/oauth] Installation record not found, creating from GitHub API data",
          { installationId: resolvedInstallationId }
        );

        try {
          installation = await withDb((db) =>
            db.gitHubInstallation.create({
              data: {
                installationId: String(resolvedInstallationId),
                accountId: String(resolved.info.account.id),
                accountLogin: resolved.info.account.login,
                accountType: resolved.info.account.type,
                senderLogin: githubUser.login,
                senderId: String(githubUser.id),
                status: GitHubInstallationStatus.PENDING_CLAIM,
                permissions: resolved.info.permissions,
                events: resolved.info.events,
                repositorySelection: resolved.info.repository_selection,
              },
            })
          );
        } catch (error) {
          if (getPrismaErrorCode(error) !== "P2002") {
            throw error;
          }
          const racedInstallation = await this.findInstallationByInstallationId(
            String(resolvedInstallationId)
          );
          if (!racedInstallation) {
            throw error;
          }
          installation = racedInstallation;
        }

        log.info(
          "[github/oauth] Resolved installation record from OAuth flow",
          {
            installationId: installation.id,
            githubInstallationId: resolvedInstallationId,
          }
        );
      }

      // Security check: Block claim if installation is already owned by a different org
      const claimError = validateInstallationClaim(
        installation,
        organizationId
      );
      if (claimError) {
        log.warn(
          "[github/oauth] Attempted to claim installation already owned by another org",
          {
            installationId,
            existingOrgId: installation.organizationId,
            attemptedOrgId: organizationId,
            userId,
          }
        );
        return { status: "error", error: claimError };
      }

      const issuedAt = new Date();
      const { encryptedAccessToken, encryptedRefreshToken } =
        await encryptTokenPair(
          tokenResult.token.accessToken,
          tokenResult.token.refreshToken
        );
      let claimResultCount = 0;

      try {
        // Claim the installation and persist user OAuth identity in one
        // transaction so upsert failures cannot leave a partial claim.
        claimResultCount =
          await claimInstallationAndPersistGitHubUserConnection({
            installationRecordId: installation.id,
            organizationId,
            userId,
            githubUser,
            token: tokenResult.token,
            encryptedAccessToken,
            encryptedRefreshToken,
            issuedAt,
          });
      } catch (error) {
        log.error("[github/oauth] Failed to persist GitHub user connection", {
          installationId,
          organizationId,
          userId,
          error: parseError(error),
        });
        return {
          status: "error",
          error: "Failed to complete GitHub connection",
        };
      }

      if (claimResultCount !== 1) {
        log.warn(
          "[github/oauth] Installation ownership changed before claim completed",
          {
            installationId,
            attemptedOrgId: organizationId,
            userId,
          }
        );
        return {
          status: "error",
          error:
            "This GitHub installation is already connected to another organization",
        };
      }
      const repositoriesResult = await fetchInstallationRepositories(
        userAccessToken,
        resolvedInstallationId
      );
      if (!repositoriesResult.ok) {
        emitRepositoryArtifactRelinkFailedMetric(
          RepositoryArtifactRelinkFailureStage.OAuthClaim,
          repositoriesResult.error
        );
      } else if (repositoriesResult.repositories.length > 0) {
        await this.syncRepositories(
          installation.id,
          repositoriesResult.repositories
        );
      }

      log.info("[github/oauth] Successfully connected GitHub installation", {
        installationId: resolvedInstallationId,
        organizationId,
        userId,
      });

      return { status: "connected" };
    } catch (error) {
      log.error("[github/oauth] Failed to complete OAuth callback", {
        installationId,
        organizationId,
        userId,
        error: parseError(error),
      });
      return {
        status: "error",
        error: "Failed to complete GitHub connection",
      };
    }
  },
  /**
   * Create or update a GitHubInstallation record.
   * Uses upsert by installationId.
   */
  upsertInstallation(
    installationId: string,
    data: {
      accountId: string;
      accountLogin: string;
      accountType: string;
      senderLogin: string;
      senderId: string;
      status?: GitHubInstallationStatus;
      permissions?: unknown;
      events?: unknown;
      repositorySelection?: string;
      organizationId?: string;
    }
  ): Promise<GitHubInstallation> {
    return withDb((db) =>
      db.gitHubInstallation.upsert({
        where: { installationId },
        create: {
          installationId,
          accountId: data.accountId,
          accountLogin: data.accountLogin,
          accountType: data.accountType,
          senderLogin: data.senderLogin,
          senderId: data.senderId,
          status: data.status ?? "PENDING_CLAIM",
          permissions: data.permissions ?? undefined,
          events: data.events ?? undefined,
          repositorySelection: data.repositorySelection,
          organizationId: data.organizationId,
        },
        update: {
          accountId: data.accountId,
          accountLogin: data.accountLogin,
          accountType: data.accountType,
          senderLogin: data.senderLogin,
          senderId: data.senderId,
          status: data.status,
          permissions: data.permissions ?? undefined,
          events: data.events ?? undefined,
          repositorySelection: data.repositorySelection,
          organizationId: data.organizationId,
        },
      })
    );
  },

  /**
   * Update the status field of a GitHubInstallation.
   */
  async updateInstallationStatus(
    installationId: string,
    status: GitHubInstallationStatus,
    metadata?: {
      suspendedAt?: Date | null;
      suspendedBy?: string | null;
      claimedAt?: Date | null;
      claimedByUserId?: string | null;
    }
  ): Promise<GitHubInstallation> {
    try {
      const installation = await withDb((db) =>
        db.gitHubInstallation.update({
          where: { id: installationId },
          data: {
            status,
            ...metadata,
          },
        })
      );

      log.info("[github] Updated installation status", {
        installationId,
        status,
        organizationId: installation.organizationId,
      });

      return installation;
    } catch (error) {
      log.error("[github] Failed to update installation status", {
        installationId,
        status,
        error: parseError(error),
      });
      throw error;
    }
  },

  /**
   * Relink stale Branch View rows to the active credential repository chosen
   * by the resolver, then let callers reload a pinned-active context before
   * running any provider-backed sync writes.
   */
  async relinkBranchViewRepositoryCredential(input: {
    organizationId: string;
    activeRepositoryId: string;
  }): Promise<RepositoryArtifactRelinkResult> {
    const activeRepository = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: {
          id: input.activeRepositoryId,
          removedAt: null,
          installation: {
            organizationId: input.organizationId,
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
        select: {
          id: true,
          githubRepoId: true,
          fullName: true,
          installationId: true,
        },
      })
    );
    if (!activeRepository) {
      return createRepositoryArtifactRelinkResult({
        reasons: [RepositoryArtifactRelinkReason.NoActiveRepositories],
      });
    }

    return await runRepositoryArtifactRelink({
      installationId: activeRepository.installationId,
      repositories: [activeRepository],
      expectedOrganizationId: input.organizationId,
      failureStage: RepositoryArtifactRelinkFailureStage.SyncPreflightRelink,
    });
  },

  /**
   * Sync repositories for an installation.
   * Uses upsert to preserve record IDs and tombstones repos no longer in the
   * active installation grant so historical projection FKs stay resolvable.
   */
  syncRepositories(
    installationId: string,
    repositories: RepositoryInput[]
  ): Promise<GitHubInstallationRepository[]> {
    return withDb
      .tx(async (tx) => {
        // Get the set of GitHub repo IDs we're syncing
        const incomingRepoIds = new Set(
          repositories.map((r) => r.githubRepoId)
        );

        await tx.gitHubInstallationRepository.updateMany({
          where: {
            installationId,
            githubRepoId: { notIn: [...incomingRepoIds] },
            removedAt: null,
          },
          data: {
            removedAt: new Date(),
          },
        });

        if (repositories.length === 0) {
          return [];
        }

        // Upsert each repository to preserve IDs. `removedAt: null` clears
        // any tombstone left from a previous disconnect/reconnect window
        // (PLN-634); without this, a re-added repo would stay invisible.
        await Promise.all(
          repositories.map((repo) =>
            tx.gitHubInstallationRepository.upsert({
              where: {
                installationId_githubRepoId: {
                  installationId,
                  githubRepoId: repo.githubRepoId,
                },
              },
              create: {
                installationId,
                githubRepoId: repo.githubRepoId,
                fullName: repo.fullName,
                name: repo.name,
                owner: repo.owner,
                private: repo.private,
              },
              update: {
                fullName: repo.fullName,
                name: repo.name,
                owner: repo.owner,
                private: repo.private,
                removedAt: null,
              },
            })
          )
        );

        const syncedRepositories =
          await tx.gitHubInstallationRepository.findMany({
            where: { installationId, removedAt: null },
          });
        return syncedRepositories;
      })
      .then(async (syncedRepositories) => {
        if (syncedRepositories.length > 0) {
          await runRepositoryArtifactRelink({
            installationId,
            repositories: syncedRepositories,
            failureStage: RepositoryArtifactRelinkFailureStage.SyncRepositories,
          });
        }
        return syncedRepositories;
      });
  },

  /**
   * Add repositories to an installation (without removing existing ones).
   * Uses upsert to handle duplicates gracefully.
   */
  async addRepositories(
    installationId: string,
    repositories: RepositoryInput[]
  ): Promise<GitHubInstallationRepository[]> {
    if (repositories.length === 0) {
      log.info("[github] No repositories to add");
      return [];
    }

    const result = await withDb.tx(async (tx) => {
      // Upsert each repository (creates if not exists, updates if exists).
      // `removedAt: null` clears any tombstone left from a previous
      // disconnect/reconnect window (PLN-634).
      await Promise.all(
        repositories.map((repo) =>
          tx.gitHubInstallationRepository.upsert({
            where: {
              installationId_githubRepoId: {
                installationId,
                githubRepoId: repo.githubRepoId,
              },
            },
            create: {
              installationId,
              githubRepoId: repo.githubRepoId,
              fullName: repo.fullName,
              name: repo.name,
              owner: repo.owner,
              private: repo.private,
            },
            update: {
              fullName: repo.fullName,
              name: repo.name,
              owner: repo.owner,
              private: repo.private,
              removedAt: null,
            },
          })
        )
      );

      const githubRepoIds = repositories.map((r) => r.githubRepoId);
      const addedRepositories = await tx.gitHubInstallationRepository.findMany({
        where: {
          installationId,
          githubRepoId: { in: githubRepoIds },
        },
      });
      return addedRepositories;
    });

    await runRepositoryArtifactRelink({
      installationId,
      repositories: result,
      failureStage: RepositoryArtifactRelinkFailureStage.AddRepositories,
    });

    log.info("[github] Added repositories", {
      installationId,
      count: result.length,
    });

    return result;
  },

  /**
   * Find a GitHubInstallation by our internal id.
   */
  findInstallationById(id: string): Promise<GitHubInstallation | null> {
    return withDb((db) =>
      db.gitHubInstallation.findUnique({
        where: { id },
        include: {
          repositories: true,
        },
      })
    );
  },

  /**
   * Find a GitHubInstallation by GitHub's installationId.
   */
  findInstallationByInstallationId(
    installationId: string
  ): Promise<GitHubInstallation | null> {
    return withDb((db) =>
      db.gitHubInstallation.findUnique({
        where: { installationId },
        include: {
          repositories: true,
        },
      })
    );
  },

  /**
   * Find the GitHub installationId for a repository fullName owned by an organization.
   * Skips tombstoned repos (PLN-634) so dispatch never targets a removed repo.
   */
  async findInstallationForRepoFullName(
    organizationId: string,
    fullName: string
  ): Promise<string | null> {
    const repository = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: {
          fullName,
          removedAt: null,
          installation: {
            organizationId,
            status: ApiGitHubInstallationStatusValue.Active,
          },
        },
        select: {
          installation: {
            select: {
              installationId: true,
            },
          },
        },
      })
    );

    return repository?.installation.installationId ?? null;
  },

  /**
   * Tombstone GitHubInstallationRepository records by githubRepoId.
   * Used when repositories are removed from an installation. Rows are
   * preserved so historical PR/branch records and pending dirty-scope nudges
   * keep a resolvable repository identity.
   */
  async removeRepositories(
    installationId: string,
    githubRepoIds: string[]
  ): Promise<void> {
    if (githubRepoIds.length === 0) {
      log.info("[github] No repositories to remove");
      return;
    }

    await withDb((db) =>
      db.gitHubInstallationRepository.updateMany({
        where: {
          installationId,
          githubRepoId: { in: githubRepoIds },
          removedAt: null,
        },
        data: {
          removedAt: new Date(),
        },
      })
    );

    log.info("[github] Tombstoned repositories", {
      installationId,
      count: githubRepoIds.length,
      githubRepoIds,
    });
  },

  /**
   * Disconnect an installation from an organization.
   *
   * Marks the installation UNINSTALLED but preserves `organizationId` so a
   * subsequent reconnect from the same GitHub account can reuse the row
   * in-place (see `reconnectByAccount`). Without preservation, the cascade
   * chain GitHubInstallation → GitHubInstallationRepository → TeamRepository
   * (and BranchDetail / PullRequestDetail) would destroy org-level repo
   * configuration and branch/PR history on every disconnect.
   *
   * Idempotent because Settings may send a DELETE from stale cached UI after
   * another tab, webhook, or local repair has already disconnected.
   */
  async disconnectInstallation(organizationId: string): Promise<void> {
    const installation = await withDb((db) =>
      db.gitHubInstallation.findFirst({
        where: { organizationId },
      })
    );

    if (!installation) {
      log.info("[github] No installation found to disconnect", {
        organizationId,
      });
      return;
    }

    const leaseResult = await withDb((db) =>
      db.gitHubInstallation.updateMany({
        where: { id: installation.id, organizationId },
        data: { status: GitHubInstallationStatus.UNINSTALLED },
      })
    );
    if (leaseResult.count !== 1) {
      log.warn("[github] Skipped disconnect because ownership changed", {
        installationId: installation.id,
        githubInstallationId: installation.installationId,
        organizationId,
      });
      return;
    }

    // Uninstall from GitHub only after the org-scoped local transition wins.
    const result = await deleteInstallation(installation.installationId);

    if (!result.success) {
      log.warn(
        "[github] Failed to uninstall from GitHub, continuing with local disconnect",
        {
          installationId: installation.installationId,
          error: result.error,
        }
      );
      // Continue anyway - we've marked UNINSTALLED locally.
    }

    log.info("[github] Disconnected and uninstalled", {
      installationId: installation.id,
      githubInstallationId: installation.installationId,
      organizationId,
      uninstalledFromGitHub: result.success,
    });
  },

  /**
   * Confirm and execute the different-account reset (PLN-634 Phase 3).
   *
   * Runs once the admin has confirmed the destructive cleanup that swaps the
   * org from GitHub account A to account B. Side effects, all in one
   * transaction:
   *  - Delete `TeamRepository` rows for every team in the org.
   *  - Tombstone `GitHubInstallationRepository` rows owned by the prior
   *    installation. Branch / PR repository FKs remain non-null, so old
   *    repository rows stay FK-resolvable while render recovery and explicit
   *    relink paths restore visibility through a live installation generation.
   *  - Clear `organizationId` on the prior `GitHubInstallation` row to
   *    release the `@unique` slot. The row remains in the DB as an orphan.
   *  - Claim the new installation row for the org (mark ACTIVE).
   *  - Wipe `Project.settings.repositoryOverrides` for every project in the
   *    org.
   *  - Emit an audit log line with prior/new account ids and counts.
   *
   * `RepoBootstrapConfig` is intentionally left in place per Q-002 — it is
   * keyed by fullName and degrades naturally if the repo isn't present in
   * the new account.
   */
  confirmDifferentAccountReset(input: {
    organizationId: string;
    userId: string;
  }): Promise<Result<{ confirmed: true }>> {
    return withDb.tx<Result<{ confirmed: true }>>(async (tx) => {
      const prior = await tx.gitHubInstallation.findFirst({
        where: {
          organizationId: input.organizationId,
          status: GitHubInstallationStatus.UNINSTALLED,
        },
      });
      if (!prior) {
        log.warn("[github/reset] No prior UNINSTALLED installation found", {
          organizationId: input.organizationId,
        });
        return Result.err(Status.BadRequest);
      }
      // Read the installation to claim from the prior row, not from the
      // request body. The OAuth callback pins this value when it detects the
      // mismatch, so a phished admin posting a crafted body cannot redirect
      // the claim to an attacker-owned installation.
      if (!prior.pendingNewInstallationId) {
        log.warn(
          "[github/reset] No pending new installation pinned on prior row",
          {
            organizationId: input.organizationId,
            priorInstallationId: prior.id,
          }
        );
        return Result.err(Status.BadRequest);
      }

      const newInstall = await tx.gitHubInstallation.findUnique({
        where: { installationId: prior.pendingNewInstallationId },
      });
      if (!newInstall) {
        log.warn("[github/reset] Pinned new installation not found", {
          organizationId: input.organizationId,
          pendingNewInstallationId: prior.pendingNewInstallationId,
        });
        return Result.err(Status.BadRequest);
      }
      if (newInstall.accountId === prior.accountId) {
        log.warn(
          "[github/reset] Reset called with same-account install; reject",
          {
            organizationId: input.organizationId,
            accountId: prior.accountId,
          }
        );
        return Result.err(Status.BadRequest);
      }
      if (
        newInstall.organizationId &&
        newInstall.organizationId !== input.organizationId
      ) {
        log.warn(
          "[github/reset] New installation already claimed by another org",
          {
            organizationId: input.organizationId,
            newInstallationOrgId: newInstall.organizationId,
          }
        );
        return Result.err(Status.Forbidden);
      }

      const teamReposDeleted = await tx.teamRepository.deleteMany({
        where: { team: { organizationId: input.organizationId } },
      });

      // Tombstone all repos previously linked to this installation row.
      // `installationId` here is the FK to GitHubInstallation.id (UUID),
      // not the GitHub App installation ID string.
      await tx.gitHubInstallationRepository.updateMany({
        where: { installationId: prior.id, removedAt: null },
        data: { removedAt: new Date() },
      });

      // Releasing the @unique(organizationId) slot must happen before we
      // claim the new row for the same org. Clearing pendingNewInstallationId
      // here prevents a second confirm-reset call from re-firing this flow.
      await tx.gitHubInstallation.update({
        where: { id: prior.id },
        data: { organizationId: null, pendingNewInstallationId: null },
      });

      await tx.gitHubInstallation.update({
        where: { id: newInstall.id },
        data: {
          organizationId: input.organizationId,
          status: GitHubInstallationStatus.ACTIVE,
          claimedAt: new Date(),
          claimedByUserId: input.userId,
        },
      });

      // Sibling-service call — joins the outer transaction via
      // AsyncLocalStorage so the wipe is atomic with the installation swap.
      const projectsCleared =
        await projectsService.clearRepositorySettingsForOrganization(
          input.organizationId
        );

      log.info("[github/reset] Different-account reset completed", {
        organizationId: input.organizationId,
        userId: input.userId,
        priorAccountId: prior.accountId,
        priorAccountLogin: prior.accountLogin,
        newAccountId: newInstall.accountId,
        newAccountLogin: newInstall.accountLogin,
        priorInstallationId: prior.id,
        newInstallationId: newInstall.id,
        teamRepositoriesDeleted: teamReposDeleted.count,
        projectsWithOverridesCleared: projectsCleared,
      });

      return Result.ok({ confirmed: true as const });
    });
  },

  /**
   * Get repositories for an organization's GitHub installation.
   * Returns active repositories associated with the installation.
   * Tombstoned rows (PLN-634) are filtered out so they no longer appear in
   * pickers or pool queries, while remaining FK-resolvable for branch/PR
   * history.
   *
   * @param organizationId - Organization ID to scope the query
   * @param orderBy - Optional sort order (default: lastPushedAt desc with nulls last, then name asc)
   */
  async getRepositories(
    organizationId: string,
    orderBy?: Array<{
      lastPushedAt?: { sort: "asc" | "desc"; nulls?: "first" | "last" };
      name?: "asc" | "desc";
    }>
  ): Promise<GitHubInstallationRepository[]> {
    const installation = await withDb((db) =>
      db.gitHubInstallation.findFirst({
        where: {
          organizationId,
          status: ApiGitHubInstallationStatusValue.Active,
        },
        include: {
          repositories: {
            where: { removedAt: null },
            orderBy: orderBy ?? [
              { lastPushedAt: { sort: "desc", nulls: "last" } },
              { name: "asc" },
            ],
          },
        },
      })
    );

    if (!installation) {
      return [];
    }

    return installation.repositories;
  },

  /**
   * Get branches for a GitHub repository.
   * Fetches installation-backed repos via GitHub GraphQL and falls back to the
   * public-repository store for repos added without an installation.
   *
   * @param repositoryId - Internal UUID of GitHubInstallationRepository
   * @param organizationId - Organization ID for authorization
   * @param limit - Maximum number of branches to return (default: 20)
   * @param allowPublicFallback - When false, a non-installation (public)
   *   repository id is treated as not found instead of resolving via the
   *   public-repository store. User-facing callers pass the
   *   `public-github-repos` flag here so a bookmarked/cached public repo id
   *   cannot reach the dark-launched public path outside the rollout (FEA-2764).
   */
  async getBranches(
    repositoryId: string,
    organizationId: string,
    limit = 20,
    allowPublicFallback = true
  ): Promise<GetBranchesResponse> {
    // Look up the repository and its installation
    const repository = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: {
          id: repositoryId,
        },
        include: {
          installation: true,
        },
      })
    );

    if (!repository) {
      if (!allowPublicFallback) {
        // Fail closed: mirror an unknown repository id so the public-repo path
        // stays unreachable when the flag is disabled for this principal.
        throw new Error("Repository not found");
      }
      return publicRepositoryService.getBranches(
        repositoryId,
        organizationId,
        limit
      );
    }

    // Verify organization ownership
    if (repository.installation.organizationId !== organizationId) {
      throw new Error("Repository does not belong to organization");
    }

    assertActiveGitHubRepository(repository);

    const [owner, name] = repository.fullName.split("/");

    if (!(owner && name)) {
      throw new Error("Invalid repository fullName format");
    }

    try {
      const branches = await getRepositoryBranches(
        repository.installation.installationId,
        owner,
        name,
        limit
      );

      return { branches };
    } catch (error) {
      log.error("[github/service] Failed to fetch branches", {
        repositoryId,
        fullName: repository.fullName,
        error: parseError(error),
      });
      throw new Error("Failed to fetch branches from GitHub");
    }
  },

  /**
   * Fetch pull requests from GitHub for a repository.
   * Also returns which PR URLs are already tracked as ExternalLinks in the given project.
   */
  async getPullRequests(
    repositoryId: string,
    organizationId: string,
    projectId: string | null,
    options?: { limit?: number }
  ): Promise<GetPullRequestsResponse> {
    const repository = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: { id: repositoryId },
        include: { installation: true },
      })
    );

    if (!repository) {
      throw new Error("Repository not found");
    }

    if (repository.installation.organizationId !== organizationId) {
      throw new Error("Repository does not belong to organization");
    }

    assertActiveGitHubRepository(repository);

    const [owner, name] = repository.fullName.split("/");

    if (!(owner && name)) {
      throw new Error("Invalid repository fullName format");
    }

    try {
      const tracked = await getTrackedPullRequestState({
        organizationId,
        projectId,
        repositoryFullName: repository.fullName,
        repositoryId: repository.id,
      });
      const targetNumbers = tracked.trackedPrNumbers;
      const pullRequests = await getRepositoryPullRequestsWithMetadata(
        repository.installation.installationId,
        owner,
        name,
        {
          state: "all",
          limit: options?.limit ?? 30,
          maxItems:
            targetNumbers.length > 0
              ? TARGET_PULL_REQUEST_MAX_ITEMS
              : undefined,
          maxPages:
            targetNumbers.length > 0
              ? TARGET_PULL_REQUEST_MAX_PAGES
              : undefined,
          targetNumbers,
        }
      );

      return {
        pullRequests: pullRequests.pullRequests,
        hasMore: pullRequests.hasMore,
        truncated: pullRequests.truncated,
        pageInfo: pullRequests.pageInfo,
        stopReason: pullRequests.stopReason,
        missingTargetNumbers: pullRequests.missingTargetNumbers,
        trackedPrUrls: tracked.trackedPrUrls,
        trackedBranches: tracked.trackedBranches,
        trackedBranchKeys: tracked.trackedBranchKeys,
      };
    } catch (error) {
      log.error("[github/service] Failed to fetch pull requests", {
        repositoryId,
        organizationId,
        error: parseError(error),
      });
      throw new Error("Failed to fetch pull requests from GitHub");
    }
  },

  /**
   * Fetch contributors aggregated across all connected repositories for an organization.
   * Deduplicates contributors by GitHub login, summing contribution counts across
   * all repositories the contributor appears in.
   */
  async getContributorsAcrossRepos(
    organizationId: string,
    options?: { maxRepos?: number; perRepoLimit?: number }
  ): Promise<GetContributorsResponse> {
    const maxRepos = options?.maxRepos ?? 10;
    const perRepoLimit = options?.perRepoLimit ?? 30;

    const installation = await withDb((db) =>
      db.gitHubInstallation.findFirst({
        where: { organizationId, status: GitHubInstallationStatus.ACTIVE },
        include: {
          repositories: {
            where: { removedAt: null },
            orderBy: [
              { lastPushedAt: { sort: "desc", nulls: "last" } },
              { name: "asc" },
            ],
            take: maxRepos,
          },
        },
      })
    );

    if (!installation || installation.repositories.length === 0) {
      return { contributors: [] };
    }

    const installationId = installation.installationId;

    const perRepoResults = await Promise.all(
      installation.repositories.map((repo) =>
        getRepositoryContributors(installationId, repo.owner, repo.name, {
          perPage: perRepoLimit,
        })
      )
    );

    const byLogin = new Map<string, GitHubContributor>();
    for (const list of perRepoResults) {
      for (const contributor of list) {
        const existing = byLogin.get(contributor.login);
        if (!existing) {
          byLogin.set(contributor.login, contributor);
          continue;
        }
        byLogin.set(contributor.login, {
          login: contributor.login,
          avatarUrl: existing.avatarUrl || contributor.avatarUrl,
          contributions: existing.contributions + contributor.contributions,
          htmlUrl: existing.htmlUrl || contributor.htmlUrl,
        });
      }
    }

    const contributors = [...byLogin.values()].sort(
      (a, b) => b.contributions - a.contributions
    );

    return { contributors };
  },
};

type ActiveGitHubRepositoryInput = {
  removedAt: Date | null;
  installation: {
    status: GitHubInstallationStatus;
  };
};

function assertActiveGitHubRepository(
  repository: ActiveGitHubRepositoryInput
): void {
  if (
    repository.removedAt !== null ||
    repository.installation.status !== GitHubInstallationStatus.ACTIVE
  ) {
    throw new Error("Repository not found");
  }
}

async function getTrackedPullRequestState(input: {
  organizationId: string;
  projectId: string | null;
  repositoryFullName: string;
  repositoryId: string;
}): Promise<{
  trackedPrUrls: string[];
  trackedBranches: NonNullable<GetPullRequestsResponse["trackedBranches"]>;
  trackedBranchKeys: string[];
  trackedPrNumbers: number[];
}> {
  if (!input.projectId) {
    return {
      trackedPrUrls: [],
      trackedBranches: [],
      trackedBranchKeys: [],
      trackedPrNumbers: [],
    };
  }

  const existingBranches = await withDb((db) =>
    db.artifact.findMany({
      where: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        type: ArtifactType.BRANCH,
        branch: { repositoryId: input.repositoryId },
      },
      select: {
        externalUrl: true,
        branch: {
          select: {
            branchName: true,
            currentPullRequestDetail: {
              select: { htmlUrl: true },
            },
          },
        },
      },
    })
  );

  const trackedBranches = existingBranches.flatMap((artifact) => {
    if (!artifact.branch) {
      return [];
    }
    const branchKey = `${input.repositoryFullName}:${artifact.branch.branchName}`;
    return [
      {
        branchName: artifact.branch.branchName,
        branchKey,
        htmlUrl: artifact.externalUrl ?? "",
        pullRequestUrl:
          artifact.branch.currentPullRequestDetail?.htmlUrl ?? null,
      },
    ];
  });
  const trackedPrUrls = trackedBranches.flatMap((branch) =>
    branch.pullRequestUrl ? [branch.pullRequestUrl] : []
  );
  return {
    trackedPrUrls,
    trackedBranches,
    trackedBranchKeys: trackedBranches.map((branch) => branch.branchKey),
    trackedPrNumbers: extractTrackedPullRequestNumbers(
      input.repositoryFullName,
      trackedPrUrls
    ),
  };
}

function extractTrackedPullRequestNumbers(
  repositoryFullName: string,
  trackedPrUrls: readonly string[]
): number[] {
  const seen = new Set<number>();
  const numbers: number[] = [];
  for (const url of trackedPrUrls) {
    const parsed = parseGitHubPullRequestUrl(url);
    if (parsed?.fullName !== repositoryFullName || seen.has(parsed.number)) {
      continue;
    }
    seen.add(parsed.number);
    numbers.push(parsed.number);
  }
  return numbers;
}
