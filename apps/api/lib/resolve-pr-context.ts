import "server-only";

import { parsePullRequestMetadata } from "@repo/api/src/types/external-link-utils";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { log } from "@repo/observability/log";

const PR_URL_REGEX = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

type ParsedPullRequestIdentity = {
  owner: string;
  repo: string;
  pullNumber: number;
};

export function matchesParsedPullRequestIdentity(
  parsedIdentity: ParsedPullRequestIdentity,
  candidate: {
    repositoryFullName: string | null;
    pullNumber: number;
  }
): boolean {
  if (!candidate.repositoryFullName) {
    return false;
  }

  return (
    normalizeRepositoryFullName(candidate.repositoryFullName) ===
      normalizeRepositoryFullName(
        `${parsedIdentity.owner}/${parsedIdentity.repo}`
      ) && candidate.pullNumber === parsedIdentity.pullNumber
  );
}

function normalizeRepositoryFullName(fullName: string): string {
  return fullName.trim().toLowerCase();
}

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
    githubId?: string;
    headBranch: string;
    baseBranch: string;
    state: string;
  } | null;
  gitHubPullRequest: {
    id: string;
    repositoryId: string;
    documentId: string | null;
    workstreamId: string;
    headSha: string | null;
  } | null;
  repositoryId: string | null;
  installationId: string;
  owner: string;
  repo: string;
  pullNumber: number;
};

type GitHubPullRequestContext = NonNullable<PrContext["gitHubPullRequest"]>;

type PrLookupResult = {
  gitHubPullRequest: PrContext["gitHubPullRequest"];
  repositoryId: string | null;
  installationId: string | null;
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

  const parsedIdentity = parsePullRequestIdentity(
    externalLinkId,
    externalLink.externalUrl
  );
  if (!parsedIdentity) {
    return null;
  }

  const prMetadata = parsePullRequestMetadata(externalLink.metadata);
  let lookup = await resolvePrFromMetadata({
    externalLinkId,
    organizationId,
    githubId: prMetadata?.githubId ?? null,
    parsedIdentity,
  });

  if (!lookup.gitHubPullRequest) {
    lookup = await resolvePrByRepositoryAndNumber(
      parsedIdentity,
      organizationId
    );
  }

  if (!lookup.installationId) {
    const fallback = await resolveInstallationFallback({
      externalLinkId,
      organizationId,
      parsedIdentity,
    });
    if (!fallback) {
      return null;
    }

    lookup = {
      ...lookup,
      installationId: fallback.installationId,
      repositoryId: lookup.repositoryId ?? fallback.repositoryId,
    };
  }

  const installationId = lookup.installationId;
  if (!installationId) {
    return null;
  }

  return {
    externalLink,
    prMetadata,
    gitHubPullRequest: lookup.gitHubPullRequest,
    repositoryId: lookup.repositoryId,
    installationId,
    owner: parsedIdentity.owner,
    repo: parsedIdentity.repo,
    pullNumber: parsedIdentity.pullNumber,
  };
}

function parsePullRequestIdentity(
  externalLinkId: string,
  externalUrl: string
): ParsedPullRequestIdentity | null {
  const match = PR_URL_REGEX.exec(externalUrl);
  if (!match) {
    log.warn("[resolve-pr-context] Could not parse PR URL", {
      externalLinkId,
      externalUrl,
    });
    return null;
  }

  const [, owner, repo, pullNumberStr] = match;
  return {
    owner,
    repo,
    pullNumber: Number(pullNumberStr),
  };
}

