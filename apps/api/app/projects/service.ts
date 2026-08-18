import type { JsonObject } from "@repo/api/src/types/common";
import { isTerminalStatusForSubtype } from "@repo/api/src/types/document";
import {
  type CreateProjectInput,
  PROJECT_COMPLETION_ARTIFACT_TYPE,
  ProjectStatus,
  type ProjectWithDetails,
  type UpdateProjectInput,
} from "@repo/api/src/types/project";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { Prisma, type Project as PrismaProject, withDb } from "@repo/database";
import { waitUntil } from "@vercel/functions";
import {
  projectProjection,
  searchIndexService,
} from "@/app/search/search-index-service";
import { mapTagRelations, TAG_RELATION_INCLUDE } from "@/app/tags/service";
import { basicUserSelect } from "@/lib/db-utils";
import { generateSlug } from "@/lib/slug-generator";

/**
 * Projects service - handles database operations for project management
 */
export const projectsService = {
  /**
   * Find all projects for an organization
   */
  async findByOrganization(
    organizationId: string,
    options?: ProjectListOptions
  ): Promise<ProjectWithDetails[]> {
    const statusFilter = buildProjectStatusFilter(options);
    const projects = await withDb((db) =>
      db.project.findMany({
        where: {
          organizationId,
          ...(statusFilter ? { status: statusFilter } : {}),
        },
        include: PROJECT_DETAIL_INCLUDE,
        orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
        ...(options?.limit && { take: options.limit }),
      })
    );
    return projects.map((p) => toProjectWithDetails(p));
  },

  /**
   * Find projects by team ID
   */
  async findByTeam(
    teamId: string,
    organizationId: string,
    options?: ProjectListOptions
  ): Promise<ProjectWithDetails[]> {
    const statusFilter = buildProjectStatusFilter(options);
    const projects = await withDb((db) =>
      db.project.findMany({
        where: {
          organizationId,
          teams: {
            some: { teamId },
          },
          ...(statusFilter ? { status: statusFilter } : {}),
        },
        include: PROJECT_DETAIL_INCLUDE,
        orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
        ...(options?.limit && { take: options.limit }),
      })
    );
    return projects.map((p) => toProjectWithDetails(p));
  },

  /**
   * Find a project by ID with all details
   */
  async findById(
    id: string,
    organizationId: string
  ): Promise<ProjectWithDetails | null> {
    const project = await withDb((db) =>
      db.project.findUnique({
        where: { id, organizationId },
        include: PROJECT_DETAIL_INCLUDE,
      })
    );
    return project ? toProjectWithDetails(project) : null;
  },

  /**
   * Find a project by slug with all details
   */
  async findBySlug(
    slug: string,
    organizationId: string
  ): Promise<ProjectWithDetails | null> {
    const project = await withDb((db) =>
      db.project.findUnique({
        where: { organizationId_slug: { organizationId, slug } },
        include: PROJECT_DETAIL_INCLUDE,
      })
    );
    return project ? toProjectWithDetails(project) : null;
  },

  /**
   * Create a new project
   */
  async create(
    organizationId: string,
    userId: string,
    input: CreateProjectInput
  ) {
    const { teamIds, ...projectData } = input;
    const slug = await generateSlug(organizationId, SlugPrefix.Project);

    return withDb
      .tx(async (tx) => {
        const project = await tx.project.create({
          data: {
            ...projectData,
            organizationId,
            slug,
            createdById: userId,
          },
        });

        // Add project to teams if specified
        if (teamIds && teamIds.length > 0) {
          const resolvedTeamIds = await resolveOrgTeamIds(
            tx,
            teamIds,
            organizationId
          );

          await tx.projectTeam.createMany({
            data: resolvedTeamIds.map((teamId) => ({
              projectId: project.id,
              teamId,
            })),
            skipDuplicates: true,
          });
        }

        return project;
      })
      .then((project) => {
        // FEA-3863 / Phase-2: best-effort, post-commit, fail-open projection
        // upsert. The owning team (for the team-scoped project route) is the
        // first team the project was just added to, if any.
        indexProjectProjection(project, teamIds?.[0] ?? null);
        return project;
      });
  },

  /**
   * Update a project
   */
  update(
    id: string,
    organizationId: string,
    input: Omit<UpdateProjectInput, "id">
  ) {
    // `teamIds` is the ProjectTeam relation, not a Project column: leaving it
    // in `data` makes Prisma reject the whole update (ISS-6561).
    const { teamIds, ...projectData } = input;

    return withDb
      .tx(async (tx) => {
        const project = await tx.project.update({
          where: { id, organizationId },
          data: projectData,
        });

        // Update team associations if specified
        if (project && teamIds !== undefined) {
          const resolvedTeamIds = await resolveOrgTeamIds(
            tx,
            teamIds,
            organizationId
          );

          await tx.projectTeam.deleteMany({ where: { projectId: id } });

          if (resolvedTeamIds.length > 0) {
            await tx.projectTeam.createMany({
              data: resolvedTeamIds.map((teamId) => ({
                projectId: id,
                teamId,
              })),
              skipDuplicates: true,
            });
          }
        }

        return project;
      })
      .then((project) => {
        // FEA-3863 / Phase-2: best-effort, post-commit, fail-open projection
        // upsert. When this update set the teams, the owning team is the first
        // of them; otherwise it is left unresolved (undefined) so the indexer
        // reads the current owning team instead of clobbering it.
        const teamId = teamIds === undefined ? undefined : (teamIds[0] ?? null);
        indexProjectProjection(project, teamId);
        return project;
      });
  },

  /**
   * Delete a project
   */
  delete(id: string, organizationId: string) {
    return withDb
      .tx(async (tx) => {
        // Remove team associations first
        await tx.projectTeam.deleteMany({ where: { projectId: id } });
        return tx.project.delete({ where: { id, organizationId } });
      })
      .then((project) => {
        // FEA-3863: best-effort, post-commit, fail-open search projection removal.
        searchIndexService.removeAfterCommit({
          organizationId,
          entityType: SearchEntityType.Project,
          entityId: id,
        });
        return project;
      });
  },

  /**
   * Reorder projects by setting sortOrder values.
   * Accepts an array of project IDs in the desired order.
   */
  reorder(projectIds: string[], organizationId: string): Promise<string[]> {
    if (projectIds.length === 0) {
      return Promise.resolve([]);
    }

    const uniqueIds = [...new Set(projectIds)];

    return withDb.tx(async (tx) => {
      const projects = await tx.project.findMany({
        where: {
          id: { in: uniqueIds },
          organizationId,
        },
        select: { id: true },
      });

      if (projects.length !== uniqueIds.length) {
        const foundIds = new Set(projects.map((p) => p.id));
        const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
        throw new Error(
          `Invalid project IDs: ${missingIds.join(", ")} not found in organization`
        );
      }

      const valueRows = uniqueIds.map(
        (id, index) => Prisma.sql`(${id}::uuid, ${index}::int)`
      );
      await tx.$executeRaw(Prisma.sql`
        UPDATE "projects"
        SET "sort_order" = data.new_order
        FROM (VALUES ${Prisma.join(valueRows)}) AS data(id, new_order)
        WHERE "projects"."id" = data.id
          AND "projects"."organization_id" = ${organizationId}::uuid
      `);

      return uniqueIds;
    });
  },

  /**
   * Add a project to the user's favorites (idempotent).
   */
  addFavorite(projectId: string, userId: string, organizationId: string) {
    return withDb(async (db) => {
      // Verify project belongs to this org
      const project = await db.project.findUnique({
        where: { id: projectId, organizationId },
        select: { id: true },
      });
      if (!project) {
        return null;
      }
      await db.favoriteProject.upsert({
        where: { userId_projectId: { userId, projectId } },
        create: { userId, projectId },
        update: {},
        select: { id: true },
      });
      return { favorited: true };
    });
  },

  /**
   * Remove a project from the user's favorites.
   */
  removeFavorite(projectId: string, userId: string, organizationId: string) {
    return withDb(async (db) => {
      // Verify project belongs to this org
      const project = await db.project.findUnique({
        where: { id: projectId, organizationId },
        select: { id: true },
      });
      if (!project) {
        return null;
      }
      await db.favoriteProject.deleteMany({
        where: { userId, projectId },
      });
      return { favorited: false };
    });
  },

  /**
   * Find all favorite projects for a user within an organization.
   * Returns projects mapped to API format, ordered by when they were favorited.
   */
  async findFavoritesByUser(
    userId: string,
    organizationId: string
  ): Promise<ProjectWithDetails[]> {
    const favorites = await withDb((db) =>
      db.favoriteProject.findMany({
        where: {
          userId,
          project: {
            organizationId,
            status: { not: ProjectStatus.Archived },
          },
        },
        orderBy: { createdAt: "desc" },
        include: {
          project: {
            include: PROJECT_DETAIL_INCLUDE,
          },
        },
      })
    );
    return favorites.map((f) => toProjectWithDetails(f.project));
  },

  /**
   * Calculate project completion over the DOCUMENT artifacts the caller passes
   * in — the population defined by `PROJECT_COMPLETION_ARTIFACT_TYPE`, which is
   * what `PROJECT_DETAIL_INCLUDE` selects. Branch, session, and deployment
   * artifacts of the project are deliberately outside both the numerator and
   * the denominator (ISS-4636), so the UI copy names documents, not artifacts.
   */
  calculateStatus(
    artifacts: Array<{ status: string; subtype: string | null }>
  ): number | null {
    // An empty population has no percentage to report. `null` distinguishes
    // "there are no documents or issues to complete" from a real 0-of-N, which
    // the ring renders differently (a dashed empty-state track vs a solid 0%).
    if (artifacts.length === 0) {
      return null;
    }

    // Documents and Features have distinct terminal vocabularies (PRD-495);
    // an artifact counts as complete when it has reached a terminal status for
    // its own subtype.
    const completedCount = artifacts.filter((a) =>
      isTerminalStatusForSubtype(a.subtype, a.status)
    ).length;

    return Math.round((completedCount / artifacts.length) * 100);
  },

  /**
   * Strip the GitHub-installation-bound fields out of every project's
   * `settings` JSON for an organization. Used by the PLN-634
   * different-account reconnect cleanup: the prior installation's repo
   * UUIDs are no longer valid references, so the resolver would fall
   * through to "pick at job launch" regardless, but explicitly clearing
   * keeps the settings JSON honest and avoids stale fullNames after a
   * reset.
   *
   * Returns the number of projects whose settings were rewritten. Safe to
   * call from inside an outer `withDb.tx` — joins the active transaction
   * via AsyncLocalStorage.
   */
  clearRepositorySettingsForOrganization(
    organizationId: string
  ): Promise<number> {
    return withDb.tx(async (tx) => {
      const projects = await tx.project.findMany({
        where: { organizationId },
        select: { id: true, settings: true },
      });
      let cleared = 0;
      for (const project of projects) {
        const current = (project.settings ?? {}) as Record<string, unknown>;
        if (!("repositoryOverrides" in current)) {
          continue;
        }
        const { repositoryOverrides, ...rest } = current;
        await tx.project.update({
          where: { id: project.id },
          data: { settings: rest as Prisma.InputJsonValue },
          select: { id: true },
        });
        cleared++;
      }
      return cleared;
    });
  },
};

