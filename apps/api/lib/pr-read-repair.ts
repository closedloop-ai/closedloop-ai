import type { JsonObject } from "@repo/api/src/types/common";
import { EntityType } from "@repo/api/src/types/entity-link";
import type { ExternalLink } from "@repo/api/src/types/external-link";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { parsePullRequestMetadata } from "@repo/api/src/types/external-link-utils";
import { GitHubPRState } from "@repo/api/src/types/github";
import type { TransactionClient } from "@repo/database";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { getSinglePullRequest } from "@repo/github";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";

const STALENESS_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const DEBOUNCE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Schedule a background read-repair pass for stale PR external links.
 * Synchronous — fires via waitUntil so it does not block the caller.
 */
export function schedulePrReadRepair(
  externalLinks: ExternalLink[],
  organizationId: string
): void {
  if (externalLinks.length === 0) {
    return;
  }

  const now = Date.now();

  const eligible = externalLinks.filter((link) => {
    if (link.type !== ExternalLinkType.PullRequest) {
      return false;
    }

    const parsed = parsePullRequestMetadata(link.metadata);

    // Needs refresh if metadata is missing, PR is not yet merged, or
    // PR is merged but was never verified (e.g., linked via SelectPullRequestDialog
    // where mergedAt/closedAt are not populated at creation time).
    const neverVerified = !parsed?.lastVerifiedAt;
    const needsStateCheck =
      parsed === null || parsed.state !== GitHubPRState.Merged || neverVerified;
    if (!needsStateCheck) {
      return false;
    }

    // Staleness check: skip if verified recently
    const lastVerified = parsed?.lastVerifiedAt
      ? new Date(parsed.lastVerifiedAt).getTime()
      : null;
    if (lastVerified !== null && now - lastVerified < STALENESS_THRESHOLD_MS) {
      return false;
    }

    // Debounce check: skip if a refresh attempt was made recently
    const lastAttempt = parsed?.lastRefreshAttemptAt
      ? new Date(parsed.lastRefreshAttemptAt).getTime()
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
 * Resolve the GitHub App installationId for a PR external link.
 *
 * Primary: look up via the GitHubPullRequest row's repository.
 * Fallback: use the org's single active installation.
 * Returns null if neither path resolves.
 */
async function resolveInstallationId(
  githubId: string | undefined,
  organizationId: string,
  externalLinkId: string
): Promise<string | null> {
  if (githubId) {
    const prRow = await withDb((db) =>
      db.gitHubPullRequest.findFirst({
        where: { githubId, organizationId },
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
      { externalLinkId, organizationId, count: installations.length }
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

async function applyExternalLinkUpdate(
  tx: TransactionClient,
  link: ExternalLink,
  freshPr: FreshPr,
  currentMetadata: JsonObject,
  workstreamId: string | null,
  now: string
): Promise<void> {
  const updatedMetadata = {
    ...currentMetadata,
    githubId: freshPr.githubId,
    number: freshPr.number,
    headBranch: freshPr.headBranch,
    baseBranch: freshPr.baseBranch,
    state: freshPr.state,
    lastVerifiedAt: now,
    lastRefreshAttemptAt: now,
  } as JsonObject;

  await tx.externalLink.updateMany({
    where: { id: link.id },
    data: {
      title: freshPr.title,
      metadata: updatedMetadata,
      ...(workstreamId !== null && link.workstreamId === null
        ? { workstreamId }
        : {}),
    },
  });
}

type PullRequestUpsertOptions = {
  tx: TransactionClient;
  freshPr: FreshPr;
  organizationId: string;
  repositoryId: string | null;
  workstreamId: string | null;
  artifactId: string | null;
  pullNumber: number;
  externalLinkId: string;
};

async function applyPullRequestUpsert({
  tx,
  freshPr,
  organizationId,
  repositoryId,
  workstreamId,
  artifactId,
  pullNumber,
  externalLinkId,
}: PullRequestUpsertOptions): Promise<void> {
  const existingPr = await tx.gitHubPullRequest.findFirst({
    where: {
      organizationId,
      number: pullNumber,
      ...(repositoryId !== null ? { repositoryId } : {}),
    },
    select: { id: true },
  });

  if (existingPr) {
    await tx.gitHubPullRequest.updateMany({
      where: { githubId: freshPr.githubId, organizationId },
      data: {
        state: freshPr.state,
        title: freshPr.title,
        mergedAt: freshPr.mergedAt ? new Date(freshPr.mergedAt) : null,
        closedAt: freshPr.closedAt ? new Date(freshPr.closedAt) : null,
      },
    });
    return;
  }

  if (repositoryId === null || workstreamId === null) {
    log.warn(
      "[pr-read-repair] GitHubPullRequest row not found and cannot backfill",
      {
        githubId: freshPr.githubId,
        organizationId,
        repositoryId,
        workstreamId,
        externalLinkId,
      }
    );
    return;
  }

  // Backfill: create the row if it doesn't exist yet
  try {
    await tx.gitHubPullRequest.create({
      data: {
        workstreamId,
        organizationId,
        repositoryId,
        artifactId,
        githubId: freshPr.githubId,
        number: freshPr.number,
        title: freshPr.title,
        htmlUrl: freshPr.htmlUrl,
        headBranch: freshPr.headBranch,
        baseBranch: freshPr.baseBranch,
        state: freshPr.state,
        mergedAt: freshPr.mergedAt ? new Date(freshPr.mergedAt) : null,
        closedAt: freshPr.closedAt ? new Date(freshPr.closedAt) : null,
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
  link: ExternalLink,
  organizationId: string,
  repoCache: Map<string, RepoResolution | null>
): Promise<void> {
  const match = PR_URL_REGEX.exec(link.externalUrl);
  if (!match) {
    log.warn("[pr-read-repair] Could not parse PR URL, skipping", {
      externalLinkId: link.id,
      externalUrl: link.externalUrl,
    });
    return;
  }

  const [, owner, repo, pullNumberStr] = match;
  const pullNumber = Number(pullNumberStr);
  const now = new Date().toISOString();

  // Stamp lastRefreshAttemptAt before making the GitHub API call (debounce write-ahead)
  const updated = await withDb((db) =>
    db.externalLink.update({
      where: { id: link.id },
      data: {
        metadata: {
          ...(link.metadata as JsonObject),
          lastRefreshAttemptAt: now,
        } as JsonObject,
      },
      select: { metadata: true },
    })
  );

  const currentMetadata = (updated.metadata ?? {}) as JsonObject;

  const parsed = parsePullRequestMetadata(currentMetadata);
  const githubId = parsed?.githubId;

  // Try the fast path: resolve both repositoryId and installationId in one lookup
  const repoResolution = await resolveRepositoryId(
    owner,
    repo,
    organizationId,
    repoCache
  );

  const installationId =
    repoResolution?.installationId ??
    (await resolveInstallationId(githubId, organizationId, link.id));

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
      externalLinkId: link.id,
      owner,
      repo,
      pullNumber,
    });
    return;
  }

  const entityContext = link.workstreamId
    ? { workstreamId: link.workstreamId, artifactId: null as string | null }
    : await resolveEntityLinkContext(link.id, organizationId);
  const workstreamId = entityContext.workstreamId;
  const artifactId = entityContext.artifactId;
  const repositoryId = repoResolution?.repositoryId ?? null;

  await withDb.tx(async (tx) => {
    await applyExternalLinkUpdate(
      tx,
      link,
      freshPr,
      currentMetadata,
      workstreamId,
      now
    );
    await applyPullRequestUpsert({
      tx,
      freshPr,
      organizationId,
      repositoryId,
      workstreamId,
      artifactId,
      pullNumber,
      externalLinkId: link.id,
    });
  });
}

async function runPrReadRepair(
  eligibleLinks: ExternalLink[],
  organizationId: string
): Promise<void> {
  const repoCache = new Map<string, RepoResolution | null>();

  for (const link of eligibleLinks) {
    try {
      await repairSinglePrLink(link, organizationId, repoCache);
    } catch (err) {
      log.warn("[pr-read-repair] Failed to repair link, continuing", {
        externalLinkId: link.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

type EntityLinkResolution = {
  workstreamId: string | null;
  artifactId: string | null;
};

/**
 * Walk the entity link tree to resolve workstreamId and artifactId for an
 * external link.
 *
 * Scans all incoming entity links (not just the first) to handle cases where
 * the external link has multiple parents (e.g., artifact + PRD). Checks:
 * 1. All parent artifacts — return the first artifact's workstream_id if present.
 * 2. For each artifact without a workstream, walk one more level to the parent
 *    feature and return the feature's workstream_id.
 *
 * Always returns the first matched artifactId regardless of workstream resolution.
 */
async function resolveEntityLinkContext(
  externalLinkId: string,
  organizationId: string
): Promise<EntityLinkResolution> {
  let resolvedArtifactId: string | null = null;

  // Level 1: find all entities that target this external link
  const parentLinks = await withDb((db) =>
    db.entityLink.findMany({
      where: {
        targetId: externalLinkId,
        targetType: EntityType.ExternalLink,
        organizationId,
      },
      select: { sourceId: true, sourceType: true },
    })
  );

  for (const parentLink of parentLinks) {
    if (parentLink.sourceType !== EntityType.Artifact) {
      continue;
    }

    if (!resolvedArtifactId) {
      resolvedArtifactId = parentLink.sourceId;
    }

    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: { id: parentLink.sourceId, organizationId },
        select: { workstreamId: true },
      })
    );

    if (artifact?.workstreamId) {
      return {
        workstreamId: artifact.workstreamId,
        artifactId: resolvedArtifactId,
      };
    }

    // Level 2: find the feature that targets this artifact
    const featureLinks = await withDb((db) =>
      db.entityLink.findMany({
        where: {
          targetId: parentLink.sourceId,
          targetType: EntityType.Artifact,
          organizationId,
        },
        select: { sourceId: true, sourceType: true },
      })
    );

    for (const featureLink of featureLinks) {
      if (featureLink.sourceType !== EntityType.Feature) {
        continue;
      }

      const feature = await withDb((db) =>
        db.feature.findFirst({
          where: { id: featureLink.sourceId, organizationId },
          select: { workstreamId: true },
        })
      );

      if (feature?.workstreamId) {
        return {
          workstreamId: feature.workstreamId,
          artifactId: resolvedArtifactId,
        };
      }
    }
  }

  return { workstreamId: null, artifactId: resolvedArtifactId };
}
