import type {
  CreateUserInput,
  UpdateUserInput,
  UpdateUserProfileFromClerkInput,
} from "@repo/api/src/types/organization";
import { withDb } from "@repo/database";

/**
 * Users service - handles database operations for user management
 */
export const usersService = {
  /**
   * Find all users in an organization
   * @returns Only active users (filters out soft-deleted users)
   */
  findByOrganization(organizationId: string) {
    return withDb((db) =>
      db.user.findMany({
        where: {
          organizationId,
          active: true,
        },
        orderBy: { createdAt: "desc" },
      })
    );
  },

  /**
   * Find a user by ID
   * @returns User regardless of active status (needed for authentication and admin operations)
   * @note Does NOT filter by active status - returns both active and inactive users.
   *       This is intentional to support:
   *       - Current user lookups (/api/me) for logged-in but deactivated users
   *       - Webhook processing that needs to update deactivated users
   *       - Admin operations that need to view/manage inactive users
   *       For user lists visible to end users, use findByOrganization() instead.
   */
  findById(id: string, organizationId: string) {
    return withDb((db) =>
      db.user.findUnique({
        where: { id, organizationId },
      })
    );
  },

  /**
   * Find a user by Clerk ID and organization ID
   * @returns User regardless of active status (needed for authentication flows)
   * @note Does NOT filter by active status - returns both active and inactive users.
   *       This is intentional to support authentication and webhook processing.
   *       Used by withAuth() middleware to authenticate requests from deactivated users.
   */
  findByClerkIdAndOrg(clerkId: string, organizationId: string) {
    return withDb((db) =>
      db.user.findUnique({
        where: {
          clerkId_organizationId: {
            clerkId,
            organizationId,
          },
        },
      })
    );
  },

  /**
   * Create a new user
   */
  create(input: CreateUserInput) {
    return withDb((db) =>
      db.user.create({
        data: {
          clerkId: input.clerkId,
          organizationId: input.organizationId,
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          avatarUrl: input.avatarUrl,
          phoneNumber: input.phoneNumber,
          role: input.role ?? "ENGINEER",
        },
      })
    );
  },

  /**
   * Create or update a user by Clerk ID and organization (used by webhooks and auth)
   * @note Uses composite unique constraint (clerkId, organizationId) for idempotency
   * @note Reactivates previously deactivated users by setting active: true
   * @note Does NOT update organizationId on existing records (composite key is immutable)
   */
  upsertByClerkIdAndOrg(input: CreateUserInput) {
    const profileFields = {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      avatarUrl: input.avatarUrl,
      phoneNumber: input.phoneNumber,
    };

    return withDb((db) =>
      db.user.upsert({
        where: {
          clerkId_organizationId: {
            clerkId: input.clerkId,
            organizationId: input.organizationId,
          },
        },
        create: {
          clerkId: input.clerkId,
          organizationId: input.organizationId,
          ...profileFields,
          role: input.role ?? "ENGINEER",
        },
        update: {
          ...profileFields,
          active: true,
        },
      })
    );
  },

  /**
   * Update an existing user by ID
   */
  update(id: string, input: Omit<UpdateUserInput, "id">) {
    return withDb((db) =>
      db.user.update({
        where: { id },
        data: input,
      })
    );
  },

  /**
   * Update an existing user by Clerk ID (used by webhooks).
   * Uses updateMany to intentionally update ALL org records for this clerkId,
   * keeping profile data (name, avatar, email) consistent across organizations.
   */
  updateByClerkId(clerkId: string, input: UpdateUserProfileFromClerkInput) {
    return withDb((db) =>
      db.user.updateMany({
        where: { clerkId },
        data: input,
      })
    );
  },

  /**
   * Deactivate a user (soft delete)
   */
  deactivate(id: string) {
    return withDb((db) =>
      db.user.update({
        where: { id },
        data: { active: false },
      })
    );
  },

  /**
   * Deactivate a user by Clerk ID and organization (soft delete, org-scoped)
   * @throws Prisma P2025 error if user not found in organization
   * @note Uses composite unique constraint for precise targeting
   * @note Throws if user doesn't exist - caller must handle this case
   */
  deactivateByClerkIdAndOrg(clerkId: string, organizationId: string) {
    return withDb((db) =>
      db.user.update({
        where: {
          clerkId_organizationId: {
            clerkId,
            organizationId,
          },
        },
        data: { active: false },
      })
    );
  },

  /**
   * Deactivate all users across all organizations for a given Clerk ID (soft delete, global)
   * @returns Prisma BatchPayload with count of affected records
   * @note Returns count: 0 if no users found (does not throw)
   * @note Use for Clerk webhooks that affect all user records across orgs
   */
  deactivateAllByClerkId(clerkId: string) {
    return withDb((db) =>
      db.user.updateMany({
        where: { clerkId },
        data: { active: false },
      })
    );
  },
};
