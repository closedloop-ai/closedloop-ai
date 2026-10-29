import { Result, Status } from "@repo/api/src/types/result";
import type {
  AddTeamMemberInput,
  AddTeamRepositoryInput,
  CreateTeamInput,
  ProjectTeamOption,
  Team,
  TeamRepository,
  TeamWithCounts,
  UpdateTeamInput,
  UpdateTeamMemberInput,
  UpdateTeamRepositoryInput,
} from "@repo/api/src/types/teams";
import { TeamRole } from "@repo/api/src/types/teams";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import {
  basicUserSelect,
  getPrismaErrorCode,
  matchesPrismaP2002Target,
} from "@/lib/db-utils";

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
   * The org's teams reduced to what a caller needs to choose one. Deliberately
   * not `findByOrganization`: that carries a `_count` join this path never
   * reads, and its `Date` columns cannot be serialized into the `JsonObject`
   * that error `details` is typed as.
   */
  listTeamOptions(organizationId: string): Promise<ProjectTeamOption[]> {
    return withDb((db) =>
      db.team.findMany({
        where: { organizationId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
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
   * Prove a team id exists inside an organization, without hydrating it.
   *
   * `findById` above joins every member with its `User` plus two `_count`s; a
   * route gate that only null-checks the result must not pay for that graph
   * (`apps/api/AGENTS.md`, "Query Shape and Route Gates"). Callers that render
   * the team still use `findById`.
   */
  async existsInOrganization(
    id: string,
    organizationId: string
  ): Promise<boolean> {
    const team = await withDb((db) =>
      db.team.findFirst({
        where: { id, organizationId },
        select: { id: true },
      })
    );
    return team !== null;
  },

  /**
   * Create a team and add the creator as owner.
   *
   * `Status.Conflict` when the slug is already taken in this organization —
   * `slug` is caller-supplied, so `@@unique([organizationId, slug])` is
   * reachable from a plain request body. Only that constraint: the membership
   * insert below carries its own unique index, and
   * {@link isTeamSlugConflictError} keeps a violation of it out of the 409.
   */
  async createWithOwner(
    organizationId: string,
    ownerId: string,
    input: CreateTeamInput
  ): Promise<Result<Team, typeof Status.Conflict>> {
    const slug = input.slug || generateSlug(input.name);

    try {
      // The catch sits OUTSIDE withDb.tx so a failed write rolls the whole
      // transaction back before the error is translated.
      const team = await withDb.tx(async (tx) => {
        const created = await tx.team.create({
          data: {
            organizationId,
            name: input.name,
            slug,
          },
        });

        await tx.teamMember.create({
          data: {
            teamId: created.id,
            userId: ownerId,
            role: "OWNER",
          },
          select: { id: true },
        });

        return created;
      });
      return Result.ok(team);
    } catch (error) {
      if (isTeamSlugConflictError(error)) {
        return Result.err(Status.Conflict);
      }
      throw error;
    }
  },

  /**
   * Update a team.
   *
   * `Status.NotFound` when no row matches the id in this organization: Prisma
   * raises P2025 on a zero-row `update` rather than resolving null, so a
   * caller cannot detect the miss from the return value.
   * `Status.Conflict` when the new slug is already taken.
   */
  async update(
    id: string,
    organizationId: string,
    input: Omit<UpdateTeamInput, "id">
  ): Promise<Result<Team, typeof Status.NotFound | typeof Status.Conflict>> {
    try {
      const team = await withDb((db) =>
        db.team.update({
          where: { id, organizationId },
          data: input,
        })
      );
      return Result.ok(team);
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2025") {
        return Result.err(Status.NotFound);
      }
      if (isTeamSlugConflictError(error)) {
        return Result.err(Status.Conflict);
      }
      throw error;
    }
  },

  /**
   * Delete a team.
   *
   * `Status.NotFound` when no row matches the id in this organization.
   *
   * One org-scoped statement, and deliberately not a transaction. The members,
   * project links, and repositories the team owns are removed by the FK
   * cascades that already exist (`team_members`, `project_teams`, and
   * `team_repositories` are all `ON DELETE CASCADE`), which is what the
   * `TODO: Cascading deletion` this replaces was waiting for.
   *
   * Hand-deleting the associations first could not stay correct once a miss
   * became a returned `Result` instead of a throw: those `deleteMany` calls
   * were keyed on `teamId` alone, and `withDb.tx` JOINS an ambient transaction
   * rather than opening its own, so a caller already inside one would get
   * `Status.NotFound` back and then commit the unscoped deletes — wiping the
   * membership of another organization's team. Writing nothing before the
   * scoped statement removes the hazard instead of relying on a rollback that
   * only happens when this method owns the transaction.
   */
  async delete(
    id: string,
    organizationId: string
  ): Promise<Result<true, typeof Status.NotFound>> {
    try {
      await withDb((db) => db.team.delete({ where: { id, organizationId } }));
      return Result.ok(true);
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2025") {
        return Result.err(Status.NotFound);
      }
      throw error;
    }
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
        // Existence is the whole answer; no column of the row is read.
        select: { id: true },
      })
    );
    return member !== null;
  },

  /**
   * Check if a user has a specific role (or higher) in a team.
   * Role hierarchy: OWNER > ADMIN > MEMBER.
   *
   * `organizationId` is part of the query, not merely of the caller's context:
   * the membership row is reached through `team: { organizationId }` so the
   * answer is correct no matter what order a caller runs its checks in. Before
   * ISS-7533 this keyed on `teamId_userId` alone and was safe only because every
   * caller happened to be a same-org member.
   *
   * Takes one object rather than four positional arguments because `teamId`,
   * `organizationId` and `userId` are same-typed and a transposition would
   * typecheck under any positional order while authorizing against the wrong
   * tenant. Same shape as `authorizeTeamScopeRead` in `lib/team-scope-policy.ts`.
   */
  async hasRole(input: {
    teamId: string;
    organizationId: string;
    userId: string;
    requiredRole: TeamRole;
  }): Promise<boolean> {
    const member = await withDb((db) =>
      db.teamMember.findUnique({
        where: {
          teamId_userId: { teamId: input.teamId, userId: input.userId },
          team: { organizationId: input.organizationId },
        },
        select: { role: true },
      })
    );

    if (!member) {
      return false;
    }

    return ROLE_HIERARCHY[member.role] >= ROLE_HIERARCHY[input.requiredRole];
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

/** OWNER > ADMIN > MEMBER. Keyed on the `TeamRole` const, never bare strings. */
const ROLE_HIERARCHY: Record<TeamRole, number> = {
  [TeamRole.Owner]: 3,
  [TeamRole.Admin]: 2,
  [TeamRole.Member]: 1,
};

export const AddRepositoryError = {
  RepoNotAvailable: "REPO_NOT_AVAILABLE",
  AlreadyAdded: "ALREADY_ADDED",
} as const;
export type AddRepositoryError =
  (typeof AddRepositoryError)[keyof typeof AddRepositoryError];

/**
 * The 409 body both team-write routes return for
 * `@@unique([organizationId, slug])`. Shared so POST /teams and
 * PUT /teams/:teamId cannot drift apart.
 */
export const TEAM_SLUG_CONFLICT_MESSAGE =
  "A team with this slug already exists";

/**
 * The token both `meta.target` representations carry for
 * `@@unique([organizationId, slug])`. `slug` is not `@map`-ed, so the Prisma
 * field name and the Postgres column name are the same string, and it appears
 * in the constraint name (`teams_organization_id_slug_key`) either way.
 */
const TEAM_SLUG_CONFLICT_TARGET = "slug";
const TEAM_SLUG_CONFLICT_INDEX = "teams_organization_id_slug_key";

/**
 * True when `error` is the P2002 raised by `@@unique([organizationId, slug])`.
 *
 * The target is checked, not just the code: `createWithOwner` writes a
 * `TeamMember` in the same transaction and that table has its own
 * `@@unique([teamId, userId])`, so a bare `code === "P2002"` would report an
 * unrelated constraint violation to the caller as a slug conflict instead of
 * letting it surface as the unexpected fault it is. Both representations Prisma
 * adapters emit are accepted — the constraint-name string and the field/column
 * array (apps/api/AGENTS.md).
 */
function isTeamSlugConflictError(error: unknown): boolean {
  if (getPrismaErrorCode(error) !== "P2002") {
    return false;
  }

  // The string shape is an index NAME and is compared exactly: a substring test
  // for "slug" also matches `organizations_slug_key` and any future
  // `teams_*_slug_*` unique, which would silently become a 409. The array shape
  // is a column list and stays a membership test, because a bare column list
  // names no table and nothing more precise is available.
  return matchesPrismaP2002Target(error, (target) => {
    if (Array.isArray(target)) {
      return target.includes(TEAM_SLUG_CONFLICT_TARGET);
    }
    return target === TEAM_SLUG_CONFLICT_INDEX;
  });
}
