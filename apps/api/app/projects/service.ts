import type {
  CreateProjectInput,
  Project,
  UpdateProjectInput,
} from "@repo/api/src/types/organization";
import { withDb } from "@repo/database";

/**
 * Projects service - handles database operations for project management
 */
export const projectsService = {
  /**
   * Find all projects in an organization
   */
  findByOrganization(organizationId: string): Promise<Project[]> {
    return withDb((db) =>
      db.project.findMany({
        where: { organizationId },
        orderBy: { createdAt: "desc" },
      })
    ) as Promise<Project[]>;
  },

  /**
   * Find a project by ID
   */
  findById(id: string, organizationId: string): Promise<Project | null> {
    return withDb((db) =>
      db.project.findUnique({
        where: { id, organizationId },
      })
    ) as Promise<Project | null>;
  },

  /**
   * Create a new project
   */
  create(organizationId: string, input: CreateProjectInput): Promise<Project> {
    return withDb((db) =>
      db.project.create({
        data: {
          organizationId,
          name: input.name,
          description: input.description,
        },
      })
    ) as Promise<Project>;
  },

  /**
   * Update an existing project
   */
  update(id: string, input: Omit<UpdateProjectInput, "id">): Promise<Project> {
    return withDb((db) =>
      db.project.update({
        where: { id },
        data: {
          name: input.name,
          description: input.description,
          settings: input.settings,
        },
      })
    ) as Promise<Project>;
  },

  /**
   * Delete a project
   */
  delete(id: string): Promise<void> {
    return withDb(async (db) => {
      await db.project.delete({
        where: { id },
      });
    });
  },
};
