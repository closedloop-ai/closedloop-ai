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

export type FavoriteResponse = {
  favorited: boolean;
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

// Project settings (stored in the `settings` JSON field)
export type DefaultRepository = {
  repoId: string;
  repoFullName: string;
  branch: string;
};

export type ProjectSettings = {
  defaultRepository?: DefaultRepository;
};

export function getProjectSettings(settings: JsonObject): ProjectSettings {
  const raw = settings as Record<string, unknown>;
  const defaultRepository = raw.defaultRepository;
  if (
    defaultRepository &&
    typeof defaultRepository === "object" &&
    defaultRepository !== null &&
    "repoId" in defaultRepository &&
    "repoFullName" in defaultRepository &&
    "branch" in defaultRepository &&
    typeof (defaultRepository as Record<string, unknown>).repoId === "string" &&
    typeof (defaultRepository as Record<string, unknown>).repoFullName ===
      "string" &&
    typeof (defaultRepository as Record<string, unknown>).branch === "string"
  ) {
    return { defaultRepository: defaultRepository as DefaultRepository };
  }
  return {};
}
