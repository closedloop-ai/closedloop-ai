// Team types for API contract
// These are explicitly defined to keep packages/api independent of database

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
  user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
    avatarUrl: string | null;
  };
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
