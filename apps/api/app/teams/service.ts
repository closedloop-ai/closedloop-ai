import { Result, Status } from "@repo/api/src/types/result";
import type {
  AddTeamMemberInput,
  AddTeamRepositoryInput,
  CreateTeamInput,
  TeamRepository,
  TeamRole,
  TeamWithCounts,
  UpdateTeamInput,
  UpdateTeamMemberInput,
  UpdateTeamRepositoryInput,
} from "@repo/api/src/types/teams";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";

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

  // ==================== Team Repositories ====================

  /**
   * Get all repositories configured for a team, with installation repo details.
   * Ordered with primary first, then default-selected, then by creation time.
   * Tombstoned installation repos (PLN-634) are filtered from the active pool.
   */
  getRepositories(teamId: string): Promise<TeamRepository[]> {
    return withDb((db) =>
      db.teamRepository.findMany({
        where: { teamId, repository: { removedAt: null } },
        include: TEAM_REPO_INCLUDE,
        orderBy: [
          { isPrimary: "desc" },
          { isDefaultSelected: "desc" },
          { createdAt: "asc" },
        ],
      })
    );
  },

  /**
   * Get the union of repositories curated by every team a project belongs to.
   * Org scoping flows through the project relation. Note that teams which
   * belong to the project but have curated zero repositories produce no rows
   * here — use `countTeamsForProject` when the resolver's `teamCount` is
   * needed. Tombstoned installation repos (PLN-634) are filtered from the
   * active pool.
   */
  getRepositoriesByProject(
    projectId: string,
    organizationId: string
  ): Promise<TeamRepository[]> {
    return withDb((db) =>
      db.teamRepository.findMany({
        where: {
          team: {
            organizationId,
            projects: { some: { projectId } },
          },
          repository: { removedAt: null },
        },
        include: TEAM_REPO_INCLUDE,
        orderBy: [
          { isPrimary: "desc" },
          { isDefaultSelected: "desc" },
          { createdAt: "asc" },
        ],
      })
    );
  },

  countTeamsForProject(
    projectId: string,
    organizationId: string
  ): Promise<number> {
    return withDb((db) =>
      db.projectTeam.count({
        where: {
          projectId,
          team: { organizationId },
        },
      })
    );
  },

  /**
   * Add a repository to a team's curated list.
   * Verifies the installation repo belongs to the team's organization.
   * Enforces exactly-one-primary: if isPrimary is requested, also forces isDefaultSelected
   * and clears the previous primary in the same transaction.
   */
  addRepository(
    teamId: string,
    organizationId: string,
    input: AddTeamRepositoryInput
  ): Promise<Result<TeamRepository, AddRepositoryError>> {
    return withDb.tx(async (tx) => {
      const installationRepo = await tx.gitHubInstallationRepository.findFirst({
        where: {
          id: input.installationRepositoryId,
          removedAt: null,
          installation: {
            organizationId,
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
        select: { id: true },
      });
      if (!installationRepo) {
        return Result.err(AddRepositoryError.RepoNotAvailable);
      }

      const existing = await tx.teamRepository.findUnique({
        where: {
          teamId_installationRepositoryId: {
            teamId,
            installationRepositoryId: input.installationRepositoryId,
          },
        },
        select: { id: true },
      });
      if (existing) {
        return Result.err(AddRepositoryError.AlreadyAdded);
      }

      const wantsPrimary = input.isPrimary === true;
      const wantsDefault = wantsPrimary || input.isDefaultSelected === true;

      if (wantsPrimary) {
        await tx.teamRepository.updateMany({
          where: { teamId, isPrimary: true },
          data: { isPrimary: false },
        });
      }

      const created = await tx.teamRepository.create({
        data: {
          teamId,
          installationRepositoryId: input.installationRepositoryId,
          isDefaultSelected: wantsDefault,
          isPrimary: wantsPrimary,
        },
        include: TEAM_REPO_INCLUDE,
      });

      return Result.ok(created);
    });
  },

  /**
   * Update a team repository's flags.
   * Enforces invariants atomically:
   * - When the caller requests isPrimary=true, isDefaultSelected is auto-promoted to true
   *   (symmetric with addRepository). An explicit isDefaultSelected=false combined with
   *   isPrimary=true is a contradiction — the request to make this repo primary wins.
   * - When the caller un-defaults a repo that was primary, primary cascades off.
   * - Setting a new primary clears any other primary in the same team.
   */
  updateRepository(
    teamId: string,
    teamRepositoryId: string,
    input: UpdateTeamRepositoryInput
  ): Promise<Result<TeamRepository>> {
    return withDb.tx(async (tx) => {
      const existing = await tx.teamRepository.findFirst({
        where: { id: teamRepositoryId, teamId },
        select: { id: true, isDefaultSelected: true, isPrimary: true },
      });
      if (!existing) {
        return Result.err(Status.NotFound);
      }

      const requestedPrimary = input.isPrimary === true;
      const requestedNotPrimary = input.isPrimary === false;

      let nextDefault: boolean;
      let nextPrimary: boolean;

      if (requestedPrimary) {
        nextDefault = true;
        nextPrimary = true;
      } else {
        nextDefault = input.isDefaultSelected ?? existing.isDefaultSelected;
        const carriedPrimary = requestedNotPrimary ? false : existing.isPrimary;
        nextPrimary = nextDefault ? carriedPrimary : false;
      }

      if (nextPrimary && !existing.isPrimary) {
        await tx.teamRepository.updateMany({
          where: { teamId, isPrimary: true, NOT: { id: teamRepositoryId } },
          data: { isPrimary: false },
        });
      }

      const updated = await tx.teamRepository.update({
        where: { id: teamRepositoryId },
        data: { isDefaultSelected: nextDefault, isPrimary: nextPrimary },
        include: TEAM_REPO_INCLUDE,
      });

      return Result.ok(updated);
    });
  },

  /**
   * Remove a repository from a team's list. No automatic re-designation of primary —
   * if the removed repo was primary, the team is left with no primary until an admin
   * picks a new one.
   */
  async removeRepository(
    teamId: string,
    teamRepositoryId: string
  ): Promise<Result<true>> {
    const result = await withDb((db) =>
      db.teamRepository.deleteMany({
        where: { id: teamRepositoryId, teamId },
      })
    );
    return result.count > 0 ? Result.ok(true) : Result.err(Status.NotFound);
  },
};

/**
 * Standard select pattern for user fields in team member queries
 */
const USER_SELECT = {
  ...basicUserSelect.select,
  email: true,
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

/**
 * Standard include pattern for team repository queries with installation repo summary.
 * The selected fields match the TeamRepository.repository API type so the row can be
 * returned directly without conversion.
 */
const TEAM_REPO_INCLUDE = {
  repository: {
    select: {
      id: true,
      installationId: true,
      githubRepoId: true,
      fullName: true,
      name: true,
      owner: true,
      private: true,
    },
  },
} as const;

export const AddRepositoryError = {
  RepoNotAvailable: "REPO_NOT_AVAILABLE",
  AlreadyAdded: "ALREADY_ADDED",
} as const;
export type AddRepositoryError =
  (typeof AddRepositoryError)[keyof typeof AddRepositoryError];