type ProjectListOptions = {
  limit?: number;
  status?: ProjectStatus[];
  excludeStatus?: ProjectStatus[];
};

/**
 * Standard include pattern for project queries with assignee, teams, and artifacts
 */
const PROJECT_DETAIL_INCLUDE = {
  assignee: basicUserSelect,
  teams: {
    include: {
      team: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  },
  // The completion population (ISS-4636): documents only. Widening this filter
  // also widens what `completionPercentage` means, so the shared constant — and
  // the noun the UI renders next to it — must move with it.
  artifacts: {
    where: { type: PROJECT_COMPLETION_ARTIFACT_TYPE },
    select: { status: true, subtype: true },
  },
  tagProjects: {
    include: TAG_RELATION_INCLUDE,
  },
} as const;

/** Type for project returned from database with includes */
type ProjectFromDb = Prisma.ProjectGetPayload<{
  include: typeof PROJECT_DETAIL_INCLUDE;
}>;

function toProjectWithDetails(project: ProjectFromDb): ProjectWithDetails {
  return {
    ...project,
    settings: project.settings as JsonObject,
    assignee: project.assignee
      ? {
          id: project.assignee.id,
          email: project.assignee.email,
          firstName: project.assignee.firstName,
          lastName: project.assignee.lastName,
          avatarUrl: project.assignee.avatarUrl,
        }
      : undefined,
    ...toCompletionFields(projectsService.calculateStatus(project.artifacts)),
    teams: project.teams.map((pt) => ({
      id: pt.team.id,
      name: pt.team.name,
    })),
    tags: mapTagRelations(project.tagProjects ?? []),
  };
}

/**
 * Map the internal completion signal (`calculateStatus`'s `number | null`, where
 * `null` = empty population) onto the version-skew-safe wire shape: a numeric
 * `completionPercentage` (0 for empty, so old clients keep a valid number) plus
 * the additive optional `completionPopulationEmpty` flag, which is *omitted*
 * (never serialized `false`/`null`) when the population is non-empty so absent
 * degrades to the legacy 0% behavior (ISS-4679, AGENTS.md cross-repo rule).
 */
function toCompletionFields(
  status: number | null
): Pick<
  ProjectWithDetails,
  "completionPercentage" | "completionPopulationEmpty"
> {
  if (status === null) {
    return { completionPercentage: 0, completionPopulationEmpty: true };
  }
  return { completionPercentage: status };
}

function buildProjectStatusFilter(
  options?: ProjectListOptions
): Prisma.EnumProjectStatusFilter | undefined {
  const hasStatus = (options?.status?.length ?? 0) > 0;
  const hasExcludeStatus = (options?.excludeStatus?.length ?? 0) > 0;
  if (!(hasStatus || hasExcludeStatus)) {
    return undefined;
  }

  return {
    ...(hasStatus
      ? {
          in: options?.status,
        }
      : {}),
    ...(hasExcludeStatus
      ? {
          notIn: options?.excludeStatus,
        }
      : {}),
  };
}

/**
 * FEA-3863 / Phase-2: index a project into the search projection with its
 * routing metadata. `teamId` is the owning team for the team-scoped project
 * route: the caller passes the just-set team (or `null` for none) when it knows
 * it, or `undefined` when a metadata-only update left the teams untouched — in
 * which case the current first team is read from the source of truth so a
 * non-team update does not clobber the projected team. Best-effort throughout:
 * the upsert already runs post-commit via `waitUntil` and swallows errors, and
 * the team read is scheduled the same way so a failed read never affects the
 * user's write.
 */
function indexProjectProjection(
  project: PrismaProject,
  teamId: string | null | undefined
): void {
  const index = (resolvedTeamId: string | null) =>
    searchIndexService.indexAfterCommit(
      projectProjection({
        id: project.id,
        organizationId: project.organizationId,
        name: project.name,
        slug: project.slug,
        teamId: resolvedTeamId,
        description: project.description,
        assigneeId: project.assigneeId,
        status: project.status,
        priority: project.priority,
        updatedAt: project.updatedAt,
      })
    );

  if (teamId !== undefined) {
    index(teamId);
    return;
  }

  waitUntil(
    firstProjectTeamId(project.id)
      .catch(() => null)
      .then((resolvedTeamId) => index(resolvedTeamId))
  );
}

/**
 * The id of the first team a project belongs to, or null when it has none.
 * Read only by the best-effort search indexer, so a null (no team) is a safe
 * fallback rather than an error.
 */
function firstProjectTeamId(projectId: string): Promise<string | null> {
  return withDb(async (db) => {
    const membership = await db.projectTeam.findFirst({
      where: { projectId },
      select: { teamId: true },
    });
    return membership?.teamId ?? null;
  });
}

/** Matches the `customFields` array cap in this surface's validators. */
export const MAX_PROJECT_TEAMS = 100;

export class InvalidProjectTeamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectTeamsError";
  }
}

