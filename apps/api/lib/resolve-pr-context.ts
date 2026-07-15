import "server-only";

import { ArtifactType, GitHubInstallationStatus, withDb } from "@repo/database";
import { log } from "@repo/observability/log";

export const BranchViewContextCredentialMode = {
  PinnedActiveOnly: "pinned_active_only",
  RenderRead: "render_read",
} as const;
export type BranchViewContextCredentialMode =
  (typeof BranchViewContextCredentialMode)[keyof typeof BranchViewContextCredentialMode];

export const BranchViewContextCredentialSource = {
  PinnedActive: "pinned_active",
  ActiveSibling: "active_sibling",
} as const;
export type BranchViewContextCredentialSource =
  (typeof BranchViewContextCredentialSource)[keyof typeof BranchViewContextCredentialSource];

type ResolvePrContextOptions = {
  credentialMode?: BranchViewContextCredentialMode;
};

type BranchRepositoryCredential = {
  repositoryId: string;
  githubRepoId: string | null;
  fullName: string;
  installationId: string;
  credentialSource: BranchViewContextCredentialSource;
};

function parseRepositoryFullName(
  fullName: string
): { owner: string; repo: string } | null {
  const [owner, repo, ...extra] = fullName.split("/");
  if (!(owner && repo) || extra.length > 0) {
    return null;
  }
  return { owner, repo };
}

export type PrContext = {
  externalLink: {
    id: string;
    title: string;
    externalUrl: string;
    status: string;
    metadata: unknown;
    projectId: string | null;
    organizationId: string;
    createdBy: { githubUsername: string | null } | null;
  };
  prMetadata: {
    number: number;
    // FEA-2732: nullable for desktop-produced PRs with no GitHub node id yet.
    githubId?: string | null;
    headBranch: string;
    baseBranch: string;
    state: string;
  } | null;
  branch: {
    artifactId: string;
    // Null for desktop-produced branches in non-App repos (PRD-510 D2/FR8):
    // branch identity keys on (organizationId, repositoryFullName, branchName)
    // rather than an installation-repo id.
    repositoryId: string | null;
    branchName: string;
    baseBranch: string | null;
    baseBranchSource: string | null;
    headSha: string | null;
    headShaSource: string | null;
    headShaObservedAt: Date | null;
    lastPushBeforeSha: string | null;
    currentPullRequestDetailId: string | null;
    checksStatus: string | null;
    checksDetailHeadSha: string | null;
    checksDetailTotalCount: number;
    checksDetailTruncated: boolean;
    checksDetailProviderState: string | null;
    checksDetailUnavailableReason: string | null;
    checksDetailUpdatedAt: Date | null;
    statusChecks: {
      providerKey: string;
      headSha: string;
      kind: string;
      name: string;
      status: string | null;
      conclusion: string | null;
      targetUrl: string | null;
      position: number;
    }[];
    fileCacheStatus: string;
    fileCacheHeadSha: string | null;
    fileCacheFileCount: number;
    fileCachePatchBytes: number;
    fileCacheUpdatedAt: Date | null;
    syncStatus: string;
    lastSyncStartedAt: Date | null;
    lastSyncCompletedAt: Date | null;
    lastSyncErrorCode: string | null;
    lastSyncErrorMessage: string | null;
    invalidCurrentPullRequestRelation?: boolean;
  } | null;
  // Present when a branch has current PR detail, or for legacy BRANCH
  // artifacts during the additive migration window.
  gitHubPullRequest: {
    id: string;
    // FEA-2732: nullable for desktop-produced PRs in non-App repos.
    repositoryId: string | null;
    documentId: string | null;
    githubId: string | null;
    headSha: string | null;
    number: number;
    title: string | null;
    htmlUrl: string | null;
    baseBranch: string;
    headBranch: string;
    state: string;
    isDraft: boolean;
    checksStatus: string | null;
    reviewDecision: string | null;
    lastVerifiedAt?: Date | null;
    lastRefreshAttemptAt?: Date | null;
  } | null;
  repositoryId: string | null;
  credentialRepositoryId?: string | null;
  credentialSource?: BranchViewContextCredentialSource;
  githubRepoId?: string | null;
  pinnedRepositoryId?: string | null;
  installationId: string;
  owner: string;
  repo: string;
  pullNumber: number | null;
};

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
  organizationId: string,
  options: ResolvePrContextOptions = {}
): Promise<PrContext | null> {
  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: {
        id: externalLinkId,
        organizationId,
        type: ArtifactType.BRANCH,
      },
      include: {
        createdBy: {
          select: {
            githubUsername: true,
          },
        },
        branch: {
          include: {
            statusChecks: {
              orderBy: { position: "asc" },
            },
            currentPullRequestDetail: true,
            repository: {
              select: {
                id: true,
                githubRepoId: true,
                fullName: true,
                removedAt: true,
                installation: {
                  select: {
                    installationId: true,
                    organizationId: true,
                    status: true,
                  },
                },
              },
            },
          },
        },
      },
    })
  );

  return artifact
    ? resolveBranchArtifactContext(artifact, organizationId, options)
    : null;
}

