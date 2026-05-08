import { LinkType } from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  ArtifactSubtype,
  ArtifactType,
  GitHubInstallationStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { getSinglePullRequest } from "@repo/github";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";

const STALENESS_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const DEBOUNCE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Shape used as input to the read-repair pass. Callers derive this from
 * `PullRequestDetail` rows (joined with their parent Artifact) — no more
 * ExternalLink / ExternalLink.metadata after the artifact cutover.
 */
export type PrReadRepairInput = {
  /** PR artifact id (= PullRequestDetail.artifactId). */
  id: string;
  /** Parent artifact's externalUrl — used to reach the GitHub REST API. */
  externalUrl: string;
  /** Parent artifact's workstreamId (may be null for orphaned PRs). */
  workstreamId: string | null;
  /** Parent artifact's projectId — used when backfilling a missing detail row. */
  projectId: string;
  /** Parent artifact's organizationId. */
  organizationId: string;
  /** PullRequestDetail.prState — used to filter "already merged" rows out. */
  prState: GitHubPRState;
  /** PullRequestDetail.lastVerifiedAt. */
  lastVerifiedAt: Date | null;
  /** PullRequestDetail.lastRefreshAttemptAt. */
  lastRefreshAttemptAt: Date | null;
};

/**
 * Schedule a background read-repair pass for stale PR artifacts.
 * Synchronous — fires via waitUntil so it does not block the caller.
 */
