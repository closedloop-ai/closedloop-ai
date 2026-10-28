// Team types for API contract
// These are explicitly defined to keep packages/api independent of database

import type { BasicUser } from "./user";

export const TeamRole = {
  Owner: "OWNER",
  Admin: "ADMIN",
  Member: "MEMBER",
} as const;
export type TeamRole = (typeof TeamRole)[keyof typeof TeamRole];

export type Team = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TeamWithCounts = Team & {
  memberCount: number;
  projectCount: number;
};

export type TeamMember = {
  id: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  createdAt: Date;
  user: BasicUser;
};

export type CreateTeamInput = {
  name: string;
  slug?: string; // Auto-generated if not provided
};

export type UpdateTeamInput = {
  id: string;
  name?: string;
  slug?: string;
};

export type AddTeamMemberInput = {
  teamId: string;
  userId: string;
  role?: TeamRole;
};

export type UpdateTeamMemberInput = {
  teamId: string;
  userId: string;
  role: TeamRole;
};

export type TeamRepositoryRepoSummary = {
  id: string;
  installationId: string;
  githubRepoId: string;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
};

export type TeamRepository = {
  id: string;
  teamId: string;
  installationRepositoryId: string;
  isDefaultSelected: boolean;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
  repository: TeamRepositoryRepoSummary;
};

export type AddTeamRepositoryInput = {
  installationRepositoryId: string;
  isDefaultSelected?: boolean;
  isPrimary?: boolean;
};

export type UpdateTeamRepositoryInput = {
  isDefaultSelected?: boolean;
  isPrimary?: boolean;
};

/**
 * A team reduced to what a caller needs to pick one: its id and its display
 * name. This is the shape `ProjectWithDetails.teams` and
 * `DocumentWithProject.project.teams` already carried inline, and the shape the
 * `project_team_required` 400 lists so a caller can retry with a real team.
 *
 * Must stay a `type` alias, never an `interface`: only aliases get TypeScript's
 * implicit index signature, and without it an array of these cannot satisfy the
 * `JsonObject` that error `details` is typed as.
 */
export type ProjectTeamOption = {
  id: string;
  name: string;
};