type BranchArtifactContextRow = {
  id: string;
  organizationId: string;
  projectId: string | null;
  name: string;
  status: string;
  externalUrl: string | null;
  createdBy: { githubUsername: string | null } | null;
  branch: {
    artifactId: string;
    // Null for desktop-produced branches in non-App repos (PRD-510 D2/FR8).
    repositoryId: string | null;
    branchName: string;
    baseBranch: string | null;
    baseBranchSource: string | null;
    headSha: string | null;
    headShaSource: string | null;
    headShaObservedAt: Date | null;
    lastPushBeforeSha: string | null;
    currentPullRequestDetailId: string | null;
    checksStatus: string | null;
    checksDetailHeadSha: string | null;
    checksDetailTotalCount: number;
    checksDetailTruncated: boolean;
    checksDetailProviderState: string | null;
    checksDetailUnavailableReason: string | null;
    checksDetailUpdatedAt: Date | null;
    statusChecks: {
      providerKey: string;
      headSha: string;
      kind: string;
      name: string;
      status: string | null;
      conclusion: string | null;
      targetUrl: string | null;
      position: number;
    }[];
    fileCacheStatus: string;
    fileCacheHeadSha: string | null;
    fileCacheFileCount: number;
    fileCachePatchBytes: number;
    fileCacheUpdatedAt: Date | null;
    syncStatus: string;
    lastSyncStartedAt: Date | null;
    lastSyncCompletedAt: Date | null;
    lastSyncErrorCode: string | null;
    lastSyncErrorMessage: string | null;
    currentPullRequestDetail: {
      id: string;
      artifactId: string | null;
      branchArtifactId: string;
      // FEA-2732: nullable for desktop-produced PRs in non-App repos.
      repositoryId: string | null;
      githubId: string | null;
      number: number;
      title: string | null;
      htmlUrl: string | null;
      prState: string;
      isDraft: boolean;
      reviewDecision: string | null;
      lastVerifiedAt: Date | null;
      lastRefreshAttemptAt: Date | null;
    } | null;
    // Null for non-App branches: no installation-repo relation exists.
    repository: {
      id: string;
      githubRepoId: string | null;
      fullName: string;
      removedAt: Date | null;
      installation: {
        installationId: string;
        organizationId: string | null;
        status: string;
      };
    } | null;
  } | null;
};

type BranchRepositoryRow = NonNullable<
  NonNullable<BranchArtifactContextRow["branch"]>["repository"]
>;

