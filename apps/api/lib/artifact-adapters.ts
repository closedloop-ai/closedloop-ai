/**
 * Shared adapters that convert Prisma Artifact rows (with the appropriate
 * detail include) into the API-layer `PullRequestInfo` wire shape. Remaining
 * adapter utilities after the artifact cutover. Where-clause helpers for the
 * three artifact types are co-located here.
 */

import type { DeploymentArtifact } from "@repo/api/src/types/artifact";
import { ArtifactType as ApiArtifactType } from "@repo/api/src/types/artifact";
import type {
  PullRequestInfo,
  PullRequestState,
} from "@repo/api/src/types/document";
import {
  type Artifact,
  ArtifactType,
  type DeploymentDetail,
  type GitHubPRState,
  type PullRequestDetail,
} from "@repo/database";

type ArtifactWithPullRequestDetail = Artifact & {
  pullRequest: PullRequestDetail | null;
};

type ArtifactWithDeploymentDetail = Artifact & {
  deployment: DeploymentDetail | null;
};

// ---------------------------------------------------------------------------
// PullRequestInfo adapter
// ---------------------------------------------------------------------------

export type PullRequestInfoOptions = {
  /** Artifact id of the PR (preserved for backwards-compat with consumers
   * that still call this field `externalLinkId`). */
  externalLinkId?: string | null;
};

export function pullRequestArtifactToInfo(
  artifact: ArtifactWithPullRequestDetail,
  options: PullRequestInfoOptions = {}
): PullRequestInfo | null {
  const detail = artifact.pullRequest;
  if (!detail) {
    return null;
  }
  return {
    id: artifact.id,
    number: detail.number,
    title: artifact.name,
    htmlUrl: artifact.externalUrl ?? "",
    state: prStateToApi(detail.prState),
    headBranch: detail.headBranch,
    baseBranch: detail.baseBranch,
    createdAt: artifact.createdAt,
    checksStatus: detail.checksStatus,
    reviewDecision: detail.reviewDecision,
    externalLinkId: options.externalLinkId ?? null,
  };
}

function prStateToApi(state: GitHubPRState): PullRequestState {
  // This function is for type-safety only. The enum values mirror the API type values at runtime.
  return state;
}

// ---------------------------------------------------------------------------
// DeploymentArtifact adapter
// ---------------------------------------------------------------------------

/**
 * Shape a PULL_REQUEST-typed Artifact (with DeploymentDetail included) into
 * the API-layer DeploymentArtifact wire type. Returns null if the detail row
 * is missing.
 */
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
    workstreamId: artifact.workstreamId,
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
      pullRequestArtifactId: detail.pullRequestArtifactId,
    },
  };
}

// ---------------------------------------------------------------------------
// Where-clause helpers
// ---------------------------------------------------------------------------

export function documentWhere<T extends Record<string, unknown>>(where: T) {
  return { ...where, type: ArtifactType.DOCUMENT };
}

export function pullRequestWhere<T extends Record<string, unknown>>(where: T) {
  return { ...where, type: ArtifactType.PULL_REQUEST };
}

export function deploymentWhere<T extends Record<string, unknown>>(where: T) {
  return { ...where, type: ArtifactType.DEPLOYMENT };
}
