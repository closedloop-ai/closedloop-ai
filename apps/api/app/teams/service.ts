import type {
  AddTeamMemberInput,
  CreateTeamInput,
  TeamMember,
  TeamRole,
  UpdateTeamInput,
  UpdateTeamMemberInput,
} from "@repo/api/src/types/teams";
import { database } from "@repo/database";

/**
 * Standard select pattern for user fields in team member queries
 */
const USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  avatarUrl: true,
} as const;

/**
 * Standard include pattern for team member queries with user info
 */
const MEMBER_WITH_USER_INCLUDE = {
  user: { select: USER_SELECT },
} as const;

/** Type for team member returned from database with user include */
type TeamMemberFromDb = NonNullable<
  Awaited<ReturnType<typeof teamsService.getMember>>
>;

/**
 * Transform a database team member to API TeamMember format
 */
export function toTeamMemberApi(member: TeamMemberFromDb): TeamMember {
  return {
    id: member.id,
    teamId: member.teamId,
    userId: member.userId,
    role: member.role as TeamRole,
    createdAt: member.createdAt,
    user: {
      id: member.user.id,
      firstName: member.user.firstName,
      lastName: member.user.lastName,
      email: member.user.email,
      avatarUrl: member.user.avatarUrl,
    },
  };
}

/**
 * Helper to generate a URL-safe slug from a name
 */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Teams service - handles database operations for team management
 */
export const teamsService = {
  /**
   * Find all teams for an organization
   */
  findByOrganization(organizationId: string) {
    return database.team.findMany({
      where: { organizationId },
      include: {
        _count: { select: { members: true, projects: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  },

  /**
   * Find a team by ID
   */
  findById(id: string) {
    return database.team.findUnique({
      where: { id },
      include: {
        members: {
          include: MEMBER_WITH_USER_INCLUDE,
        },
        _count: { select: { members: true, projects: true } },
      },
    });
  },

  /**
   * Find a team by organization and slug
   */
  findByOrgAndSlug(organizationId: string, slug: string) {
    return database.team.findUnique({
      where: {
        organizationId_slug: { organizationId, slug },
      },
    });
  },

  /**
   * Create a new team
   */
  create(input: CreateTeamInput) {
    const slug = input.slug || generateSlug(input.name);
    return database.team.create({
      data: {
        organizationId: input.organizationId,
        name: input.name,
        slug,
      },
    });
  },

  /**
   * Create a team and add the creator as owner
   */
  createWithOwner(input: CreateTeamInput, creatorUserId: string) {
    const slug = input.slug || generateSlug(input.name);

    return database.$transaction(async (tx) => {
      const team = await tx.team.create({
        data: {
          organizationId: input.organizationId,
          name: input.name,
          slug,
        },
      });

      await tx.teamMember.create({
        data: {
          teamId: team.id,
          userId: creatorUserId,
          role: "OWNER",
        },
      });

      return team;
    });
  },

  /**
   * Update a team
   */
  update(id: string, input: Omit<UpdateTeamInput, "id">) {
    return database.team.update({
      where: { id },
      data: input,
    });
  },

  /**
   * Delete a team
   */
  delete(id: string) {
    // Delete team members first, then project associations, then the team
    return database.$transaction(async (tx) => {
      await tx.teamMember.deleteMany({ where: { teamId: id } });
      await tx.projectTeam.deleteMany({ where: { teamId: id } });
      return tx.team.delete({ where: { id } });
    });
  },

  // ==================== Team Members ====================

  /**
   * Get all members of a team
   */
  getMembers(teamId: string) {
    return database.teamMember.findMany({
      where: { teamId },
      include: MEMBER_WITH_USER_INCLUDE,
      orderBy: { createdAt: "asc" },
    });
  },

  /**
   * Get a specific team member
   */
  getMember(teamId: string, userId: string) {
    return database.teamMember.findUnique({
      where: {
        teamId_userId: { teamId, userId },
      },
      include: MEMBER_WITH_USER_INCLUDE,
    });
  },

  /**
   * Add a member to a team
   */
  addMember(input: AddTeamMemberInput) {
    return database.teamMember.create({
      data: {
        teamId: input.teamId,
        userId: input.userId,
        role: input.role ?? "MEMBER",
      },
      include: MEMBER_WITH_USER_INCLUDE,
    });
  },

  /**
   * Update a team member's role
   */
  updateMemberRole(input: UpdateTeamMemberInput) {
    return database.teamMember.update({
      where: {
        teamId_userId: { teamId: input.teamId, userId: input.userId },
      },
      data: { role: input.role },
      include: MEMBER_WITH_USER_INCLUDE,
    });
  },

  /**
   * Remove a member from a team
   */
  removeMember(teamId: string, userId: string) {
    return database.teamMember.delete({
      where: {
        teamId_userId: { teamId, userId },
      },
    });
  },

  /**
   * Check if a user is a member of a team
   */
  async isMember(teamId: string, userId: string): Promise<boolean> {
    const member = await database.teamMember.findUnique({
      where: {
        teamId_userId: { teamId, userId },
      },
    });
    return member !== null;
  },

  /**
   * Check if a user has a specific role (or higher) in a team
   * Role hierarchy: OWNER > ADMIN > MEMBER
   */
  async hasRole(
    teamId: string,
    userId: string,
    requiredRole: TeamRole
  ): Promise<boolean> {
    const member = await database.teamMember.findUnique({
      where: {
        teamId_userId: { teamId, userId },
      },
    });

    if (!member) {
      return false;
    }

    const roleHierarchy: Record<TeamRole, number> = {
      OWNER: 3,
      ADMIN: 2,
      MEMBER: 1,
    };

    return roleHierarchy[member.role] >= roleHierarchy[requiredRole];
  },

  /**
   * Get all teams a user belongs to
   */
  findByUser(userId: string) {
    return database.teamMember.findMany({
      where: { userId },
      include: {
        team: {
          include: {
            _count: { select: { members: true, projects: true } },
          },
        },
      },
    });
  },
};
