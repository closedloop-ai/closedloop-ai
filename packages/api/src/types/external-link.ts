// ExternalLink types for API contract

import type { JsonObject } from "./common";
import type { GitHubPRState } from "./github";

export const ExternalLinkType = {
  PullRequest: "PULL_REQUEST",
  FigmaDesign: "FIGMA_DESIGN",
  PreviewDeployment: "PREVIEW_DEPLOYMENT",
} as const;
export type ExternalLinkType =
  (typeof ExternalLinkType)[keyof typeof ExternalLinkType];
export const EXTERNAL_LINK_TYPE_OPTIONS = Object.values(ExternalLinkType);

export type ExternalLink = {
  id: string;
  organizationId: string;
  workstreamId: string | null;
  projectId: string;
  type: ExternalLinkType;
  title: string;
  externalUrl: string;
  metadata: JsonObject | null;
  createdAt: Date;
  updatedAt: Date;
};

export type FindExternalLinksOptions = {
  workstreamId?: string;
  projectId?: string;
  type?: ExternalLinkType;
};

export type CreateExternalLinkInput = {
  workstreamId?: string;
  projectId: string;
  type: ExternalLinkType;
  title: string;
  externalUrl: string;
  metadata?: JsonObject | null;
};

export type UpdateExternalLinkInput = {
  id: string;
  title?: string;
  externalUrl?: string;
  metadata?: JsonObject | null;
};

/** Type-safe metadata for PULL_REQUEST external links */
export type PullRequestMetadata = {
  number: number;
  githubId: string;
  headBranch: string;
  baseBranch: string;
  state: GitHubPRState;
  lastVerifiedAt?: string | null;
  lastRefreshAttemptAt?: string | null;
};

/** Type-safe metadata for PREVIEW_DEPLOYMENT external links */
export type DeploymentMetadata = {
  statusUrl?: string;
  deploymentUrl?: string;
  state?: string;
  environment?: string;
  ref?: string;
  sha?: string;
  transient?: boolean;
  production?: boolean;
};
