import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  type BranchViewPrLifecycleRepair,
  BranchViewPrLifecycleRepairStatus,
} from "@repo/api/src/types/branch-view";
import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubFetchTrigger } from "@repo/api/src/types/github-read-model";
import {
  ArtifactType,
  GitHubInstallationStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { getSinglePullRequest } from "@repo/github";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import pLimit from "p-limit";
import { getPrismaErrorCode } from "@/lib/db-utils";
import {
  gitHubFetchProvenanceData,
  githubAppRestFetchProvenance,
} from "@/lib/github-fetch-provenance";
import {
  buildBranchTreeUrl,
  type GitHubPullRequestLifecycle,
  refreshPullRequestLifecycle,
} from "./pr-lifecycle-refresh";

const STALENESS_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const DEBOUNCE_WINDOW_MS = 60 * 60 * 1000;
const CLIENT_PENDING_WINDOW_MS = 30 * 1000;

/**
 * Cap on in-flight per-link repairs. Each repair issues a GitHub REST call plus
 * a DB transaction, so this bounds GitHub rate-limit and pg connection-pool
 * pressure while still collapsing the sequential N×round-trip latency. Mirrors
 * the parallel-import cap in apps/api/app/integrations/google/service.ts.
 */
const PR_READ_REPAIR_CONCURRENCY = 5;

/**
 * Shape used as input to the read-repair pass. Callers derive this from
 * `PullRequestDetail` rows (joined with their parent Artifact) — no more
 * ExternalLink / ExternalLink.metadata after the artifact cutover.
 */
export type PrReadRepairInput = {
  /** Branch artifact id that owns the current PullRequestDetail. */
  id: string;
  /** GitHub pull request URL — used to reach the GitHub REST API. */
  externalUrl: string;
  /** Parent artifact's projectId — used when backfilling a missing detail row. */
  projectId: string | null;
  /** Parent artifact's organizationId. */
  organizationId: string;
  /** PullRequestDetail.prState — used to filter "already merged" rows out. */
  prState: GitHubPRState;
  /** PullRequestDetail.lastVerifiedAt. */
  lastVerifiedAt: Date | null;
  /** PullRequestDetail.lastRefreshAttemptAt. */
  lastRefreshAttemptAt: Date | null;
};

export type PrReadRepairFreshnessInput = Pick<
  PrReadRepairInput,
  "lastRefreshAttemptAt" | "lastVerifiedAt" | "prState"
>;

/**
 * Schedule a background read-repair pass for stale PR artifacts.
 * Synchronous — fires via waitUntil so it does not block the caller.
 */
export function schedulePrReadRepair(
  inputs: PrReadRepairInput[],
  organizationId: string,
  nowMs = Date.now()
): void {
  if (inputs.length === 0) {
    return;
  }

  const eligible = inputs.filter((input) =>
    isPrReadRepairEligible(input, nowMs)
  );

  if (eligible.length === 0) {
    return;
  }

  waitUntil(
    runPrReadRepair(eligible, organizationId).catch((error) => {
      log.warn("[pr-read-repair] Background repair failed", {
        error,
        organizationId,
      });
    })
  );
}

/**
 * Derive the shared Branch View repair signal from the same freshness gates
 * used by `schedulePrReadRepair`.
 */
export function getPrReadRepairStatus(
  input: PrReadRepairFreshnessInput,
  nowMs = Date.now()
): BranchViewPrLifecycleRepair["status"] {
  return shouldExposePrReadRepairPending(input, nowMs)
    ? BranchViewPrLifecycleRepairStatus.Pending
    : BranchViewPrLifecycleRepairStatus.Idle;
}

/**
 * Whether a new background repair should be enqueued now.
 *
 * This intentionally differs from the client-visible pending status: a recent
 * attempt is debounced for scheduling but remains briefly pending so React Query
 * can observe the background repair result.
 */
export function isPrReadRepairEligible(
  input: PrReadRepairFreshnessInput,
  nowMs = Date.now()
): boolean {
  if (!needsPrReadRepairStateCheck(input, nowMs)) {
    return false;
  }

  const lastAttempt = input.lastRefreshAttemptAt
    ? input.lastRefreshAttemptAt.getTime()
    : null;
  if (lastAttempt !== null && nowMs - lastAttempt < DEBOUNCE_WINDOW_MS) {
    return false;
  }

  return true;
}

function shouldExposePrReadRepairPending(
  input: PrReadRepairFreshnessInput,
  nowMs: number
): boolean {
  if (!needsPrReadRepairStateCheck(input, nowMs)) {
    return false;
  }

  const lastAttempt = input.lastRefreshAttemptAt
    ? input.lastRefreshAttemptAt.getTime()
    : null;
  if (lastAttempt !== null) {
    return nowMs - lastAttempt < CLIENT_PENDING_WINDOW_MS;
  }

  return true;
}

function needsPrReadRepairStateCheck(
  input: PrReadRepairFreshnessInput,
  nowMs: number
): boolean {
  const neverVerified = !input.lastVerifiedAt;
  const needsStateCheck =
    input.prState !== GitHubPRState.Merged || neverVerified;
  if (!needsStateCheck) {
    return false;
  }

  const lastVerified = input.lastVerifiedAt
    ? input.lastVerifiedAt.getTime()
    : null;
  if (lastVerified !== null && nowMs - lastVerified < STALENESS_THRESHOLD_MS) {
    return false;
  }

  return true;
}

const PR_URL_REGEX = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

/**
 * Resolve the GitHub App installationId for a PR artifact id.
 *
 * Primary: look up via the PullRequestDetail's repository.
 * Fallback: use the org's single active installation.
 * Returns a blocked result when a stored repository exists but is no longer an
 * active GitHub source. Legacy rows with no stored repository context can still
 * fall back to the org's single active installation.
 */
async function resolveInstallationId(
  branchArtifactId: string,
  organizationId: string
): Promise<InstallationResolution> {
  const prRow = await withDb((db) =>
    db.pullRequestDetail.findFirst({
      where: {
        OR: [{ artifactId: branchArtifactId }, { branchArtifactId }],
        branchArtifact: { organizationId },
        repository: { installation: { organizationId } },
      },
      select: { repositoryId: true },
    })
  );

  // FEA-2732: hoist to a local const so the non-null narrowing survives into
  // the withDb closure (repositoryId is nullable for repo-less PRs).
  const resolvedRepositoryId = prRow?.repositoryId;
  if (resolvedRepositoryId) {
    const repoRow = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: {
          id: resolvedRepositoryId,
          removedAt: null,
          installation: {
            organizationId,
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
        select: { installation: { select: { installationId: true } } },
      })
    );

    if (repoRow?.installation?.installationId) {
      return {
        blockedByInactiveRepository: false,
        installationId: repoRow.installation.installationId,
      };
    }
    return { blockedByInactiveRepository: true, installationId: null };
  }

  // Fallback: org's single active installation
  const installations = await withDb((db) =>
    db.gitHubInstallation.findMany({
      where: { organizationId, status: GitHubInstallationStatus.ACTIVE },
      select: { installationId: true },
    })
  );

  if (installations.length !== 1) {
    log.warn(
      "[pr-read-repair] Cannot resolve installationId — expected exactly 1 active installation",
      {
        branchArtifactId,
        organizationId,
        count: installations.length,
      }
    );
    return { blockedByInactiveRepository: false, installationId: null };
  }

  return {
    blockedByInactiveRepository: false,
    installationId: installations[0].installationId,
  };
}

