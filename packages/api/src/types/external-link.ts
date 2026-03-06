// ExternalLink types for API contract

import type { JsonObject } from "./common";

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

/** Type-safe metadata for PREVIEW_DEPLOYMENT external links */
export type PreviewDeploymentMetadata = {
  state: string | null;
  environment: string | null;
  ref: string | null;
  sha: string | null;
};
