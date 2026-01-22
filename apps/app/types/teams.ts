// Teams and Projects types for frontend
// These will be aligned with backend types when API is implemented

// Team types
export type Team = {
  id: string;
  name: string;
  slug: string;
  organizationId?: string;
  createdAt: string;
  updatedAt: string;
};

export const TeamRole = {
  Owner: "OWNER",
  Admin: "ADMIN",
  Member: "MEMBER",
} as const;
export type TeamRole = (typeof TeamRole)[keyof typeof TeamRole];

export type TeamMember = {
  id: string;
  userId: string;
  teamId: string;
  role: TeamRole;
  user: {
    id: string;
    name: string;
    email: string;
    avatarUrl?: string;
  };
};

// Project types
export const ProjectPriority = {
  NotSet: "NOT_SET",
  Low: "LOW",
  Medium: "MEDIUM",
  High: "HIGH",
} as const;
export type ProjectPriority =
  (typeof ProjectPriority)[keyof typeof ProjectPriority];
export const PROJECT_PRIORITY_OPTIONS = Object.values(ProjectPriority);

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
  Issues: "ISSUES",
  FeatureBranches: "FEATURE_BRANCHES",
} as const;
export type ProjectArtifactType =
  (typeof ProjectArtifactType)[keyof typeof ProjectArtifactType];

export type ProjectArtifact = {
  id: string;
  name: string;
  type: ProjectArtifactType;
  status: ArtifactDisplayStatus;
  link?: string;
};

// Activity types
export const ActivityType = {
  ArtifactCreated: "ARTIFACT_CREATED",
  ArtifactUpdated: "ARTIFACT_UPDATED",
  ProjectCreated: "PROJECT_CREATED",
  StateChanged: "STATE_CHANGED",
  ApprovalRequested: "APPROVAL_REQUESTED",
  ApprovalGranted: "APPROVAL_GRANTED",
} as const;
export type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];

export type ActivityItem = {
  id: string;
  type: ActivityType;
  actor: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  description: string;
  timestamp: string;
};

// Input types for creating/updating
export type CreateTeamInput = {
  name: string;
  slug?: string;
};

export type CreateProjectInput = {
  name: string;
  description?: string;
  priority?: ProjectPriority;
  ownerId?: string;
  targetDate?: string;
  teamIds: string[];
};

export type UpdateProjectInput = {
  name?: string;
  description?: string;
  priority?: ProjectPriority;
  ownerId?: string | null;
  targetDate?: string | null;
  teamIds?: string[];
  repositoryIds?: string[];
};