/**
 * Resolve the requested team IDs against the caller's own organization, inside
 * the caller's transaction, so a project can only ever be linked to teams the
 * caller can already see.
 *
 * Rejecting the whole write — rather than dropping the teams that did not
 * resolve — is deliberate: a partial apply would return a project whose `teams`
 * silently disagree with what the caller asked for. The message deliberately
 * does not distinguish "no such team" from "team in another organization", so a
 * caller cannot probe for foreign team IDs.
 */
async function resolveOrgTeamIds(
  tx: Prisma.TransactionClient,
  teamIds: string[],
  organizationId: string
): Promise<string[]> {
  // Bound the caller's input before doing any work with it; the unique
  // (projectId, teamId) constraint makes duplicates a write error otherwise.
  if (teamIds.length > MAX_PROJECT_TEAMS) {
    throw new InvalidProjectTeamsError(
      `A project can be linked to at most ${MAX_PROJECT_TEAMS} teams.`
    );
  }

  const uniqueTeamIds = [...new Set(teamIds)];
  if (uniqueTeamIds.length === 0) {
    return uniqueTeamIds;
  }

  const teams = await tx.team.findMany({
    where: { id: { in: uniqueTeamIds }, organizationId },
    select: { id: true },
  });

  if (teams.length !== uniqueTeamIds.length) {
    throw new InvalidProjectTeamsError(
      "One or more teams were not found in this organization."
    );
  }

  return uniqueTeamIds;
}
