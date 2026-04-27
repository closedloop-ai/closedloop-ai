// Artifact types for API contract.
// Mirrors the Prisma schema's class-table-inheritance shape: one parent
// record (Artifact) plus one of three type-specific detail objects, each
// identified by `Artifact.type`.

import type { JsonObject, Priority } from "./common";
import type { BasicUser } from "./user";

export const ArtifactType = {
  Document: "DOCUMENT",
  PullRequest: "PULL_REQUEST",
  Deployment: "DEPLOYMENT",
} as const;
export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType];

export const ArtifactSubtype = {
  Prd: "PRD",
  ImplementationPlan: "IMPLEMENTATION_PLAN",
  Template: "TEMPLATE",
  Feature: "FEATURE",
} as const;
export type ArtifactSubtype =
  (typeof ArtifactSubtype)[keyof typeof ArtifactSubtype];

/**
 * Parent-row fields common to every artifact type. Per-type detail objects
 * extend this base in the discriminated union below.
 */
export type Artifact = {
  id: string;
  organizationId: string;
  projectId: string;
  workstreamId: string | null;
  type: ArtifactType;
  subtype: ArtifactSubtype | null;
  name: string;
  slug: string | null;
  status: string;
  priority: Priority | null;
  assigneeId: string | null;
  assignee: BasicUser | null;
  dueDate: Date | null;
  externalUrl: string | null;
  sortOrder: number | null;
  createdAt: Date;
  createdById: string | null;
  updatedAt: Date;
};

export type DocumentDetail = {
  fileName: string | null;
  approverId: string | null;
  approver: BasicUser | null;
  templateForType: ArtifactSubtype | null;
  latestVersion: number;
  targetRepo: string | null;
  targetBranch: string | null;
};

export type PullRequestDetail = {
  repositoryId: string;
  githubId: string;
  number: number;
  body: string | null;
  headBranch: string;
  baseBranch: string;
  headSha: string | null;
  isDraft: boolean;
  checksStatus: string | null;
  reviewDecision: string | null;
  closedAt: Date | null;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
  lastVerifiedAt: Date | null;
  lastRefreshAttemptAt: Date | null;
};

export type DeploymentDetail = {
  environment: string | null;
  ref: string | null;
  sha: string | null;
  githubStatusUrl: string | null;
  githubDeploymentUrl: string | null;
  transient: boolean | null;
  production: boolean | null;
  pullRequestArtifactId: string | null;
};

/**
 * Discriminated union of every artifact-shaped record returned by the API.
 * Callers narrow on `type` to access the correct detail fields.
 */
export type DocumentArtifact = Omit<Artifact, "type" | "subtype"> & {
  type: typeof ArtifactType.Document;
  subtype: ArtifactSubtype | null;
  document: DocumentDetail;
};

export type PullRequestArtifact = Omit<Artifact, "type" | "subtype"> & {
  type: typeof ArtifactType.PullRequest;
  subtype: null;
  pullRequest: PullRequestDetail;
};

export type DeploymentArtifact = Omit<Artifact, "type" | "subtype"> & {
  type: typeof ArtifactType.Deployment;
  subtype: null;
  deployment: DeploymentDetail;
};

export type ArtifactWithDetail =
  | DocumentArtifact
  | PullRequestArtifact
  | DeploymentArtifact;

export function isDocumentArtifact(
  artifact: ArtifactWithDetail
): artifact is DocumentArtifact {
  return artifact.type === ArtifactType.Document;
}

export function isPullRequestArtifact(
  artifact: ArtifactWithDetail
): artifact is PullRequestArtifact {
  return artifact.type === ArtifactType.PullRequest;
}

export function isDeploymentArtifact(
  artifact: ArtifactWithDetail
): artifact is DeploymentArtifact {
  return artifact.type === ArtifactType.Deployment;
}

// ---------------------------------------------------------------------------
// ArtifactLink — replaces the legacy EntityLink polymorphic relationship
// ---------------------------------------------------------------------------

export const LinkType = {
  Produces: "PRODUCES",
  Blocks: "BLOCKS",
  RelatesTo: "RELATES_TO",
} as const;
export type LinkType = (typeof LinkType)[keyof typeof LinkType];

export const LinkDirection = {
  Source: "source",
  Target: "target",
  Both: "both",
} as const;
export type LinkDirection = (typeof LinkDirection)[keyof typeof LinkDirection];

export const LinkQueryMode = {
  Direct: "direct",
  Tree: "tree",
} as const;
export type LinkQueryMode = (typeof LinkQueryMode)[keyof typeof LinkQueryMode];

export type ArtifactLink = {
  id: string;
  organizationId: string;
  sourceId: string;
  targetId: string;
  linkType: LinkType;
  metadata: JsonObject | null;
  createdAt: Date;
};

export type CreateArtifactLinkInput = {
  sourceId: string;
  targetId: string;
  linkType: LinkType;
  metadata?: JsonObject | null;
};

/** Minimal endpoint shape returned by /artifact-links/resolved. */
export type ArtifactLinkEndpoint = Omit<Artifact, "assignee">;

/** A hydrated artifact link with source + target endpoints resolved. */
export type ArtifactLinkWithEndpoints = ArtifactLink & {
  source: ArtifactLinkEndpoint;
  target: ArtifactLinkEndpoint;
};

export type FindArtifactLinksOptions = {
  artifactId: string;
  linkType?: LinkType;
  direction?: LinkDirection;
  mode?: LinkQueryMode;
  maxDepth?: number;
};

export type BatchMoveArtifactsInput = {
  artifactId: string;
  targetProjectId: string;
  includeDownstream: boolean;
};

export type BatchMoveArtifactsResult = {
  movedArtifacts: { id: string; type: ArtifactType }[];
};
