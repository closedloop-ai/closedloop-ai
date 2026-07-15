import {
  GitHubInstallationStatus,
  type TransactionClient,
} from "@repo/database";

export const GitHubCommentOwnerFailureReason = {
  UnmatchedInstallation: "unmatched_installation",
  InactiveInstallation: "inactive_installation",
  MissingRepository: "missing_repository",
  MissingPullRequestDetail: "missing_pull_request_detail",
  AmbiguousOwner: "ambiguous_owner",
} as const;

export type GitHubCommentOwnerFailureReason =
  (typeof GitHubCommentOwnerFailureReason)[keyof typeof GitHubCommentOwnerFailureReason];

export type GitHubCommentOwnerSuccess = {
  ok: true;
  organizationId: string;
  installationRecordId: string;
  repositoryRecordId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
};

export type GitHubCommentOwnerFailure = {
  ok: false;
  code: GitHubCommentOwnerFailureReason;
};

export type GitHubCommentOwnerResolution =
  | GitHubCommentOwnerSuccess
  | GitHubCommentOwnerFailure;

type GitHubCommentOwnerInput = {
  installationId: number;
  repositoryId: number;
  pullNumber: number;
  organizationId?: string;
};

type ResolvedOwnerCallback = (
  owner: GitHubCommentOwnerSuccess
) => void | Promise<void>;

type InstallationOwnerRow = {
  id: string;
  organizationId: string | null;
  status: string;
};

function isActiveOwnedInstallation(
  installation: InstallationOwnerRow
): installation is InstallationOwnerRow & { organizationId: string } {
  return (
    installation.status === GitHubInstallationStatus.ACTIVE &&
    typeof installation.organizationId === "string"
  );
}

/**
 * Resolve the persisted owner for PR comment webhooks using the authoritative
 * GitHub delivery identity: installation id, repository id, and pull number.
 *
 * The optional callback is a no-write guard for callers and tests: it is
 * invoked only after all owner checks succeed, never for `ok:false` results.
 */
export async function resolveGitHubCommentOwner(
  tx: TransactionClient,
  input: GitHubCommentOwnerInput,
  onResolved?: ResolvedOwnerCallback
): Promise<GitHubCommentOwnerResolution> {
  const installations = await tx.gitHubInstallation.findMany({
    where: { installationId: String(input.installationId) },
    select: { id: true, organizationId: true, status: true },
    take: 2,
  });

  if (installations.length === 0) {
    return failure(GitHubCommentOwnerFailureReason.UnmatchedInstallation);
  }

  const activeInstallations = installations.filter(isActiveOwnedInstallation);

  if (activeInstallations.length === 0) {
    return failure(GitHubCommentOwnerFailureReason.InactiveInstallation);
  }

  if (activeInstallations.length > 1) {
    return failure(GitHubCommentOwnerFailureReason.AmbiguousOwner);
  }

  const installation = activeInstallations[0];
  if (
    input.organizationId &&
    installation.organizationId !== input.organizationId
  ) {
    return failure(GitHubCommentOwnerFailureReason.AmbiguousOwner);
  }

  const repositories = await tx.gitHubInstallationRepository.findMany({
    where: {
      installationId: installation.id,
      githubRepoId: String(input.repositoryId),
      removedAt: null,
    },
    select: { id: true },
    take: 2,
  });

  if (repositories.length === 0) {
    return failure(GitHubCommentOwnerFailureReason.MissingRepository);
  }

  if (repositories.length > 1) {
    return failure(GitHubCommentOwnerFailureReason.AmbiguousOwner);
  }

  const repository = repositories[0];

  const pullRequestDetails = await tx.pullRequestDetail.findMany({
    where: {
      repositoryId: repository.id,
      number: input.pullNumber,
    },
    select: {
      id: true,
      branchArtifactId: true,
      branchArtifact: {
        select: { organizationId: true },
      },
    },
    take: 2,
  });

  if (pullRequestDetails.length === 0) {
    return failure(GitHubCommentOwnerFailureReason.MissingPullRequestDetail);
  }

  if (pullRequestDetails.length > 1) {
    return failure(GitHubCommentOwnerFailureReason.AmbiguousOwner);
  }

  const pullRequestDetail = pullRequestDetails[0];
  if (
    pullRequestDetail.branchArtifact.organizationId !==
    installation.organizationId
  ) {
    return failure(GitHubCommentOwnerFailureReason.AmbiguousOwner);
  }

  const result: GitHubCommentOwnerSuccess = {
    ok: true,
    organizationId: installation.organizationId,
    installationRecordId: installation.id,
    repositoryRecordId: repository.id,
    branchArtifactId: pullRequestDetail.branchArtifactId,
    pullRequestDetailId: pullRequestDetail.id,
  };

  await onResolved?.(result);
  return result;
}

function failure(
  code: GitHubCommentOwnerFailureReason
): GitHubCommentOwnerFailure {
  return { ok: false, code };
}
