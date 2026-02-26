import type { JsonObject, Priority } from "./common";
import type { BasicUser } from "./user";

export const ProjectStatus = {
  NotStarted: "NOT_STARTED",
  InProgress: "IN_PROGRESS",
  Completed: "COMPLETED",
  Archived: "ARCHIVED",
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export type Project = {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  priority: Priority;
  status: ProjectStatus;
  assigneeId: string | null;
  createdById: string;
  slug: string | null;
  targetDate: Date | null;
  codebaseSummary: string | null;
  lastIndexedAt: Date | null;
  settings: JsonObject;
  sortOrder: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectWithOrganization = Project & {
  organization: {
    id: string;
    name: string;
    slug: string;
  };
};

export type ProjectWithDetails = Project & {
  assignee?: BasicUser;
  completionPercentage: number; // 0-100 percentage from calculateStatus()
  teams: Array<{ id: string; name: string }>;
};

export type CreateProjectInput = {
  name: string;
  description?: string;
  priority?: Priority;
  status?: ProjectStatus;
  assigneeId?: string | null;
  slug?: string | null;
  targetDate?: Date | null;
  teamIds?: string[];
};

export type UpdateProjectInput = {
  id: string;
  name?: string;
  description?: string;
  priority?: Priority;
  status?: ProjectStatus;
  assigneeId?: string | null;
  slug?: string | null;
  targetDate?: Date | null;
  teamIds?: string[];
  settings?: JsonObject;
  codebaseSummary?: string | null;
  lastIndexedAt?: Date | null;
};

// Repository types
export type Repository = {
  id: string;
  projectId: string;
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateRepositoryInput = {
  projectId: string;
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch?: string;
  isPrimary?: boolean;
};
