import "server-only";

import { ArtifactType, GitHubInstallationStatus, withDb } from "@repo/database";
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
  // Always present on a non-null PrContext: resolvePrContext early-returns
  // null when the PR artifact has no PullRequestDetail row. Narrowing here
  // lets callers drop the GitHub-API fallback branch entirely.
  gitHubPullRequest: {
    id: string;
    repositoryId: string;
    documentId: string | null;
    workstreamId: string | null;
    headSha: string | null;
  };
  repositoryId: string | null;
  installationId: string;
  owner: string;
  repo: string;
  pullNumber: number;
};

type GitHubPullRequestContext = NonNullable<PrContext["gitHubPullRequest"]>;

/**
 * Resolve all context needed to interact with a PR via its artifact id
 * (which is passed in the URL as `externalLinkId` for backwards
 * compatibility — IDs were preserved when external_links rows migrated into
 * the artifacts table).
 *
 * Resolution order with fallbacks:
 * 1. Load the PR artifact (+ detail) directly — this gives us title, URL,
 *    repositoryId, and all PR metadata.
 * 2. Parse owner/repo/pullNumber from `artifact.externalUrl`.
 * 3. Resolve the installationId from the repo row. Fallback: org's single
 *    active installation.
 *
 * Returns null when the artifact is not a PR, is cross-org, the URL is
 * unparseable, or installationId cannot be resolved.
 */
export async function resolvePrContext(
  externalLinkId: string,
  organizationId: string
): Promise<PrContext | null> {
  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: {
        id: externalLinkId,
        organizationId,
        type: ArtifactType.PULL_REQUEST,
      },
      include: { pullRequest: true },
    })
  );

  if (!artifact?.pullRequest) {
    return null;
  }

  const parsedIdentity = parsePullRequestIdentity(
    externalLinkId,
    artifact.externalUrl ?? ""
  );
  if (!parsedIdentity) {
    return null;
  }

  // Derive prMetadata directly from the PullRequestDetail row — no more need
  // to parse the ExternalLink.metadata JSON blob after the artifact cutover.
  const prMetadata = artifact.pullRequest
    ? {
        number: artifact.pullRequest.number,
        githubId: artifact.pullRequest.githubId,
        headBranch: artifact.pullRequest.headBranch,
        baseBranch: artifact.pullRequest.baseBranch,
        state: artifact.pullRequest.prState,
      }
    : null;

  // The PR artifact always has a detail row when we got here — the early
  // return above bails out when `artifact.pullRequest` is falsy.
  const detail = artifact.pullRequest;
  const gitHubPullRequest: GitHubPullRequestContext = {
    id: artifact.id,
    repositoryId: detail.repositoryId,
    documentId: await resolveProducingDocumentId(artifact.id, organizationId),
    workstreamId: artifact.workstreamId,
    headSha: detail.headSha,
  };

  let repositoryId: string | null = detail.repositoryId;
  // Resolve installationId via the PR's repository; validate match against
  // the parsed URL identity (guards against metadata/URL drift).
  let installationId: string | null = await resolveInstallationFromRepository(
    detail.repositoryId,
    parsedIdentity,
    detail.number,
    externalLinkId
  );

  if (installationId === null) {
    const fallback = await resolveInstallationFallback({
      externalLinkId,
      organizationId,
      parsedIdentity,
    });
    if (!fallback) {
      return null;
    }
    installationId = fallback.installationId;
    repositoryId = repositoryId ?? fallback.repositoryId;
  }

  return {
    externalLink: {
      id: artifact.id,
      title: artifact.name,
      externalUrl: artifact.externalUrl ?? "",
      metadata: null,
      projectId: artifact.projectId,
      workstreamId: artifact.workstreamId,
      organizationId: artifact.organizationId,
    },
    prMetadata,
    gitHubPullRequest,
    repositoryId,
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

/**
 * Given a PR's `repositoryId` and parsed URL identity, return the active
 * GitHub installationId for that repo — or null if the installation is
 * inactive or the URL/repo/number don't line up.
 */
async function resolveInstallationFromRepository(
  repositoryId: string,
  parsedIdentity: ParsedPullRequestIdentity,
  pullNumber: number,
  externalLinkId: string
): Promise<string | null> {
  const repoRow = await withDb((db) =>
    db.gitHubInstallationRepository.findUnique({
      where: { id: repositoryId },
      select: {
        fullName: true,
        installation: { select: { installationId: true, status: true } },
      },
    })
  );

  if (!repoRow) {
    return null;
  }

  if (repoRow.installation.status !== GitHubInstallationStatus.ACTIVE) {
    return null;
  }

  if (
    !matchesParsedPullRequestIdentity(parsedIdentity, {
      repositoryFullName: repoRow.fullName,
      pullNumber,
    })
  ) {
    log.warn(
      "[resolve-pr-context] Ignoring detail-backed PR row that does not match parsed URL",
      {
        externalLinkId,
        parsedFullName: toRepositoryFullName(parsedIdentity),
        parsedPullNumber: parsedIdentity.pullNumber,
        resolvedFullName: repoRow.fullName,
        resolvedPullNumber: pullNumber,
      }
    );
    return null;
  }

  return repoRow.installation.installationId;
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

/**
 * Find the artifact that PRODUCES the PR (typically a Document), if any.
 * Returns the source artifact id — used to populate `PrContext.documentId`.
 */
async function resolveProducingDocumentId(
  pullRequestArtifactId: string,
  organizationId: string
): Promise<string | null> {
  const link = await withDb((db) =>
    db.artifactLink.findFirst({
      where: {
        organizationId,
        targetId: pullRequestArtifactId,
        source: { type: ArtifactType.DOCUMENT },
      },
      select: { sourceId: true },
    })
  );
  return link?.sourceId ?? null;
}

function toRepositoryFullName(
  parsedIdentity: ParsedPullRequestIdentity
): string {
  return `${parsedIdentity.owner}/${parsedIdentity.repo}`;
}
