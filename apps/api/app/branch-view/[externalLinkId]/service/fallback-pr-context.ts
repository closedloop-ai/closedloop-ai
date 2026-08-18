/**
 * Build the degraded `PrContext` the Branch View's MISSING-CONTEXT lane renders
 * from, for a branch artifact the primary resolver (`resolvePrContext`) refused.
 *
 * This is the "we cannot read this through the GitHub App, but the stored
 * identity is still true" mapper: it carries whatever owner/repo/PR identity the
 * row legitimately has so the user gets a working deep-link, and invents nothing
 * when it does not. Split out of `service.ts` (ISS-5291) because that file owns
 * the render path and this owns the fallback projection.
 */

import {
  InvalidCurrentPullRequestRelationLane,
  isCurrentPullRequestRelationValid,
  logInvalidCurrentPullRequestRelation,
  type PrContext,
} from "@/lib/resolve-pr-context";

import { parseBranchViewRepositoryFullName } from "./projection-helpers";

type BranchArtifactFallbackRow = {
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
      branchArtifactId: string;
      // Nullable for desktop-produced PRs in non-App repos (FEA-2732).
      repositoryId: string | null;
      githubId: string | null;
      number: number;
      title: string | null;
      htmlUrl: string | null;
      prState: string;
      isDraft: boolean;
      reviewDecision: string | null;
      lastVerifiedAt?: Date | null;
      lastRefreshAttemptAt?: Date | null;
    } | null;
    // Null for non-App branches: no installation-repo relation exists.
    repository: {
      fullName: string;
      // Only `installationId` is read here; the caller owns the org and status
      // checks it selects `installation.organizationId`/`status` for.
      installation: { installationId: string };
    } | null;
  } | null;
};

/**
 * This mapper does NOT enforce tenancy. The org boundary is the caller's
 * `artifact.findFirst({ where: { id, organizationId, type: BRANCH } })` plus its
 * claimed-installation cross-org check, both in `../service.ts`; by the time a
 * row reaches here it is already this organization's.
 */
export function buildUnavailablePrContext(
  artifact: BranchArtifactFallbackRow
): PrContext {
  const branch = artifact.branch;
  if (!branch) {
    return {
      externalLink: branchViewExternalLink(artifact),
      prMetadata: null,
      branch: null,
      gitHubPullRequest: null,
      repositoryId: null,
      installationId: "",
      owner: "",
      repo: "",
      pullNumber: null,
    };
  }
  // Non-App branch (PRD-510 D2/FR8): no installation-repo, so there is no
  // owner/repo/installation identity to build a GitHub-backed context from.
  if (!branch.repository) {
    return {
      externalLink: branchViewExternalLink(artifact),
      prMetadata: null,
      branch: toPrContextBranch(branch, false),
      gitHubPullRequest: null,
      repositoryId: branch.repositoryId,
      installationId: "",
      owner: "",
      repo: "",
      pullNumber: null,
    };
  }
  // Installation status is deliberately not branched on: this lane exists BECAUSE
  // the installation is unreadable, and the stored identity is equally true for
  // an ACTIVE one the primary resolver merely declined.
  const repoIdentity = parseBranchViewRepositoryFullName(
    branch.repository.fullName
  );
  if (!repoIdentity) {
    return {
      externalLink: branchViewExternalLink(artifact),
      prMetadata: null,
      branch: toPrContextBranch(branch, false),
      gitHubPullRequest: null,
      repositoryId: branch.repositoryId,
      installationId: branch.repository.installation.installationId,
      owner: "",
      repo: "",
      pullNumber: null,
    };
  }

  return buildPrContextFromFallbackArtifact(artifact, repoIdentity);
}

function buildPrContextFromFallbackArtifact(
  artifact: BranchArtifactFallbackRow,
  repoIdentity: { owner: string; repo: string }
): PrContext {
  const branch = artifact.branch;
  const rawCurrentPr = branch?.currentPullRequestDetail ?? null;
  // The relation is an unconstrained FK, so it can resolve to a PR owned by a
  // different branch or repository. The primary resolver rejects that mismatch;
  // this degraded lane must reject it identically, or a losing-installation
  // branch would deep-link the user to an unrelated PR.
  const currentPr =
    branch && isCurrentPullRequestRelationValid(branch, rawCurrentPr)
      ? rawCurrentPr
      : null;
  if (branch && rawCurrentPr && !currentPr) {
    // Shares the primary resolver's warn, tagged with this lane: this is the ONLY
    // path a losing-installation branch reaches, so a monitor needs to know the
    // corrupt relation was found on an already-unreadable installation.
    logInvalidCurrentPullRequestRelation({
      lane: InvalidCurrentPullRequestRelationLane.MissingContextFallback,
      branch,
      currentPullRequestDetail: rawCurrentPr,
    });
  }
  return {
    externalLink: branchViewExternalLink(artifact),
    prMetadata: currentPr
      ? {
          number: currentPr.number,
          githubId: currentPr.githubId,
          headBranch: branch?.branchName ?? "",
          baseBranch: branch?.baseBranch ?? "",
          state: currentPr.prState,
        }
      : null,
    branch: branch ? toPrContextBranch(branch, Boolean(currentPr)) : null,
    gitHubPullRequest:
      branch && currentPr
        ? {
            id: currentPr.id,
            repositoryId: currentPr.repositoryId,
            documentId: null,
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
            lastVerifiedAt: currentPr.lastVerifiedAt ?? null,
            lastRefreshAttemptAt: currentPr.lastRefreshAttemptAt ?? null,
          }
        : null,
    repositoryId: branch?.repositoryId ?? null,
    installationId: branch?.repository?.installation.installationId ?? "",
    owner: repoIdentity.owner,
    repo: repoIdentity.repo,
    pullNumber: currentPr?.number ?? null,
  };
}

function branchViewExternalLink(artifact: BranchArtifactFallbackRow) {
  return {
    id: artifact.id,
    title: artifact.name,
    externalUrl: artifact.externalUrl ?? "",
    status: artifact.status,
    metadata: null,
    projectId: artifact.projectId,
    organizationId: artifact.organizationId,
    createdBy: artifact.createdBy,
  };
}

function toPrContextBranch(
  branch: NonNullable<BranchArtifactFallbackRow["branch"]>,
  hasValidCurrentPr: boolean
): NonNullable<PrContext["branch"]> {
  return {
    artifactId: branch.artifactId,
    repositoryId: branch.repositoryId,
    branchName: branch.branchName,
    baseBranch: branch.baseBranch,
    baseBranchSource: branch.baseBranchSource,
    headSha: branch.headSha,
    headShaSource: branch.headShaSource,
    headShaObservedAt: branch.headShaObservedAt,
    lastPushBeforeSha: branch.lastPushBeforeSha,
    currentPullRequestDetailId: hasValidCurrentPr
      ? branch.currentPullRequestDetailId
      : null,
    checksStatus: branch.checksStatus,
    checksDetailHeadSha: branch.checksDetailHeadSha,
    checksDetailTotalCount: branch.checksDetailTotalCount,
    checksDetailTruncated: branch.checksDetailTruncated,
    checksDetailProviderState: branch.checksDetailProviderState,
    checksDetailUnavailableReason: branch.checksDetailUnavailableReason,
    checksDetailUpdatedAt: branch.checksDetailUpdatedAt,
    statusChecks: [],
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
    ...(branch.currentPullRequestDetail && !hasValidCurrentPr
      ? { invalidCurrentPullRequestRelation: true }
      : {}),
  };
}