export function schedulePrReadRepair(
  inputs: PrReadRepairInput[],
  organizationId: string
): void {
  if (inputs.length === 0) {
    return;
  }

  const now = Date.now();

  const eligible = inputs.filter((input) => {
    const neverVerified = !input.lastVerifiedAt;
    const needsStateCheck =
      input.prState !== GitHubPRState.Merged || neverVerified;
    if (!needsStateCheck) {
      return false;
    }

    // Staleness check: skip if verified recently
    const lastVerified = input.lastVerifiedAt
      ? input.lastVerifiedAt.getTime()
      : null;
    if (lastVerified !== null && now - lastVerified < STALENESS_THRESHOLD_MS) {
      return false;
    }

    // Debounce check: skip if a refresh attempt was made recently
    const lastAttempt = input.lastRefreshAttemptAt
      ? input.lastRefreshAttemptAt.getTime()
      : null;
    if (lastAttempt !== null && now - lastAttempt < DEBOUNCE_WINDOW_MS) {
      return false;
    }

    return true;
  });

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

const PR_URL_REGEX = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

/**
 * Resolve the GitHub App installationId for a PR artifact id.
 *
 * Primary: look up via the PullRequestDetail's repository.
 * Fallback: use the org's single active installation.
 * Returns null if neither path resolves.
 */
async function resolveInstallationId(
  pullRequestArtifactId: string,
  organizationId: string
): Promise<string | null> {
  const prRow = await withDb((db) =>
    db.pullRequestDetail.findUnique({
      where: { artifactId: pullRequestArtifactId },
      select: { repositoryId: true },
    })
  );

  if (prRow?.repositoryId) {
    const repoRow = await withDb((db) =>
      db.gitHubInstallationRepository.findUnique({
        where: { id: prRow.repositoryId },
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
        pullRequestArtifactId,
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
 * Results are memoized in the provided Map (keyed on `owner/repo`) so that
 * multiple PR links for the same repository share one DB round-trip per
 * repair run.
 */
async function resolveRepositoryId(
  owner: string,
  repo: string,
  organizationId: string,
  cache: Map<string, RepoResolution | null>
): Promise<RepoResolution | null> {
  const cacheKey = `${owner}/${repo}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }

  const row = await withDb((db) =>
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
  );

  const result = row?.installation?.installationId
    ? { repositoryId: row.id, installationId: row.installation.installationId }
    : null;

  cache.set(cacheKey, result);
  return result;
}

type FreshPr = NonNullable<Awaited<ReturnType<typeof getSinglePullRequest>>>;

/**
 * Apply the refreshed PR data to the PR Artifact + PullRequestDetail rows.
 */
async function applyPullRequestUpdate(
  tx: TransactionClient,
  pullRequestArtifactId: string,
  freshPr: FreshPr,
  resolvedWorkstreamId: string | null,
  input: PrReadRepairInput,
  now: Date
): Promise<void> {
  await tx.artifact.update({
    where: { id: pullRequestArtifactId },
    data: {
      name: freshPr.title,
      externalUrl: freshPr.htmlUrl,
      ...(resolvedWorkstreamId !== null && input.workstreamId === null
        ? { workstreamId: resolvedWorkstreamId }
        : {}),
    },
  });

  await tx.pullRequestDetail.update({
    where: { artifactId: pullRequestArtifactId },
    data: {
      number: freshPr.number,
      githubId: freshPr.githubId,
      headBranch: freshPr.headBranch,
      baseBranch: freshPr.baseBranch,
      prState: freshPr.state,
      mergedAt: freshPr.mergedAt ? new Date(freshPr.mergedAt) : null,
      closedAt: freshPr.closedAt ? new Date(freshPr.closedAt) : null,
      lastVerifiedAt: now,
    },
  });
}

type PullRequestBackfillOptions = {
  tx: TransactionClient;
  freshPr: FreshPr;
  organizationId: string;
  projectId: string;
  repositoryId: string | null;
  workstreamId: string | null;
};

/**
 * Create a brand-new PR Artifact + PullRequestDetail row when the detail row
 * is missing. No-op if we lack the required context.
 */
async function backfillPullRequestArtifact({
  tx,
  freshPr,
  organizationId,
  projectId,
  repositoryId,
  workstreamId,
}: PullRequestBackfillOptions): Promise<void> {
  if (repositoryId === null || workstreamId === null) {
    log.warn("[pr-read-repair] PullRequestDetail missing and cannot backfill", {
      githubId: freshPr.githubId,
      organizationId,
      repositoryId,
      workstreamId,
    });
    return;
  }

  try {
    await tx.artifact.create({
      data: {
        type: ArtifactType.PULL_REQUEST,
        organizationId,
        projectId,
        workstreamId,
        name: freshPr.title,
        status: freshPr.state,
        externalUrl: freshPr.htmlUrl,
        pullRequest: {
          create: {
            repositoryId,
            githubId: freshPr.githubId,
            number: freshPr.number,
            headBranch: freshPr.headBranch,
            baseBranch: freshPr.baseBranch,
            prState: freshPr.state,
            mergedAt: freshPr.mergedAt ? new Date(freshPr.mergedAt) : null,
            closedAt: freshPr.closedAt ? new Date(freshPr.closedAt) : null,
          },
        },
      },
    });
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
  repoCache: Map<string, RepoResolution | null>
): Promise<void> {
  const match = PR_URL_REGEX.exec(input.externalUrl);
  if (!match) {
    log.warn("[pr-read-repair] Could not parse PR URL, skipping", {
      pullRequestArtifactId: input.id,
      externalUrl: input.externalUrl,
    });
    return;
  }

  const [, owner, repo, pullNumberStr] = match;
  const pullNumber = Number(pullNumberStr);
  const now = new Date();

  // Stamp lastRefreshAttemptAt before making the GitHub API call (debounce
  // write-ahead). The PR artifact id is shared with the legacy externalLinkId.
  await withDb((db) =>
    db.pullRequestDetail.update({
      where: { artifactId: input.id },
      data: { lastRefreshAttemptAt: now },
    })
  );

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

  const freshPr = await getSinglePullRequest(
    installationId,
    owner,
    repo,
    pullNumber
  );

  if (!freshPr) {
    log.warn("[pr-read-repair] getSinglePullRequest returned null, skipping", {
      pullRequestArtifactId: input.id,
      owner,
      repo,
      pullNumber,
    });
    return;
  }

  const entityContext = input.workstreamId
    ? { workstreamId: input.workstreamId, documentId: null as string | null }
    : await resolveArtifactLinkContext(input.id, organizationId);
  const resolvedWorkstreamId = entityContext.workstreamId;
  const repositoryId = repoResolution?.repositoryId ?? null;

  await withDb.tx(async (tx) => {
    const existingDetail = await tx.pullRequestDetail.findUnique({
      where: { artifactId: input.id },
      select: { artifactId: true },
    });

    if (existingDetail) {
      await applyPullRequestUpdate(
        tx,
        input.id,
        freshPr,
        resolvedWorkstreamId,
        input,
        now
      );
      return;
    }

    await backfillPullRequestArtifact({
      tx,
      freshPr,
      organizationId,
      projectId: input.projectId,
      repositoryId,
      workstreamId: resolvedWorkstreamId,
    });
  });
}

async function runPrReadRepair(
  eligibleInputs: PrReadRepairInput[],
  organizationId: string
): Promise<void> {
  const repoCache = new Map<string, RepoResolution | null>();

  for (const input of eligibleInputs) {
    try {
      await repairSinglePrLink(input, organizationId, repoCache);
    } catch (err) {
      log.warn("[pr-read-repair] Failed to repair link, continuing", {
        pullRequestArtifactId: input.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

type EntityLinkResolution = {
  workstreamId: string | null;
  documentId: string | null;
};

/**
 * Walk the artifact link tree to resolve workstreamId and documentId for a
 * PR artifact.
 *
 * Scans all incoming ArtifactLink rows (not just the first) to handle cases
 * where the PR has multiple parents (e.g., document + PRD). Checks:
 * 1. All parent DOCUMENT artifacts — return the first document's
 *    workstreamId if present.
 * 2. For each document without a workstream, walk one more level to a parent
 *    FEATURE-subtyped document and return its workstreamId.
 *
 * Always returns the first matched parent document id regardless of
 * workstream resolution.
 */
async function resolveArtifactLinkContext(
  pullRequestArtifactId: string,
  organizationId: string
): Promise<EntityLinkResolution> {
  let resolvedDocumentId: string | null = null;

  // Level 1: find all DOCUMENT-typed artifacts that target this PR artifact.
  const parentLinks = await withDb((db) =>
    db.artifactLink.findMany({
      where: {
        targetId: pullRequestArtifactId,
        organizationId,
        source: { type: ArtifactType.DOCUMENT },
      },
      select: { sourceId: true },
    })
  );

  for (const parentLink of parentLinks) {
    if (!resolvedDocumentId) {
      resolvedDocumentId = parentLink.sourceId;
    }

    const parentArtifact = await withDb((db) =>
      db.artifact.findFirst({
        where: {
          id: parentLink.sourceId,
          organizationId,
          type: ArtifactType.DOCUMENT,
        },
        select: { workstreamId: true },
      })
    );

    if (parentArtifact?.workstreamId) {
      return {
        workstreamId: parentArtifact.workstreamId,
        documentId: resolvedDocumentId,
      };
    }

    // Level 2: find a parent Feature-subtype document that targets this doc.
    const featureLinks = await withDb((db) =>
      db.artifactLink.findMany({
        where: {
          targetId: parentLink.sourceId,
          organizationId,
          linkType: LinkType.Produces,
          source: { type: ArtifactType.DOCUMENT },
        },
        select: { sourceId: true },
      })
    );

    for (const featureLink of featureLinks) {
      const feature = await withDb((db) =>
        db.artifact.findFirst({
          where: {
            id: featureLink.sourceId,
            organizationId,
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.FEATURE,
          },
          select: { workstreamId: true },
        })
      );

      if (feature?.workstreamId) {
        return {
          workstreamId: feature.workstreamId,
          documentId: resolvedDocumentId,
        };
      }
    }
  }

  return { workstreamId: null, documentId: resolvedDocumentId };
}
