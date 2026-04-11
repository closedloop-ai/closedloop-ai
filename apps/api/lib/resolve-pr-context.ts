import "server-only";

import { parsePullRequestMetadata } from "@repo/api/src/types/external-link-utils";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { log } from "@repo/observability/log";

const PR_URL_REGEX = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export type PrContext = {
  externalLink: {
    id: string;
    title: string;
    externalUrl: string;
    metadata: unknown;
    projectId: string;
    workstreamId: string | null;
    organizationId: string;
  };
  prMetadata: {
    number: number;
    githubId: string;
    headBranch: string;
    baseBranch: string;
    state: string;
  } | null;
  gitHubPullRequest: {
    id: string;
    repositoryId: string;
    artifactId: string | null;
    workstreamId: string;
    headSha: string | null;
  } | null;
  repositoryId: string | null;
  installationId: string;
  owner: string;
  repo: string;
  pullNumber: number;
};

/**
 * Resolve all context needed to interact with a PR via its ExternalLink ID.
 *
 * Resolution order with fallbacks:
 * 1. Parse owner/repo/pullNumber from externalUrl (always available).
 * 2. Try githubId from PullRequestMetadata -> GitHubPullRequest lookup.
 * 3. If metadata missing/stale, resolve by fullName + number within org.
 * 4. From matched PR's repositoryId -> installation.installationId.
 * 5. Fallback: org's single active GitHubInstallation.
 *
 * Returns null when installationId cannot be resolved.
 */
export async function resolvePrContext(
  externalLinkId: string,
  organizationId: string
): Promise<PrContext | null> {
  // Step 1: Fetch ExternalLink
  const externalLink = await withDb((db) =>
    db.externalLink.findFirst({
      where: { id: externalLinkId, organizationId },
      select: {
        id: true,
        title: true,
        externalUrl: true,
        metadata: true,
        projectId: true,
        workstreamId: true,
        organizationId: true,
      },
    })
  );

  if (!externalLink) {
    return null;
  }

  // Step 2: Parse owner/repo/pullNumber from URL
  const match = PR_URL_REGEX.exec(externalLink.externalUrl);
  if (!match) {
    log.warn("[resolve-pr-context] Could not parse PR URL", {
      externalLinkId,
      externalUrl: externalLink.externalUrl,
    });
    return null;
  }

  const [, owner, repo, pullNumberStr] = match;
  const pullNumber = Number(pullNumberStr);

  // Step 3: Try metadata-based lookup
  const prMetadata = parsePullRequestMetadata(externalLink.metadata);
  const githubId = prMetadata?.githubId;

  let gitHubPullRequest: PrContext["gitHubPullRequest"] = null;
  let installationId: string | null = null;
  let repositoryId: string | null = null;

  // Primary path: lookup by githubId
  if (githubId) {
    const prRow = await withDb((db) =>
      db.gitHubPullRequest.findFirst({
        where: { githubId, organizationId },
        select: {
          id: true,
          repositoryId: true,
          artifactId: true,
          workstreamId: true,
          headSha: true,
        },
      })
    );

    if (prRow) {
      gitHubPullRequest = prRow;
      repositoryId = prRow.repositoryId;
      installationId = await resolveInstallationFromRepo(prRow.repositoryId);
    }
  }

  // Fallback path: resolve by fullName + number
  if (!gitHubPullRequest) {
    const fullName = `${owner}/${repo}`;
    const repoRow = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: {
          fullName,
          installation: {
            organizationId,
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
        select: {
          id: true,
          installation: { select: { installationId: true } },
        },
      })
    );

    if (repoRow) {
      installationId = repoRow.installation.installationId;
      repositoryId = repoRow.id;

      const prRow = await withDb((db) =>
        db.gitHubPullRequest.findUnique({
          where: {
            repositoryId_number: {
              repositoryId: repoRow.id,
              number: pullNumber,
            },
          },
          select: {
            id: true,
            repositoryId: true,
            artifactId: true,
            workstreamId: true,
            headSha: true,
          },
        })
      );

      if (prRow) {
        gitHubPullRequest = prRow;
      }
    }
  }

  // Final fallback: org's single active installation
  if (!installationId) {
    const installations = await withDb((db) =>
      db.gitHubInstallation.findMany({
        where: { organizationId, status: GitHubInstallationStatus.ACTIVE },
        select: { installationId: true },
      })
    );

    if (installations.length === 1) {
      installationId = installations[0].installationId;

      // Attempt to resolve repositoryId for backfill support
      const repoByFullName = await withDb((db) =>
        db.gitHubInstallationRepository.findFirst({
          where: {
            fullName: `${owner}/${repo}`,
            installation: {
              installationId: installations[0].installationId,
            },
          },
          select: { id: true },
        })
      );
      if (repoByFullName) {
        repositoryId = repoByFullName.id;
      } else {
        log.info("[resolve-pr-context] Repository not found for backfill", {
          fullName: `${owner}/${repo}`,
          installationId: installations[0].installationId,
        });
      }
    } else {
      log.warn("[resolve-pr-context] Cannot resolve installationId", {
        externalLinkId,
        organizationId,
        count: installations.length,
      });
      return null;
    }
  }

  return {
    externalLink,
    prMetadata,
    gitHubPullRequest,
    repositoryId,
    installationId,
    owner,
    repo,
    pullNumber,
  };
}

async function resolveInstallationFromRepo(
  repositoryId: string
): Promise<string | null> {
  const repoRow = await withDb((db) =>
    db.gitHubInstallationRepository.findUnique({
      where: { id: repositoryId },
      select: { installation: { select: { installationId: true } } },
    })
  );

  return repoRow?.installation?.installationId ?? null;
}
