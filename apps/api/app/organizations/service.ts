import type {
  CreateOrganizationInput,
  Organization,
  UpdateOrganizationInput,
} from "@repo/api/src/types/organization";
import { withDb } from "@repo/database";

/**
 * Organizations service - handles database operations for organization management
 */
export const organizationsService = {
  /**
   * Find an organization by ID
   */
  findById(id: string): Promise<Organization | null> {
    return withDb((db) =>
      db.organization.findUnique({
        where: { id },
      })
    ) as Promise<Organization | null>;
  },

  /**
   * Find an organization by Clerk ID
   */
  findByClerkId(clerkId: string): Promise<Organization | null> {
    return withDb((db) =>
      db.organization.findUnique({
        where: { clerkId },
      })
    ) as Promise<Organization | null>;
  },

  /**
   * Create a new organization
   */
  create(input: CreateOrganizationInput): Promise<Organization> {
    return withDb((db) =>
      db.organization.create({
        data: {
          clerkId: input.clerkId,
          name: input.name,
          slug: input.slug,
          anthropicApiKey: input.anthropicApiKey,
        },
      })
    ) as Promise<Organization>;
  },

  /**
   * Update an existing organization by ID
   */
  update(
    id: string,
    input: Omit<UpdateOrganizationInput, "id">
  ): Promise<Organization> {
    return withDb((db) =>
      db.organization.update({
        where: { id },
        data: input,
      })
    ) as Promise<Organization>;
  },

  /**
   * Update an existing organization by Clerk ID
   */
  updateByClerkId(
    clerkId: string,
    input: Omit<UpdateOrganizationInput, "id">
  ): Promise<Organization> {
    return withDb((db) =>
      db.organization.update({
        where: { clerkId },
        data: input,
      })
    ) as Promise<Organization>;
  },

  /**
   * Deactivate an organization (soft delete)
   */
  deactivate(id: string): Promise<Organization> {
    return withDb((db) =>
      db.organization.update({
        where: { id },
        data: { active: false },
      })
    ) as Promise<Organization>;
  },

  /**
   * Deactivate an organization by Clerk ID (soft delete)
   */
  deactivateByClerkId(clerkId: string): Promise<Organization> {
    return withDb((db) =>
      db.organization.update({
        where: { clerkId },
        data: { active: false },
      })
    ) as Promise<Organization>;
  },
};
