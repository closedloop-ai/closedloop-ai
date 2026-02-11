import type {
  AddTeamMemberInput,
  CreateTeamInput,
  TeamRole,
  TeamWithCounts,
  UpdateTeamInput,
  UpdateTeamMemberInput,
} from "@repo/api/src/types/teams";
import { withDb } from "@repo/database";

/**
 * Transform a database team to API TeamWithCounts format
 */
export function toTeamWithCounts(team: TeamWithCountsFromDb): TeamWithCounts {
  return {
    ...team,
    memberCount: team._count.members,
    projectCount: team._count.projects,
  };
}

/**
 * Helper to generate a URL-safe slug from a name
 */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

/**
 * Teams service - handles database operations for team management
 */
export const teamsService = {
  /**
   * Find all teams for an organization
   */
  findByOrganization(organizationId: string) {
    return withDb((db) =>
      db.team.findMany({
        where: { organizationId },
        include: {
          _count: { select: { members: true, projects: true } },
        },
        orderBy: { createdAt: "desc" },
      })
    );
  },

  /**
   * Find a team by ID
   */
  findById(id: string, organizationId: string) {
    return withDb((db) =>
      db.team.findUnique({
        where: { id, organizationId },
        include: {
          members: {
            include: MEMBER_WITH_USER_INCLUDE,
          },
          _count: { select: { members: true, projects: true } },
        },
      })
    );
  },

  /**
   * Find a team by organization and slug
   */
  findBySlug(slug: string, organizationId: string) {
    return withDb((db) =>
      db.team.findUnique({
        where: {
          organizationId_slug: { organizationId, slug },
        },
      })
    );
  },

  /**
   * Create a new team
   */
  create(organizationId: string, input: CreateTeamInput) {
    const slug = input.slug || generateSlug(input.name);
    return withDb((db) =>
      db.team.create({
        data: {
          organizationId,
          name: input.name,
          slug,
        },
      })
    );
  },

  /**
   * Create a team and add the creator as owner
   */
  createWithOwner(
    organizationId: string,
    ownerId: string,
    input: CreateTeamInput
  ) {
    const slug = input.slug || generateSlug(input.name);

    return withDb.tx(async (tx) => {
      const team = await tx.team.create({
        data: {
          organizationId,
          name: input.name,
          slug,
        },
      });

      await tx.teamMember.create({
        data: {
          teamId: team.id,
          userId: ownerId,
          role: "OWNER",
        },
      });

      return team;
    });
  },

  /**
   * Update a team
   */
  update(
    id: string,
    organizationId: string,
    input: Omit<UpdateTeamInput, "id">
  ) {
    return withDb((db) =>
      db.team.update({
        where: { id, organizationId },
        data: input,
      })
    );
  },

  /**
   * Delete a team
   */
  delete(id: string, organizationId: string) {
    // Delete team members first, then project associations, then the team
    return withDb.tx(async (tx) => {
      // TODO: Cascading deletion
      await tx.teamMember.deleteMany({ where: { teamId: id } });
      await tx.projectTeam.deleteMany({ where: { teamId: id } });
      return tx.team.delete({ where: { id, organizationId } });
    });
  },

  // ==================== Team Members ====================

  /**
   * Get all members of a team
   */
  getMembers(teamId: string) {
    return withDb((db) =>
      db.teamMember.findMany({
        where: { teamId },
        include: MEMBER_WITH_USER_INCLUDE,
        orderBy: { createdAt: "asc" },
      })
    );
  },

  /**
   * Get a specific team member
   */
  getMember(teamId: string, userId: string) {
    return withDb((db) =>
      db.teamMember.findUnique({
        where: {
          teamId_userId: { teamId, userId },
        },
        include: MEMBER_WITH_USER_INCLUDE,
      })
    );
  },

  /**
   * Add a member to a team
   */
  addMember(input: AddTeamMemberInput) {
    return withDb((db) =>
      db.teamMember.create({
        data: {
          teamId: input.teamId,
          userId: input.userId,
          role: input.role ?? "MEMBER",
        },
        include: MEMBER_WITH_USER_INCLUDE,
      })
    );
  },

  /**
   * Update a team member's role
   */
  updateMemberRole(input: UpdateTeamMemberInput) {
    return withDb((db) =>
      db.teamMember.update({
        where: {
          teamId_userId: { teamId: input.teamId, userId: input.userId },
        },
        data: { role: input.role },
        include: MEMBER_WITH_USER_INCLUDE,
      })
    );
  },

  /**
   * Remove a member from a team
   */
  removeMember(teamId: string, userId: string) {
    return withDb((db) =>
      db.teamMember.delete({
        where: {
          teamId_userId: { teamId, userId },
        },
      })
    );
  },

  /**
   * Check if a user is a member of a team
   */
  async isMember(teamId: string, userId: string): Promise<boolean> {
    const member = await withDb((db) =>
      db.teamMember.findUnique({
        where: {
          teamId_userId: { teamId, userId },
        },
      })
    );
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
    const member = await withDb((db) =>
      db.teamMember.findUnique({
        where: {
          teamId_userId: { teamId, userId },
        },
      })
    );

    if (!member) {
      return false;
    }

    const roleHierarchy: Record<TeamRole, number> = {
      OWNER: 3,
      ADMIN: 2,
      MEMBER: 1,
    };

    return (
      roleHierarchy[member.role as TeamRole] >= roleHierarchy[requiredRole]
    );
  },

  /**
   * Get all teams a user belongs to
   */
  findByUser(userId: string) {
    return withDb((db) =>
      db.teamMember.findMany({
        where: { userId },
        include: {
          team: {
            include: {
              _count: { select: { members: true, projects: true } },
            },
          },
        },
      })
    );
  },
};

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

/** Base type for team with counts (used by both findByOrganization and findById) */
type TeamWithCountsFromDb = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
  _count: { members: number; projects: number };
};
