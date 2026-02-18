import type {
  CreateOrganizationInput,
  Organization,
  UpdateOrganizationInput,
} from "@repo/api/src/types/organization";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { clerkService } from "@/lib/auth/clerk-service";

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

  /**
   * Find an organization by Clerk ID, or create it by fetching details from Clerk.
   * Handles webhook ordering where a membership/user event arrives before the org creation event.
   *
   * When called from webhook handlers, pass the payload to avoid a Clerk API call.
   * The Clerk API is only used as a fallback when no payload is provided (e.g., from auth middleware).
   */
  async findOrCreateByClerkId(
    clerkOrgId: string,
    payload?: { name: string; slug: string | null }
  ): Promise<Organization> {
    const existing = await organizationsService.findByClerkId(clerkOrgId);

    if (existing) {
      return existing;
    }

    let name: string;
    let slug: string;

    if (payload) {
      log.info("Organization not found, creating from webhook payload", {
        clerkOrgId,
      });
      name = payload.name;
      slug = payload.slug ?? clerkOrgId;
    } else {
      log.info("Organization not found, fetching from Clerk", { clerkOrgId });
      const clerkOrg = await clerkService.getOrganization(clerkOrgId);
      name = clerkOrg.name;
      slug = clerkOrg.slug ?? clerkOrgId;
    }

    try {
      const organization = await organizationsService.create({
        clerkId: clerkOrgId,
        name,
        slug,
      });

      log.info("Created organization from Clerk", {
        organizationId: organization.id,
        clerkOrgId,
      });

      return organization;
    } catch (error) {
      // Handle race condition: concurrent requests may both attempt to create
      // the same org. If a unique constraint violation occurs (P2002), the org
      // was created by another request — just fetch it.
      if (
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "P2002"
      ) {
        const retried = await organizationsService.findByClerkId(clerkOrgId);
        if (retried) {
          return retried;
        }
      }
      throw error;
    }
  },
};
