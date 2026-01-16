// Organization, User, Project, Repository types for API contract
// These are explicitly defined to keep packages/api independent of database

import type { JsonObject } from "./common";

export type Organization = {
  id: string;
  name: string;
  slug: string;
  anthropicApiKey: string | null;
  settings: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateOrganizationInput = {
  name: string;
  slug: string;
  anthropicApiKey?: string;
};

export type UpdateOrganizationInput = {
  id: string;
  name?: string;
  slug?: string;
  anthropicApiKey?: string;
  settings?: JsonObject;
};

// User types
export type User = {
  id: string;
  organizationId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: "PM" | "DESIGNER" | "TECH_LEAD" | "ENGINEER" | "STAKEHOLDER";
  linearUserId: string | null;
  slackUserId: string | null;
  githubUsername: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateUserInput = {
  organizationId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  role?: "PM" | "DESIGNER" | "TECH_LEAD" | "ENGINEER" | "STAKEHOLDER";
};

export type UpdateUserInput = {
  id: string;
  name?: string;
  avatarUrl?: string;
  role?: "PM" | "DESIGNER" | "TECH_LEAD" | "ENGINEER" | "STAKEHOLDER";
  linearUserId?: string;
  slackUserId?: string;
  githubUsername?: string;
};

// Project types
export type Project = {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  codebaseSummary: unknown;
  lastIndexedAt: Date | null;
  settings: unknown;
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
