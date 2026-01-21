import type { JsonObject } from "@repo/api/src/types/common";
import type {
  CreateProjectInput,
  ProjectPriority,
  ProjectWithDetails,
  UpdateProjectInput,
} from "@repo/api/src/types/organization";
import { database, type Prisma } from "@repo/database";

/**
 * Standard include pattern for project queries with owner, teams, and artifacts
 */
const PROJECT_DETAIL_INCLUDE = {
  owner: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
    },
  },
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
    where: { isLatest: true },
    select: { status: true },
  },
} as const;

/** Type for project returned from database with includes */
type ProjectFromDb = Prisma.ProjectGetPayload<{
  include: typeof PROJECT_DETAIL_INCLUDE;
}>;

/**
 * Projects service - handles database operations for project management
 */
export const projectsService = {
  /**
   * Transform a database project to API ProjectWithDetails format
   */
  toProjectWithDetails(project: ProjectFromDb): ProjectWithDetails {
    return {
      id: project.id,
      organizationId: project.organizationId,
      name: project.name,
      description: project.description,
      priority: project.priority as ProjectPriority,
      ownerId: project.ownerId,
      targetDate: project.targetDate,
      codebaseSummary: project.codebaseSummary as JsonObject | null,
      lastIndexedAt: project.lastIndexedAt,
      settings: project.settings as JsonObject,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      owner: project.owner
        ? {
            id: project.owner.id,
            firstName: project.owner.firstName,
            lastName: project.owner.lastName,
            avatarUrl: project.owner.avatarUrl,
          }
        : undefined,
      status: this.calculateStatus(project.artifacts),
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
    return database.project.findMany({
      where: { organizationId },
      include: PROJECT_DETAIL_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
  },

  /**
   * Find projects by team ID
   */
  findByTeam(teamId: string) {
    return database.project.findMany({
      where: {
        teams: {
          some: { teamId },
        },
      },
      include: PROJECT_DETAIL_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
  },

  /**
   * Find a project by ID with all details
   */
  findById(id: string) {
    return database.project.findUnique({
      where: { id },
      include: PROJECT_DETAIL_INCLUDE,
    });
  },

  /**
   * Find a project by ID with organization access check
   */
  findByIdWithAccess(id: string, organizationId: string) {
    return database.project.findFirst({
      where: { id, organizationId },
      include: PROJECT_DETAIL_INCLUDE,
    });
  },

  /**
   * Create a new project
   */
  create(input: CreateProjectInput) {
    return database.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          organizationId: input.organizationId,
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
  update(id: string, input: Omit<UpdateProjectInput, "id">) {
    return database.$transaction(async (tx) => {
      const data: Prisma.ProjectUpdateInput = {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.priority !== undefined && { priority: input.priority }),
        ...(input.ownerId !== undefined && {
          owner: input.ownerId
            ? { connect: { id: input.ownerId } }
            : { disconnect: true },
        }),
        ...(input.targetDate !== undefined && { targetDate: input.targetDate }),
        ...(input.settings !== undefined && {
          settings: input.settings as Prisma.InputJsonValue,
        }),
      };

      const project = await tx.project.update({
        where: { id },
        data,
      });

      // Update team associations if specified
      if (input.teamIds !== undefined) {
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
  delete(id: string) {
    return database.$transaction(async (tx) => {
      // Remove team associations first
      await tx.projectTeam.deleteMany({ where: { projectId: id } });
      return tx.project.delete({ where: { id } });
    });
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
