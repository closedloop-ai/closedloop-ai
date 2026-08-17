import type {
  CreateUserInput,
  UpdateUserInput,
  UpdateUserProfileFromClerkInput,
  User,
} from "@repo/api/src/types/user";
import { type Prisma, withDb } from "@repo/database";

/** A scalar column name on the `User` model (excludes every relation). */
type UserScalarColumn =
  (typeof Prisma.UserScalarFieldEnum)[keyof typeof Prisma.UserScalarFieldEnum];

/**
 * The exact column set the public `User` contract declares.
 *
 * Every read or write whose result is serialized to a client goes through this
 * select instead of returning the whole Prisma row. The `User` model carries six
 * columns that appear in neither the shared `User` type nor the public OpenAPI
 * `User` schema, and an unselected query handed all six — `claudeApiKeyEncrypted`
 * among them — to any read-scoped API key, for every user in the organization
 * (ISS-5195). The surface that owns that field narrows it deliberately: see
 * `apiKeyService.getUserKeyInfo`, which returns only `{isSet, lastFour, setAt}`.
 *
 * `satisfies Record<keyof User, true>` is deliberately NOT intersected with
 * `Prisma.UserSelect`. The intersection looks stricter and is in fact weaker:
 * TypeScript treats a key as known when it appears in ANY constituent, and
 * `Prisma.UserSelect` declares all 21 columns plus every relation, so
 * `claudeApiKeyEncrypted: true` would have compiled clean. Against the bare
 * `Record` the key set is closed to `keyof User`, so re-adding a withheld column
 * — or naming one that does not exist — is a compile error, and dropping a
 * contract field is one too. A NEW Prisma column cannot leak through here: it is
 * simply absent from this set, and `USER_COLUMNS_WITHHELD_FROM_CLIENTS` below is
 * what forces someone to classify it rather than let it drift in unnoticed.
 */
export const USER_CONTRACT_SELECT = {
  id: true,
  clerkId: true,
  organizationId: true,
  email: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  phoneNumber: true,
  role: true,
  linearId: true,
  slackId: true,
  githubUsername: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Record<keyof User, true>;

/**
 * `User` columns deliberately kept off the wire (ISS-5195).
 *
 * The Claude-key trio is credential material — ciphertext, its last four, and
 * when it was set — and the compute-preference trio is private per-user routing
 * state each of its owning surfaces already reads through its own narrow select
 * (`compute-preference/route.ts`, `compute-target-resolver.ts`). Together with
 * `USER_CONTRACT_SELECT` this partitions every scalar column on the model, which
 * is what lets the service test assert exhaustiveness against
 * `Prisma.UserScalarFieldEnum`: add a column to the schema and that test fails
 * until it is classified as exposed or withheld.
 *
 * Typed against the scalar-field enum rather than `keyof Prisma.UserSelect`,
 * which also admits every relation name — a withheld entry naming a relation
 * would compile while protecting nothing, and the partition claim above would
 * quietly stop being true.
 */
export const USER_COLUMNS_WITHHELD_FROM_CLIENTS = [
  "claudeApiKeyEncrypted",
  "claudeApiKeyLastFour",
  "claudeApiKeySetAt",
  "preferredComputeMode",
  "preferredComputeTargetId",
  "preferredHarness",
] as const satisfies readonly UserScalarColumn[];

/**
 * Users service - handles database operations for user management
 */
export const usersService = {
  /**
   * Find all users in an organization
   * @returns Only active users (filters out soft-deleted users)
   * @note Selects the public `User` contract columns only — this read is served
   *       to any API key holder via GET /users (ISS-5195).
   */
  findByOrganization(organizationId: string) {
    return withDb((db) =>
      db.user.findMany({
        where: {
          organizationId,
          active: true,
        },
        select: USER_CONTRACT_SELECT,
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
   * @note Selects the public `User` contract columns only — this read is served
   *       directly to clients by GET /me and GET /users/:id (ISS-5195). Callers
   *       that need a withheld column (the Claude-key or compute-preference
   *       trio) issue their own narrow select against `db.user`, as
   *       `api-key-service.ts` and `compute-target-resolver.ts` already do.
   */
  findById(id: string, organizationId: string) {
    return withDb((db) =>
      db.user.findUnique({
        where: { id, organizationId },
        select: USER_CONTRACT_SELECT,
      })
    );
  },

  /**
   * Find a user by Clerk ID and organization ID
   * @returns User regardless of active status (needed for authentication flows)
   * @note Does NOT filter by active status - returns both active and inactive users.
   *       This is intentional to support authentication and webhook processing.
   *       Used by withAuth() middleware to authenticate requests from deactivated users.
   * @note Selects the public `User` contract columns only. This row is what
   *       `findOrCreateUser` returns as its declared `User`, and it becomes
   *       `AuthContext.user` on every Clerk-session route — so without the
   *       select the type was a lie and the three auth paths produced
   *       structurally different `user` objects (ISS-5195).
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
        select: USER_CONTRACT_SELECT,
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
   * @note Selects the public `User` contract columns only — the other half of
   *       `findOrCreateUser`'s declared `User` return, alongside
   *       `findByClerkIdAndOrg` (ISS-5195).
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
        select: USER_CONTRACT_SELECT,
      })
    );
  },

  /**
   * Update an existing user by ID, scoped to their organization
   * @note `organizationId` is in the `where` clause, not merely checked by the
   *       caller. The route happens to pre-check via findById, but a service
   *       method must not depend on that: org scoping belongs in the query so a
   *       second caller cannot write across a tenant boundary by omitting it.
   * @note Selects the public `User` contract columns only — PUT /users/:id
   *       returns this row to the caller (ISS-5195).
   */
  update(
    id: string,
    organizationId: string,
    input: Omit<UpdateUserInput, "id">
  ) {
    return withDb((db) =>
      db.user.update({
        where: { id, organizationId },
        data: input,
        select: USER_CONTRACT_SELECT,
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
