import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import {
  type BranchViewPrLifecycleRepair,
  BranchViewPrLifecycleRepairStatus,
} from "@repo/api/src/types/branch-view";
import { GitHubPRState } from "@repo/api/src/types/github";
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
        error: error instanceof Error ? error.message : String(error),
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
 * Returns null if neither path resolves.
 */
async function resolveInstallationId(
  branchArtifactId: string,
  organizationId: string
): Promise<string | null> {
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

  if (prRow?.repositoryId) {
    const repoRow = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: {
          id: prRow.repositoryId,
          installation: { organizationId },
        },
        select: { installation: { select: { installationId: true } } },
      })
    );

    if (repoRow?.installation?.installationId) {
      return repoRow.installation.installationId;
    }
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
    return null;
  }

  return installations[0].installationId;
}

type RepoResolution = { repositoryId: string; installationId: string };

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
  cache: Map<string, Promise<RepoResolution | null>>
): Promise<RepoResolution | null> {
  const cacheKey = `${owner}/${repo}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const lookup = withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        fullName: cacheKey,
        installation: { organizationId },
      },
      select: {
        id: true,
        installation: { select: { installationId: true } },
      },
    })
  )
    .then((row) =>
      row?.installation?.installationId
        ? {
            repositoryId: row.id,
            installationId: row.installation.installationId,
          }
        : null
    )
    .catch((error) => {
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
            repositoryId,
            branchName: freshPr.headBranch,
            baseBranch: freshPr.baseBranch,
            baseBranchSource: BranchBaseBranchSource.PullRequestBase,
            headSha: freshPr.headSha,
            headShaSource: BranchHeadShaSource.PullRequestWebhook,
          },
        },
        pullRequestDetails: {
          create: {
            repositoryId,
            githubId: freshPr.githubId,
            number: freshPr.number,
            title: freshPr.title,
            htmlUrl: freshPr.htmlUrl,
            prState: freshPr.state,
            mergedAt: freshPr.mergedAt ? new Date(freshPr.mergedAt) : null,
            closedAt: freshPr.closedAt ? new Date(freshPr.closedAt) : null,
            isCurrent: true,
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
    if ((createError as { code?: string }).code === "P2002") {
      // Concurrent insert — no-op dedup
      return;
    }
    throw createError;
  }
}

async function repairSinglePrLink(
  input: PrReadRepairInput,
  organizationId: string,
  repoCache: Map<string, Promise<RepoResolution | null>>
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
  const repoResolution = await resolveRepositoryId(
    owner,
    repo,
    organizationId,
    repoCache
  );

  const installationId =
    repoResolution?.installationId ??
    (await resolveInstallationId(input.id, organizationId));

  if (!installationId) {
    return;
  }

  const repositoryId = repoResolution?.repositoryId ?? null;
  const existingDetail = await withDb((db) =>
    db.pullRequestDetail.findFirst({
      where: {
        OR: [
          { artifactId: input.id },
          { branchArtifactId: input.id, isCurrent: true },
        ],
        branchArtifact: { organizationId },
        repository: { installation: { organizationId } },
      },
      select: { id: true, repositoryId: true },
    })
  );

  if (existingDetail) {
    await refreshPullRequestLifecycle({
      organizationId,
      installationId,
      owner,
      repo,
      pullNumber,
      branchArtifactId: input.id,
      pullRequestDetailId: existingDetail.id,
      repositoryId: existingDetail.repositoryId,
      requireCurrentRelation: false,
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
  const repoCache = new Map<string, Promise<RepoResolution | null>>();
  const limit = pLimit(PR_READ_REPAIR_CONCURRENCY);

  await Promise.all(
    eligibleInputs.map((input) =>
      limit(async () => {
        try {
          await repairSinglePrLink(input, organizationId, repoCache);
        } catch (err) {
          log.warn("[pr-read-repair] Failed to repair link, continuing", {
            branchArtifactId: input.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
    )
  );
}