async function resolvePrFromMetadata(params: {
  externalLinkId: string;
  organizationId: string;
  githubId: string | null;
  parsedIdentity: ParsedPullRequestIdentity;
}): Promise<PrLookupResult> {
  const githubId = params.githubId;
  if (!githubId) {
    return emptyPrLookupResult();
  }

  const prRow = await withDb((db) =>
    db.gitHubPullRequest.findFirst({
      where: {
        githubId,
        organizationId: params.organizationId,
      },
      select: {
        id: true,
        repositoryId: true,
        documentId: true,
        workstreamId: true,
        headSha: true,
        number: true,
      },
    })
  );

  if (!prRow) {
    return emptyPrLookupResult();
  }

  const repoRow = await withDb((db) =>
    db.gitHubInstallationRepository.findUnique({
      where: { id: prRow.repositoryId },
      select: {
        fullName: true,
        installation: { select: { installationId: true, status: true } },
      },
    })
  );

  // Skip if the installation is no longer active (uninstalled/suspended)
  if (repoRow?.installation.status !== GitHubInstallationStatus.ACTIVE) {
    return {
      gitHubPullRequest: toPrContextPullRequest(prRow),
      repositoryId: prRow.repositoryId,
      installationId: null,
    };
  }

  if (
    !matchesParsedPullRequestIdentity(params.parsedIdentity, {
      repositoryFullName: repoRow?.fullName ?? null,
      pullNumber: prRow.number,
    })
  ) {
    log.warn(
      "[resolve-pr-context] Ignoring metadata-backed PR row that does not match parsed URL",
      {
        externalLinkId: params.externalLinkId,
        githubId,
        parsedFullName: toRepositoryFullName(params.parsedIdentity),
        parsedPullNumber: params.parsedIdentity.pullNumber,
        resolvedFullName: repoRow?.fullName ?? null,
        resolvedPullNumber: prRow.number,
      }
    );
    return emptyPrLookupResult();
  }

  return {
    gitHubPullRequest: toPrContextPullRequest(prRow),
    repositoryId: prRow.repositoryId,
    installationId: repoRow?.installation.installationId ?? null,
  };
}

async function resolvePrByRepositoryAndNumber(
  parsedIdentity: ParsedPullRequestIdentity,
  organizationId: string
): Promise<PrLookupResult> {
  const repoRow = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        fullName: normalizeRepositoryFullName(
          toRepositoryFullName(parsedIdentity)
        ),
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

  if (!repoRow) {
    return emptyPrLookupResult();
  }

  const prRow = await withDb((db) =>
    db.gitHubPullRequest.findUnique({
      where: {
        repositoryId_number: {
          repositoryId: repoRow.id,
          number: parsedIdentity.pullNumber,
        },
      },
      select: {
        id: true,
        repositoryId: true,
        documentId: true,
        workstreamId: true,
        headSha: true,
      },
    })
  );

  return {
    gitHubPullRequest: prRow ? toPrContextPullRequest(prRow) : null,
    repositoryId: repoRow.id,
    installationId: repoRow.installation.installationId,
  };
}

async function resolveInstallationFallback(params: {
  externalLinkId: string;
  organizationId: string;
  parsedIdentity: ParsedPullRequestIdentity;
}): Promise<{ installationId: string; repositoryId: string | null } | null> {
  const installations = await withDb((db) =>
    db.gitHubInstallation.findMany({
      where: {
        organizationId: params.organizationId,
        status: GitHubInstallationStatus.ACTIVE,
      },
      select: { installationId: true },
    })
  );

  if (installations.length !== 1) {
    log.warn("[resolve-pr-context] Cannot resolve installationId", {
      externalLinkId: params.externalLinkId,
      organizationId: params.organizationId,
      count: installations.length,
    });
    return null;
  }

  const installationId = installations[0].installationId;
  const repoRow = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        fullName: normalizeRepositoryFullName(
          toRepositoryFullName(params.parsedIdentity)
        ),
        installation: { installationId },
      },
      select: { id: true },
    })
  );

  if (!repoRow) {
    log.info("[resolve-pr-context] Repository not found for backfill", {
      fullName: toRepositoryFullName(params.parsedIdentity),
      installationId,
    });
  }

  return {
    installationId,
    repositoryId: repoRow?.id ?? null,
  };
}

function toRepositoryFullName(
  parsedIdentity: ParsedPullRequestIdentity
): string {
  return `${parsedIdentity.owner}/${parsedIdentity.repo}`;
}

function toPrContextPullRequest(
  prRow: GitHubPullRequestContext
): GitHubPullRequestContext {
  return {
    id: prRow.id,
    repositoryId: prRow.repositoryId,
    documentId: prRow.documentId,
    workstreamId: prRow.workstreamId,
    headSha: prRow.headSha,
  };
}

function emptyPrLookupResult(): PrLookupResult {
  return {
    gitHubPullRequest: null,
    repositoryId: null,
    installationId: null,
  };
}
