// Organization, User, Project, Repository types for API contract
// These are explicitly defined to keep packages/api independent of database

import type { ApproverRole } from "./artifact";
import type { JsonObject } from "./common";

export type Organization = {
  id: string;
  clerkId: string;
  name: string;
  slug: string;
  active: boolean;
  settings: JsonObject;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateOrganizationInput = {
  clerkId: string;
  name: string;
  slug: string;
};

export type UpdateOrganizationInput = {
  id: string;
  name?: string;
  slug?: string;
  settings?: JsonObject;
  active?: boolean;
};

// User types
export type User = {
  id: string;
  clerkId: string;
  organizationId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  phoneNumber: string | null;
  role: ApproverRole;
  linearId: string | null;
  slackId: string | null;
  githubUsername: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateUserInput = {
  clerkId: string;
  organizationId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  phoneNumber?: string | null;
  role?: ApproverRole;
};

export type UpdateUserInput = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  phoneNumber?: string | null;
  role?: ApproverRole;
  linearId?: string | null;
  slackId?: string | null;
  githubUsername?: string | null;
  active?: boolean;
};

export type UpdateUserProfileFromClerkInput = {
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  phoneNumber?: string | null;
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

export type ProjectOwner = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
};

export type Project = {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  priority: ProjectPriority;
  ownerId: string | null;
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
  owner?: ProjectOwner;
  status: number; // 0-100 percentage
  teams: Array<{ id: string; name: string }>;
};

export type CreateProjectInput = {
  name: string;
  description?: string;
  priority?: ProjectPriority;
  ownerId?: string | null;
  targetDate?: Date | null;
  teamIds?: string[];
};

export type UpdateProjectInput = {
  id: string;
  name?: string;
  description?: string;
  priority?: ProjectPriority;
  ownerId?: string | null;
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
