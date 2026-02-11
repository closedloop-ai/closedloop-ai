import type { PullRequestInfo } from "@repo/api/src/types/artifact";
import type { ProjectPriority } from "@repo/api/src/types/organization";

// TODO: Move all types to packages/api.

// Project types
export type ProjectOwner = {
  id: string;
  name: string;
  avatarUrl?: string;
  initials?: string;
};

export type ProjectTeam = {
  id: string;
  name: string;
};

export type ProjectRepository = {
  id: string;
  name: string;
  url?: string;
};

export type ProjectWithDetails = {
  id: string;
  name: string;
  description?: string;
  priority: ProjectPriority;
  owner?: ProjectOwner;
  targetDate?: string;
  status: number; // 0-100 percentage
  teams: ProjectTeam[];
  repositories?: ProjectRepository[];
  createdAt: string;
  updatedAt: string;
};

// Artifact display types (different from backend ArtifactStatus)
export const ArtifactDisplayStatus = {
  WontDo: "WONT_DO",
  Complete: "COMPLETE",
  NotStarted: "NOT_STARTED",
  NotPublished: "NOT_PUBLISHED",
} as const;
export type ArtifactDisplayStatus =
  (typeof ArtifactDisplayStatus)[keyof typeof ArtifactDisplayStatus];
export const ARTIFACT_DISPLAY_STATUS_OPTIONS = Object.values(
  ArtifactDisplayStatus
);

// ProjectArtifactSubtype extends ArtifactSubtype from @repo/api/src/types/artifact.ts
// with legacy display-only values (PROJECT_BRIEF, DESIGNS, BRANCH) that exist
// only in the frontend for UI grouping. This const provides type-safe access to subtype
// literals used in the project detail page.
export const ProjectArtifactSubtype = {
  ProjectBrief: "PROJECT_BRIEF",
  Prd: "PRD",
  Designs: "DESIGNS",
  ImplementationPlan: "IMPLEMENTATION_PLAN",
  ImplementationStrategy: "IMPLEMENTATION_STRATEGY",
  Issue: "ISSUE",
  Bug: "BUG",
  Template: "TEMPLATE",
  Branch: "BRANCH",
} as const;
export type ProjectArtifactSubtype =
  (typeof ProjectArtifactSubtype)[keyof typeof ProjectArtifactSubtype];

export type ProjectArtifact = {
  id: string;
  documentSlug: string | null;
  name: string;
  subtype: ProjectArtifactSubtype;
  status: ArtifactDisplayStatus;
  parentId?: string | null;
  link?: string;
  previewUrl?: string;
  pullRequest?: PullRequestInfo | null;
  workstreamId?: string | null;
  workstreamTitle?: string | null;
  workstreamState?: string | null;
};
