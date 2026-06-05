import type { JsonObject } from "@repo/api/src/types/common";
import type { ExternalLink } from "@repo/api/src/types/external-link";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { parsePullRequestMetadata } from "@repo/api/src/types/external-link-utils";
import { GitHubPRState } from "@repo/api/src/types/github";
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

    // Needs refresh if metadata is missing or PR is not yet merged
    const needsStateCheck =
      parsed === null || parsed.state !== GitHubPRState.Merged;
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

async function repairSinglePrLink(
  link: ExternalLink,
  organizationId: string
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

  // Stamp lastRefreshAttemptAt before making the GitHub API call
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

  const parsed = parsePullRequestMetadata(link.metadata);
  const githubId = parsed?.githubId;

  const installationId = await resolveInstallationId(
    githubId,
    organizationId,
    link.id
  );
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

  await withDb((db) =>
    db.externalLink.update({
      where: { id: link.id },
      data: {
        title: freshPr.title,
        metadata: {
          ...currentMetadata,
          githubId: freshPr.githubId,
          number: freshPr.number,
          headBranch: freshPr.headBranch,
          baseBranch: freshPr.baseBranch,
          state: freshPr.state,
          lastVerifiedAt: now,
          lastRefreshAttemptAt: now,
        } as JsonObject,
      },
    })
  );

  if (!githubId) {
    return;
  }

  const updateResult = await withDb((db) =>
    db.gitHubPullRequest.updateMany({
      where: { githubId, organizationId },
      data: {
        state: freshPr.state,
        title: freshPr.title,
        mergedAt: freshPr.mergedAt ? new Date(freshPr.mergedAt) : null,
        closedAt: freshPr.closedAt ? new Date(freshPr.closedAt) : null,
      },
    })
  );

  if (updateResult.count === 0) {
    log.warn("[pr-read-repair] GitHubPullRequest updateMany matched 0 rows", {
      githubId,
      organizationId,
      externalLinkId: link.id,
    });
  }
}

async function runPrReadRepair(
  eligibleLinks: ExternalLink[],
  organizationId: string
): Promise<void> {
  for (const link of eligibleLinks) {
    try {
      await repairSinglePrLink(link, organizationId);
    } catch (err) {
      log.warn("[pr-read-repair] Failed to repair link, continuing", {
        externalLinkId: link.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
