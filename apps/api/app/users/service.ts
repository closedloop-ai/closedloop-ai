import type {
  CreateUserInput,
  UpdateUserInput,
} from "@repo/api/src/types/organization";
import { withDb } from "@repo/database";

/**
 * Users service - handles database operations for user management
 */
export const usersService = {
  /**
   * Find all users in an organization
   */
  findByOrganization(organizationId: string) {
    return withDb((db) =>
      db.user.findMany({
        where: { organizationId },
        orderBy: { createdAt: "desc" },
      })
    );
  },

  /**
   * Find a user by ID
   */
  findById(id: string, organizationId: string) {
    return withDb((db) =>
      db.user.findUnique({
        where: { id, organizationId },
      })
    );
  },

  /**
   * Find a user by Clerk ID
   */
  findByClerkId(clerkId: string) {
    return withDb((db) =>
      db.user.findUnique({
        where: { clerkId },
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
   * Create or update a user by Clerk ID (used by webhooks)
   */
  upsertByClerkId(input: CreateUserInput) {
    return withDb((db) =>
      db.user.upsert({
        where: { clerkId: input.clerkId },
        create: {
          clerkId: input.clerkId,
          organizationId: input.organizationId,
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          avatarUrl: input.avatarUrl,
          phoneNumber: input.phoneNumber,
          role: input.role ?? "ENGINEER",
        },
        update: {
          organizationId: input.organizationId,
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          avatarUrl: input.avatarUrl,
          phoneNumber: input.phoneNumber,
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
   * Update an existing user by Clerk ID (used by webhooks)
   */
  updateByClerkId(clerkId: string, input: Omit<UpdateUserInput, "id">) {
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
   * Deactivate a user by Clerk ID (soft delete, used by webhooks)
   */
  deactivateByClerkId(clerkId: string) {
    return withDb((db) =>
      db.user.updateMany({
        where: { clerkId },
        data: { active: false },
      })
    );
  },
};