type RepoResolution = { repositoryId: string; installationId: string };
type InstallationResolution = {
  installationId: string | null;
  blockedByInactiveRepository: boolean;
};
type RepositoryResolutionResult = {
  resolution: RepoResolution | null;
  blockedByInactiveRepository: boolean;
};

/**
 * Resolve both repositoryId and installationId for a given owner/repo pair
 * by querying `github_installation_repositories` in a single DB lookup.
 *
 * The in-flight lookup *promise* is memoized in the provided Map (keyed on
 * `owner/repo`) so that multiple PR links for the same repository share one DB
 * round-trip per repair run — even when the repairs run concurrently. A failed
 * lookup is evicted so a later attempt can retry instead of inheriting the
 * cached rejection.
 */
function resolveRepositoryId(
  owner: string,
  repo: string,
  organizationId: string,
  cache: Map<string, Promise<RepositoryResolutionResult>>
): Promise<RepositoryResolutionResult> {
  const cacheKey = `${owner}/${repo}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const lookup = withDb(async (db) => {
    const activeRow = await db.gitHubInstallationRepository.findFirst({
      where: {
        fullName: cacheKey,
        removedAt: null,
        installation: {
          organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: {
        id: true,
        installation: { select: { installationId: true } },
      },
    });
    if (activeRow?.installation.installationId) {
      return {
        blockedByInactiveRepository: false,
        resolution: {
          repositoryId: activeRow.id,
          installationId: activeRow.installation.installationId,
        },
      };
    }

    const inactiveRow = await db.gitHubInstallationRepository.findFirst({
      where: {
        fullName: cacheKey,
        installation: { organizationId },
      },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
    });
    return {
      blockedByInactiveRepository: Boolean(inactiveRow),
      resolution: null,
    };
  }).catch((error) => {
    cache.delete(cacheKey);
    throw error;
  });

  cache.set(cacheKey, lookup);
  return lookup;
}

type FreshPr = GitHubPullRequestLifecycle;

type PullRequestBackfillOptions = {
  tx: TransactionClient;
  freshPr: FreshPr;
  owner: string;
  repo: string;
  organizationId: string;
  projectId: string | null;
  repositoryId: string | null;
};

/**
 * Create a brand-new PR Artifact + PullRequestDetail row when the detail row
 * is missing. No-op if we lack the required context.
 */
async function backfillBranchArtifact({
  tx,
  freshPr,
  owner,
  repo,
  organizationId,
  projectId,
  repositoryId,
}: PullRequestBackfillOptions): Promise<void> {
  if (repositoryId === null) {
    log.warn("[pr-read-repair] PullRequestDetail missing and cannot backfill", {
      githubId: freshPr.githubId,
      organizationId,
      repositoryId,
    });
    return;
  }

  try {
    const fetchProvenance = gitHubFetchProvenanceData(
      githubAppRestFetchProvenance({
        trigger: GitHubFetchTrigger.Backfill,
      })
    );
    const created = await tx.artifact.create({
      data: {
        type: ArtifactType.BRANCH,
        organizationId,
        projectId,
        name: freshPr.headBranch,
        status: freshPr.state,
        externalUrl: buildBranchTreeUrl(owner, repo, freshPr.headBranch),
        branch: {
          create: {
            // FR13: write-once org copy from the parent Artifact; D2 identity
            // via the normalized `owner/repo` full name.
            organizationId,
            repositoryId,
            repositoryFullName: normalizeRepoFullName(`${owner}/${repo}`),
            branchName: freshPr.headBranch,
            baseBranch: freshPr.baseBranch,
            baseBranchSource: BranchBaseBranchSource.PullRequestBase,
            headSha: freshPr.headSha,
            headShaSource: BranchHeadShaSource.PullRequestWebhook,
            ...fetchProvenance,
          },
        },
        pullRequestDetails: {
          create: {
            // FEA-2732: write-once org SSOT copy from the parent Artifact.
            organizationId,
            repositoryId,
            githubId: freshPr.githubId,
            number: freshPr.number,
            title: freshPr.title,
            htmlUrl: freshPr.htmlUrl,
            prState: freshPr.state,
            mergedAt: freshPr.mergedAt ? new Date(freshPr.mergedAt) : null,
            closedAt: freshPr.closedAt ? new Date(freshPr.closedAt) : null,
            isCurrent: true,
            ...fetchProvenance,
          },
        },
      },
      select: { id: true, pullRequestDetails: { select: { id: true } } },
    });
    const currentDetailId = created.pullRequestDetails[0]?.id ?? null;
    if (currentDetailId) {
      await tx.branchDetail.update({
        where: { artifactId: created.id },
        data: { currentPullRequestDetailId: currentDetailId },
      });
    }
  } catch (createError) {
    if (getPrismaErrorCode(createError) === "P2002") {
      // Concurrent insert — no-op dedup
      return;
    }
    throw createError;
  }
}

async function repairSinglePrLink(
  input: PrReadRepairInput,
  organizationId: string,
  repoCache: Map<string, Promise<RepositoryResolutionResult>>
): Promise<void> {
  const match = PR_URL_REGEX.exec(input.externalUrl);
  if (!match) {
    log.warn("[pr-read-repair] Could not parse PR URL, skipping", {
      branchArtifactId: input.id,
      externalUrl: input.externalUrl,
    });
    return;
  }

  const [, owner, repo, pullNumberStr] = match;
  const pullNumber = Number(pullNumberStr);
  // Try the fast path: resolve both repositoryId and installationId in one lookup
  const repoLookup = await resolveRepositoryId(
    owner,
    repo,
    organizationId,
    repoCache
  );
  if (repoLookup.blockedByInactiveRepository) {
    return;
  }

  const installationResolution = repoLookup.resolution?.installationId
    ? {
        blockedByInactiveRepository: false,
        installationId: repoLookup.resolution.installationId,
      }
    : await resolveInstallationId(input.id, organizationId);
  if (installationResolution.blockedByInactiveRepository) {
    return;
  }
  const installationId = installationResolution.installationId;

  if (!installationId) {
    return;
  }

  const repositoryId = repoLookup.resolution?.repositoryId ?? null;
  const existingDetail = await withDb((db) =>
    db.pullRequestDetail.findFirst({
      where: {
        OR: [
          { artifactId: input.id },
          { branchArtifactId: input.id, isCurrent: true },
        ],
        branchArtifact: { organizationId },
      },
      select: { id: true, repositoryId: true },
    })
  );

  if (existingDetail) {
    // FEA-2732: repo-less PRs carry a null repositoryId. Only relink when GitHub
    // resolved a concrete App-installation repo that differs from the stored id;
    // an unresolved lookup leaves the (possibly null) stored id untouched. When
    // relink fires the next id is always a concrete repository id.
    const resolvedRepositoryId = repoLookup.resolution?.repositoryId ?? null;
    if (
      resolvedRepositoryId &&
      existingDetail.repositoryId !== resolvedRepositoryId
    ) {
      await relinkReadRepairRepository({
        organizationId,
        branchArtifactId: input.id,
        pullRequestDetailId: existingDetail.id,
        previousRepositoryId: existingDetail.repositoryId,
        nextRepositoryId: resolvedRepositoryId,
      });
    }
    const activeRepositoryId =
      resolvedRepositoryId ?? existingDetail.repositoryId;
    await refreshPullRequestLifecycle({
      organizationId,
      installationId,
      owner,
      repo,
      pullNumber,
      branchArtifactId: input.id,
      pullRequestDetailId: existingDetail.id,
      repositoryId: activeRepositoryId,
      requireCurrentRelation: false,
      fetchTrigger: GitHubFetchTrigger.Backfill,
      artifactPatch: {
        updateBranchIdentity: true,
      },
    });
    return;
  }

  const freshPr = await getSinglePullRequest(
    installationId,
    owner,
    repo,
    pullNumber
  );

  if (!freshPr) {
    log.warn("[pr-read-repair] getSinglePullRequest returned null, skipping", {
      branchArtifactId: input.id,
      owner,
      repo,
      pullNumber,
    });
    return;
  }

  await withDb.tx(async (tx) => {
    await backfillBranchArtifact({
      tx,
      freshPr,
      owner,
      repo,
      organizationId,
      projectId: input.projectId,
      repositoryId,
    });
  });
}

async function relinkReadRepairRepository({
  organizationId,
  branchArtifactId,
  pullRequestDetailId,
  previousRepositoryId,
  nextRepositoryId,
}: {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  // FEA-2732: repo-less PRs start with a null repositoryId before adoption; the
  // where-filter matches the null rows so they can be relinked to a real repo.
  previousRepositoryId: string | null;
  nextRepositoryId: string;
}): Promise<void> {
  await withDb.tx(async (tx) => {
    await tx.branchDetail.updateMany({
      where: {
        artifactId: branchArtifactId,
        repositoryId: previousRepositoryId,
        artifact: { organizationId },
      },
      data: { repositoryId: nextRepositoryId },
    });
    await tx.pullRequestDetail.updateMany({
      where: {
        id: pullRequestDetailId,
        repositoryId: previousRepositoryId,
        branchArtifactId,
        branchArtifact: { organizationId },
      },
      data: { repositoryId: nextRepositoryId },
    });
  });
}

async function runPrReadRepair(
  eligibleInputs: PrReadRepairInput[],
  organizationId: string
): Promise<void> {
  // Each link's GitHub round-trip + tx backfill is independent, so repair them
  // concurrently — latency is bounded by the slowest single link rather than
  // the sum across N stale links. Concurrency is capped (pLimit) to keep GitHub
  // rate-limit and DB connection-pool pressure bounded. The shared repoCache
  // memoizes per-repo lookups across the concurrent passes (see
  // resolveRepositoryId), and each pass keeps its own warn-and-continue guard so
  // one failure never aborts the others.
  const repoCache = new Map<string, Promise<RepositoryResolutionResult>>();
  const limit = pLimit(PR_READ_REPAIR_CONCURRENCY);

  await Promise.all(
    eligibleInputs.map((input) =>
      limit(async () => {
        try {
          await repairSinglePrLink(input, organizationId, repoCache);
        } catch (err) {
          log.warn("[pr-read-repair] Failed to repair link, continuing", {
            branchArtifactId: input.id,
            error: err,
          });
        }
      })
    )
  );
}
