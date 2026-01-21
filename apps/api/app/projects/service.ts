import type {
  CreateProjectInput,
  Project,
  UpdateProjectInput,
} from "@repo/api/src/types/organization";
import { database } from "@repo/database";

/**
 * Projects service - handles database operations for project management
 */
export const projectsService = {
  /**
   * Find all projects in an organization
   */
  async findByOrganization(organizationId: string): Promise<Project[]> {
    return (await database.project.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    })) as Project[];
  },

  /**
   * Find a project by ID
   */
  async findById(id: string, organizationId: string): Promise<Project | null> {
    return (await database.project.findUnique({
      where: { id, organizationId },
    })) as Project | null;
  },

  /**
   * Create a new project
   */
  async create(
    organizationId: string,
    input: CreateProjectInput
  ): Promise<Project> {
    return (await database.project.create({
      data: {
        organizationId,
        name: input.name,
        description: input.description,
      },
    })) as Project;
  },

  /**
   * Update an existing project
   */
  async update(
    id: string,
    input: Omit<UpdateProjectInput, "id">
  ): Promise<Project> {
    return (await database.project.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        settings: input.settings,
      },
    })) as Project;
  },

  /**
   * Delete a project
   */
  async delete(id: string): Promise<void> {
    await database.project.delete({
      where: { id },
    });
  },
};