async function resolveBranchArtifactContext(
  artifact: BranchArtifactContextRow,
  organizationId: string,
  options: ResolvePrContextOptions
): Promise<PrContext | null> {
  const branch = artifact.branch;
  if (!branch) {
    return null;
  }

  // Non-App branch (PRD-510 D2/FR8): no installation-repo relation, so no GitHub
  // App credential can be resolved. Branch View / provider reads are unavailable.
  const repository = branch.repository;
  if (!repository) {
    return null;
  }

  const credential = await resolveBranchRepositoryCredential(
    artifact.id,
    repository,
    organizationId,
    options.credentialMode ?? BranchViewContextCredentialMode.PinnedActiveOnly
  );
  if (!credential) {
    return null;
  }

  const repoIdentity = parseRepositoryFullName(credential.fullName);
  if (!repoIdentity) {
    log.warn("[resolve-pr-context] Could not parse branch repository name", {
      externalLinkId: artifact.id,
      fullName: credential.fullName,
    });
    return null;
  }

  const rawCurrentPr = branch.currentPullRequestDetail;
  const currentPr =
    rawCurrentPr?.branchArtifactId === branch.artifactId &&
    rawCurrentPr.repositoryId === branch.repositoryId
      ? rawCurrentPr
      : null;
  if (rawCurrentPr && !currentPr) {
    log.warn("[resolve-pr-context] Ignoring invalid current PR relation", {
      branchArtifactId: branch.artifactId,
      currentPullRequestDetailId: rawCurrentPr.id,
      currentPullRequestRepositoryId: rawCurrentPr.repositoryId,
      currentPullRequestBranchArtifactId: rawCurrentPr.branchArtifactId,
      repositoryId: branch.repositoryId,
    });
  }
  const producingDocumentId = await resolveProducingDocumentId(
    artifact.id,
    organizationId
  );

  return {
    externalLink: {
      id: artifact.id,
      title: artifact.name,
      externalUrl: artifact.externalUrl ?? "",
      status: artifact.status,
      metadata: null,
      projectId: artifact.projectId,
      organizationId: artifact.organizationId,
      createdBy: artifact.createdBy,
    },
    prMetadata: currentPr
      ? {
          number: currentPr.number,
          githubId: currentPr.githubId,
          headBranch: branch.branchName,
          baseBranch: branch.baseBranch ?? "",
          state: currentPr.prState,
        }
      : null,
    branch: {
      artifactId: branch.artifactId,
      repositoryId: branch.repositoryId,
      branchName: branch.branchName,
      baseBranch: branch.baseBranch,
      baseBranchSource: branch.baseBranchSource,
      headSha: branch.headSha,
      headShaSource: branch.headShaSource,
      headShaObservedAt: branch.headShaObservedAt,
      lastPushBeforeSha: branch.lastPushBeforeSha,
      currentPullRequestDetailId: currentPr
        ? branch.currentPullRequestDetailId
        : null,
      checksStatus: branch.checksStatus,
      checksDetailHeadSha: branch.checksDetailHeadSha,
      checksDetailTotalCount: branch.checksDetailTotalCount,
      checksDetailTruncated: branch.checksDetailTruncated,
      checksDetailProviderState: branch.checksDetailProviderState,
      checksDetailUnavailableReason: branch.checksDetailUnavailableReason,
      checksDetailUpdatedAt: branch.checksDetailUpdatedAt,
      statusChecks: branch.statusChecks,
      fileCacheStatus: branch.fileCacheStatus,
      fileCacheHeadSha: branch.fileCacheHeadSha,
      fileCacheFileCount: branch.fileCacheFileCount,
      fileCachePatchBytes: branch.fileCachePatchBytes,
      fileCacheUpdatedAt: branch.fileCacheUpdatedAt,
      syncStatus: branch.syncStatus,
      lastSyncStartedAt: branch.lastSyncStartedAt,
      lastSyncCompletedAt: branch.lastSyncCompletedAt,
      lastSyncErrorCode: branch.lastSyncErrorCode,
      lastSyncErrorMessage: branch.lastSyncErrorMessage,
      ...(rawCurrentPr && !currentPr
        ? { invalidCurrentPullRequestRelation: true }
        : {}),
    },
    gitHubPullRequest: currentPr
      ? {
          id: currentPr.id,
          repositoryId: currentPr.repositoryId,
          documentId: producingDocumentId,
          githubId: currentPr.githubId,
          headSha: branch.headSha,
          number: currentPr.number,
          title: currentPr.title,
          htmlUrl: currentPr.htmlUrl,
          baseBranch: branch.baseBranch ?? "",
          headBranch: branch.branchName,
          state: currentPr.prState,
          isDraft: currentPr.isDraft,
          checksStatus: branch.checksStatus,
          reviewDecision: currentPr.reviewDecision,
          lastVerifiedAt: currentPr.lastVerifiedAt,
          lastRefreshAttemptAt: currentPr.lastRefreshAttemptAt,
        }
      : null,
    repositoryId: branch.repositoryId,
    credentialRepositoryId: credential.repositoryId,
    credentialSource: credential.credentialSource,
    githubRepoId: repository.githubRepoId,
    pinnedRepositoryId: branch.repositoryId,
    installationId: credential.installationId,
    owner: repoIdentity.owner,
    repo: repoIdentity.repo,
    pullNumber: currentPr?.number ?? null,
  };
}

