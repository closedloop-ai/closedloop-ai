import type {
  CreateOrganizationInput,
  Organization,
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
  async findById(id: string): Promise<Organization | null> {
    return (await database.organization.findUnique({
      where: { id },
    })) as Organization | null;
  },

  /**
   * Find an organization by Clerk ID
   */
  async findByClerkId(clerkId: string): Promise<Organization | null> {
    return (await database.organization.findUnique({
      where: { clerkId },
    })) as Organization | null;
  },

  /**
   * Create a new organization
   */
  async create(input: CreateOrganizationInput): Promise<Organization> {
    return (await database.organization.create({
      data: {
        clerkId: input.clerkId,
        name: input.name,
        slug: input.slug,
        anthropicApiKey: input.anthropicApiKey,
      },
    })) as Organization;
  },

  /**
   * Update an existing organization by ID
   */
  async update(
    id: string,
    input: Omit<UpdateOrganizationInput, "id">
  ): Promise<Organization> {
    return (await database.organization.update({
      where: { id },
      data: input,
    })) as Organization;
  },

  /**
   * Update an existing organization by Clerk ID
   */
  async updateByClerkId(
    clerkId: string,
    input: Omit<UpdateOrganizationInput, "id">
  ): Promise<Organization> {
    return (await database.organization.update({
      where: { clerkId },
      data: input,
    })) as Organization;
  },

  /**
   * Deactivate an organization (soft delete)
   */
  async deactivate(id: string): Promise<Organization> {
    return (await database.organization.update({
      where: { id },
      data: { active: false },
    })) as Organization;
  },

  /**
   * Deactivate an organization by Clerk ID (soft delete)
   */
  async deactivateByClerkId(clerkId: string): Promise<Organization> {
    return (await database.organization.update({
      where: { clerkId },
      data: { active: false },
    })) as Organization;
  },
};
