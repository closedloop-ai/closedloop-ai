import type { JsonObject } from "@repo/api/src/types/common";
import type {
  CreateProjectInput,
  ProjectWithDetails,
  UpdateProjectInput,
} from "@repo/api/src/types/project";
import type { Prisma } from "@repo/database";
import { withDb } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";
import { generateSlug, SlugPrefix } from "@/lib/slug-generator";

/**
 * Projects service - handles database operations for project management
 */
export const projectsService = {
  /**
   * Find all projects for an organization
   */
  async findByOrganization(
    organizationId: string
  ): Promise<ProjectWithDetails[]> {
    const projects = await withDb((db) =>
      db.project.findMany({
        where: { organizationId },
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
    options?: { limit?: number }
  ): Promise<ProjectWithDetails[]> {
    const projects = await withDb((db) =>
      db.project.findMany({
        where: {
          teams: {
            some: { teamId },
          },
          organizationId,
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
      db.project.findFirst({
        where: { organizationId, slug },
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

      await Promise.all(
        uniqueIds.map((id, index) =>
          tx.project.update({
            where: { id, organizationId },
            data: { sortOrder: index },
          })
        )
      );

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
          project: { organizationId },
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
      (a) => a.status === "APPROVED"
    ).length;

    return Math.round((completedCount / artifacts.length) * 100);
  },
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
    select: { status: true },
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
  };
}
