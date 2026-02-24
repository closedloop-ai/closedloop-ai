import type { JsonObject } from "@repo/api/src/types/common";
import type {
  CreateProjectInput,
  ProjectWithDetails,
  UpdateProjectInput,
} from "@repo/api/src/types/organization";
import type { Prisma } from "@repo/database";
import { withDb } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";

/**
 * Projects service - handles database operations for project management
 */
export const projectsService = {
  /**
   * Transform a database project to API ProjectWithDetails format
   */
  toProjectWithDetails(project: ProjectFromDb): ProjectWithDetails {
    return {
      ...project,
      settings: project.settings as JsonObject,
      owner: project.owner
        ? {
            id: project.owner.id,
            firstName: project.owner.firstName,
            lastName: project.owner.lastName,
            avatarUrl: project.owner.avatarUrl,
          }
        : undefined,
      status: projectsService.calculateStatus(project.artifacts),
      teams: project.teams.map((pt) => ({
        id: pt.team.id,
        name: pt.team.name,
      })),
    };
  },

  /**
   * Find all projects for an organization
   */
  findByOrganization(organizationId: string) {
    return withDb((db) =>
      db.project.findMany({
        where: { organizationId },
        include: PROJECT_DETAIL_INCLUDE,
        orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      })
    );
  },

  /**
   * Find projects by team ID
   */
  findByTeam(
    teamId: string,
    organizationId: string,
    options?: { limit?: number }
  ) {
    return withDb((db) =>
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
  },

  /**
   * Find a project by ID with all details
   */
  findById(id: string, organizationId: string) {
    return withDb((db) =>
      db.project.findUnique({
        where: { id, organizationId },
        include: PROJECT_DETAIL_INCLUDE,
      })
    );
  },

  /**
   * Create a new project
   */
  create(organizationId: string, input: CreateProjectInput) {
    return withDb.tx(async (tx) => {
      const project = await tx.project.create({
        data: {
          organizationId,
          name: input.name,
          description: input.description,
          priority: input.priority ?? "NOT_SET",
          ownerId: input.ownerId,
          targetDate: input.targetDate,
        },
      });

      // Add project to teams if specified
      if (input.teamIds && input.teamIds.length > 0) {
        await tx.projectTeam.createMany({
          data: input.teamIds.map((teamId) => ({
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
   */
  findFavoritesByUser(userId: string, organizationId: string) {
    return withDb((db) =>
      db.project.findMany({
        where: {
          organizationId,
          favoritedBy: { some: { userId } },
        },
        include: PROJECT_DETAIL_INCLUDE,
        orderBy: { updatedAt: "desc" },
      })
    );
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
 * Standard include pattern for project queries with owner, teams, and artifacts
 */
const PROJECT_DETAIL_INCLUDE = {
  owner: basicUserSelect,
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
