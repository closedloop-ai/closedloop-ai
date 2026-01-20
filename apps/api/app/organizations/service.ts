import type {
  CreateOrganizationInput,
  UpdateOrganizationInput,
} from "@repo/api/src/types/organization";
import { database } from "@repo/database";

/**
 * Organizations service - handles database operations for organization management
 */
export const organizationsService = {
  /**
   * Find an organization by ID
   */
  findById(id: string) {
    return database.organization.findUnique({
      where: { id },
    });
  },

  /**
   * Find an organization by Clerk ID
   */
  findByClerkId(clerkId: string) {
    return database.organization.findUnique({
      where: { clerkId },
    });
  },

  /**
   * Create a new organization
   */
  create(input: CreateOrganizationInput) {
    return database.organization.create({
      data: {
        clerkId: input.clerkId,
        name: input.name,
        slug: input.slug,
        anthropicApiKey: input.anthropicApiKey,
      },
    });
  },

  /**
   * Update an existing organization by ID
   */
  update(id: string, input: Omit<UpdateOrganizationInput, "id">) {
    return database.organization.update({
      where: { id },
      data: input,
    });
  },

  /**
   * Update an existing organization by Clerk ID
   */
  updateByClerkId(clerkId: string, input: Omit<UpdateOrganizationInput, "id">) {
    return database.organization.update({
      where: { clerkId },
      data: input,
    });
  },

  /**
   * Deactivate an organization (soft delete)
   */
  deactivate(id: string) {
    return database.organization.update({
      where: { id },
      data: { active: false },
    });
  },

  /**
   * Deactivate an organization by Clerk ID (soft delete)
   */
  deactivateByClerkId(clerkId: string) {
    return database.organization.update({
      where: { clerkId },
      data: { active: false },
    });
  },
};
