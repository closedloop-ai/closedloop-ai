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
  anthropicApiKey: string | null;
  settings: JsonObject;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateOrganizationInput = {
  clerkId: string;
  name: string;
  slug: string;
  anthropicApiKey?: string | null;
};

export type UpdateOrganizationInput = {
  id: string;
  name?: string;
  slug?: string;
  anthropicApiKey?: string | null;
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

// Project types
export type Project = {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  codebaseSummary: JsonObject | null;
  lastIndexedAt: Date | null;
  settings: JsonObject;
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

export type CreateProjectInput = {
  organizationId: string;
  name: string;
  description?: string;
};

export type UpdateProjectInput = {
  id: string;
  name?: string;
  description?: string;
  settings?: JsonObject;
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
