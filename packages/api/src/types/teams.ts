// Team types for API contract
// These are explicitly defined to keep packages/api independent of database

export type TeamRole = "OWNER" | "ADMIN" | "MEMBER";

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
  organizationId: string;
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
