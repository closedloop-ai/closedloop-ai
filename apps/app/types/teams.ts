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

export const ProjectArtifactType = {
  ProjectBrief: "PROJECT_BRIEF",
  Prd: "PRD",
  Designs: "DESIGNS",
  ImplementationPlan: "IMPLEMENTATION_PLAN",
  Issue: "ISSUE",
  FeatureBranches: "FEATURE_BRANCHES",
} as const;
export type ProjectArtifactType =
  (typeof ProjectArtifactType)[keyof typeof ProjectArtifactType];

export type ProjectArtifact = {
  id: string;
  documentSlug: string | null;
  name: string;
  type: ProjectArtifactType;
  status: ArtifactDisplayStatus;
  link?: string;
};
