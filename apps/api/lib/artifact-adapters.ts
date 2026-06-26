/**
 * Shared adapters that convert Prisma Artifact rows (with the appropriate
 * detail include) into API-layer wire shapes after the branch artifact cutover.
 * Where-clause helpers for durable artifact types are co-located here.
 */

import type {
  Artifact as ApiArtifact,
  DeploymentDetail as ApiDeploymentDetail,
  DeploymentArtifact,
} from "@repo/api/src/types/artifact";
import { ArtifactType as ApiArtifactType } from "@repo/api/src/types/artifact";
import type {
  BranchInfo,
  PullRequestInfo,
  PullRequestState,
} from "@repo/api/src/types/document";
import type {
  GitHubPRState,
  GitHubRepository,
} from "@repo/api/src/types/github";
import { ArtifactType as DatabaseArtifactType } from "@repo/database";

type ArtifactScalarsForPrInfo = Pick<
  ApiArtifact,
  "id" | "name" | "externalUrl" | "createdAt"
>;

type PullRequestDetailForInfo = {
  id?: string | null;
  branchArtifactId?: string | null;
  repositoryId: string;
  githubId: string;
  number: number;
  title?: string | null;
  htmlUrl?: string | null;
  body: string | null;
  prState: GitHubPRState;
  isDraft: boolean;
  reviewDecision: PullRequestInfo["reviewDecision"];
  closedAt: Date | null;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
  lastVerifiedAt: Date | null;
  lastRefreshAttemptAt: Date | null;
  isCurrent?: boolean;
};

type PullRequestDetailWithRepository = PullRequestDetailForInfo & {
  repository?: Pick<GitHubRepository, "fullName"> | null;
};

type BranchArtifactScalars = Pick<
  ApiArtifact,
  "id" | "name" | "externalUrl" | "createdAt"
>;

type BranchDetailWithCurrentPr = {
  branchName: string;
  baseBranch: string | null;
  headSha: string | null;
  checksStatus: PullRequestInfo["checksStatus"];
  repository?: Pick<GitHubRepository, "fullName"> | null;
  currentPullRequestDetail?: PullRequestDetailWithRepository | null;
};

type ArtifactWithBranchDetail = BranchArtifactScalars & {
  branch: BranchDetailWithCurrentPr | null;
};

type DeploymentArtifactScalars = Pick<
  ApiArtifact,
  | "id"
  | "organizationId"
  | "projectId"
  | "name"
  | "slug"
  | "status"
  | "priority"
  | "assigneeId"
  | "dueDate"
  | "externalUrl"
  | "sortOrder"
  | "createdAt"
  | "createdById"
  | "updatedAt"
>;

type ArtifactWithDeploymentDetail = DeploymentArtifactScalars & {
  deployment: ApiDeploymentDetail | null;
};

// ---------------------------------------------------------------------------
// PullRequestInfo adapter
// ---------------------------------------------------------------------------

export type PullRequestInfoOptions = {
  /** Artifact id of the PR (preserved for backwards-compat with consumers
   * that still call this field `externalLinkId`). */
  externalLinkId?: string | null;
  /** Fallback repo full name (e.g. "owner/repo") when the detail row is
   * fetched without the repository relation. When `pullRequest.repository`
   * is present it takes precedence over this value. */
  repoFullName?: string | null;
  branchName?: string | null;
  baseBranch?: string | null;
  checksStatus?: PullRequestInfo["checksStatus"];
};

export function branchArtifactToInfo(
  artifact: ArtifactWithBranchDetail,
  options: PullRequestInfoOptions = {}
): BranchInfo | null {
  const detail = artifact.branch;
  if (!detail) {
    return null;
  }
  const currentPullRequest = detail.currentPullRequestDetail
    ? pullRequestDetailToInfo(detail.currentPullRequestDetail, artifact, {
        externalLinkId: artifact.id,
        repoFullName: detail.repository?.fullName ?? options.repoFullName,
        branchName: detail.branchName,
        baseBranch: detail.baseBranch,
        checksStatus: detail.checksStatus,
      })
    : null;
  return {
    id: artifact.id,
    name: artifact.name,
    htmlUrl: artifact.externalUrl,
    branchName: detail.branchName,
    baseBranch: detail.baseBranch,
    headSha: detail.headSha,
    checksStatus: detail.checksStatus,
    externalLinkId: options.externalLinkId ?? artifact.id,
    repoFullName: detail.repository?.fullName ?? options.repoFullName ?? null,
    currentPullRequest,
  };
}

function pullRequestDetailToInfo(
  detail: PullRequestDetailWithRepository,
  artifact: ArtifactScalarsForPrInfo,
  options: PullRequestInfoOptions = {}
): PullRequestInfo {
  return {
    id: detail.branchArtifactId ?? detail.id ?? artifact.id,
    number: detail.number,
    title: detail.title ?? artifact.name,
    htmlUrl: detail.htmlUrl ?? artifact.externalUrl ?? "",
    state: prStateToApi(detail.prState),
    isDraft: detail.isDraft,
    headBranch: options.branchName ?? artifact.name,
    baseBranch: options.baseBranch ?? "",
    createdAt: artifact.createdAt,
    checksStatus: options.checksStatus ?? null,
    reviewDecision: detail.reviewDecision,
    externalLinkId: options.externalLinkId ?? null,
    repoFullName: detail.repository?.fullName ?? options.repoFullName ?? null,
  };
}

function prStateToApi(state: GitHubPRState): PullRequestState {
  // This function is for type-safety only. The enum values mirror the API type values at runtime.
  return state;
}

// ---------------------------------------------------------------------------
// DeploymentArtifact adapter
// ---------------------------------------------------------------------------

/** Shape a deployment artifact row into the API-layer wire type. */
export function deploymentArtifactToInfo(
  artifact: ArtifactWithDeploymentDetail
): DeploymentArtifact | null {
  const detail = artifact.deployment;
  if (!detail) {
    return null;
  }
  return {
    id: artifact.id,
    organizationId: artifact.organizationId,
    projectId: artifact.projectId,
    name: artifact.name,
    slug: artifact.slug,
    status: artifact.status,
    priority: artifact.priority,
    assigneeId: artifact.assigneeId,
    assignee: null,
    dueDate: artifact.dueDate,
    externalUrl: artifact.externalUrl,
    sortOrder: artifact.sortOrder,
    createdAt: artifact.createdAt,
    createdById: artifact.createdById,
    updatedAt: artifact.updatedAt,
    type: ApiArtifactType.Deployment,
    subtype: null,
    deployment: {
      environment: detail.environment,
      ref: detail.ref,
      sha: detail.sha,
      githubStatusUrl: detail.githubStatusUrl,
      githubDeploymentUrl: detail.githubDeploymentUrl,
      transient: detail.transient,
      production: detail.production,
      branchArtifactId: detail.branchArtifactId,
    },
  };
}

// ---------------------------------------------------------------------------
// Where-clause helpers
// ---------------------------------------------------------------------------

export function documentWhere<T extends Record<string, unknown>>(where: T) {
  return { ...where, type: DatabaseArtifactType.DOCUMENT };
}

export function deploymentWhere<T extends Record<string, unknown>>(where: T) {
  return { ...where, type: DatabaseArtifactType.DEPLOYMENT };
}
