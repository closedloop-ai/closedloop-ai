import type { JsonObject } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  type CreateProjectInput,
  ProjectStatus,
  type ProjectWithDetails,
  type UpdateProjectInput,
} from "@repo/api/src/types/project";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { ArtifactType, Prisma, withDb } from "@repo/database";
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
          isTemplatesSentinel: false,
          ...(statusFilter ? { status: statusFilter } : {}),
        },
        include: PROJECT_DETAIL_INCLUDE,
        orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
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
          isTemplatesSentinel: false,
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

    return withDb.tx(async (tx) => {
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
        await tx.projectTeam.createMany({
          data: teamIds.map((teamId) => ({
            projectId: project.id,
            teamId,
          })),
        });
      }

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
    return withDb.tx(async (tx) => {
      const project = await tx.project.update({
        where: { id, organizationId },
        data: input,
      });

      // Update team associations if specified
      if (project && input.teamIds !== undefined) {
        await tx.projectTeam.deleteMany({ where: { projectId: id } });

        if (input.teamIds.length > 0) {
          await tx.projectTeam.createMany({
            data: input.teamIds.map((teamId) => ({
              projectId: id,
              teamId,
            })),
          });
        }
      }

      return project;
    });
  },

  /**
   * Delete a project
   */
  delete(id: string, organizationId: string) {
    return withDb.tx(async (tx) => {
      // Remove team associations first
      await tx.projectTeam.deleteMany({ where: { projectId: id } });
      return tx.project.delete({ where: { id, organizationId } });
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
   * Calculate project status based on artifact completion
   */
  calculateStatus(artifacts: Array<{ status: string }>): number {
    if (artifacts.length === 0) {
      return 0;
    }

    const completedCount = artifacts.filter(
      (a) =>
        a.status === DocumentStatus.Done || a.status === DocumentStatus.Obsolete
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
  artifacts: {
    where: { type: ArtifactType.DOCUMENT },
    select: { status: true },
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
    completionPercentage: projectsService.calculateStatus(project.artifacts),
    teams: project.teams.map((pt) => ({
      id: pt.team.id,
      name: pt.team.name,
    })),
    tags: mapTagRelations(project.tagProjects ?? []),
  };
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