/**
 * Resolves the live GitHub credential repository separately from the persisted
 * branch repository FK. The persisted FK remains stable branch identity; the
 * credential row is a volatile installation generation used only by callers
 * that explicitly opt into render/read recovery.
 */
async function resolveBranchRepositoryCredential(
  externalLinkId: string,
  pinnedRepository: BranchRepositoryRow,
  organizationId: string,
  credentialMode: BranchViewContextCredentialMode
): Promise<BranchRepositoryCredential | null> {
  const pinnedInstallation = pinnedRepository.installation;
  if (
    pinnedInstallation.organizationId &&
    pinnedInstallation.organizationId !== organizationId
  ) {
    return null;
  }

  if (
    pinnedInstallation.status === GitHubInstallationStatus.ACTIVE &&
    pinnedInstallation.organizationId === organizationId
  ) {
    return {
      repositoryId: pinnedRepository.id,
      githubRepoId: pinnedRepository.githubRepoId,
      fullName: pinnedRepository.fullName,
      installationId: pinnedInstallation.installationId,
      credentialSource: BranchViewContextCredentialSource.PinnedActive,
    };
  }

  if (credentialMode !== BranchViewContextCredentialMode.RenderRead) {
    return null;
  }

  const githubRepoId = pinnedRepository.githubRepoId;
  if (!githubRepoId) {
    return null;
  }

  const activeSiblings = await withDb(async (db) => {
    const repositoryRows = await db.gitHubInstallationRepository.findMany({
      where: {
        githubRepoId,
        removedAt: null,
        installation: {
          organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: {
        id: true,
        githubRepoId: true,
        fullName: true,
        installationId: true,
      },
    });
    const installations = await db.gitHubInstallation.findMany({
      where: { id: { in: repositoryRows.map((row) => row.installationId) } },
      select: { id: true, installationId: true },
    });
    const installationById = new Map(
      installations.map((installation) => [
        installation.id,
        installation.installationId,
      ])
    );
    return repositoryRows.flatMap((row) => {
      const installationId = installationById.get(row.installationId);
      return installationId
        ? [
            {
              id: row.id,
              githubRepoId: row.githubRepoId,
              fullName: row.fullName,
              installationId,
            },
          ]
        : [];
    });
  });

  if (activeSiblings.length !== 1) {
    log.warn("[resolve-pr-context] Active sibling credential lookup failed", {
      externalLinkId,
      githubRepoId,
      activeSiblingCount: activeSiblings.length,
    });
    return null;
  }

  const [activeSibling] = activeSiblings;
  return {
    repositoryId: activeSibling.id,
    githubRepoId: activeSibling.githubRepoId,
    fullName: activeSibling.fullName,
    installationId: activeSibling.installationId,
    credentialSource: BranchViewContextCredentialSource.ActiveSibling,
  };
}

/**
 * Find the artifact that PRODUCES the PR (typically a Document), if any.
 * Returns the source artifact id — used to populate `PrContext.documentId`.
 */
async function resolveProducingDocumentId(
  branchArtifactId: string,
  organizationId: string
): Promise<string | null> {
  const link = await withDb((db) =>
    db.artifactLink.findFirst({
      where: {
        organizationId,
        targetId: branchArtifactId,
        source: { type: ArtifactType.DOCUMENT },
      },
      select: { sourceId: true },
    })
  );
  return link?.sourceId ?? null;
}
