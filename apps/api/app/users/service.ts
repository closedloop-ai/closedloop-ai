import type {
  CreateUserInput,
  UpdateUserInput,
  UpdateUserProfileFromClerkInput,
  User,
} from "@repo/api/src/types/user";
import { type Prisma, withDb } from "@repo/database";
import { refreshPeopleDisplayValuesForUser } from "@/app/custom-fields/people-display-refresh";

/** A scalar column name on the `User` model (excludes every relation). */
type UserScalarColumn =
  (typeof Prisma.UserScalarFieldEnum)[keyof typeof Prisma.UserScalarFieldEnum];

/**
 * The exact column set the public `User` contract declares.
 *
 * Every read or write whose result is serialized to a client goes through this
 * select instead of returning the whole Prisma row. The `User` model carries
 * columns that appear in neither the shared `User` type nor the public OpenAPI
 * `User` schema (`USER_COLUMNS_WITHHELD_FROM_CLIENTS` below), and an unselected
 * query handed them to any read-scoped API key, for every user in the
 * organization (ISS-5195).
 *
 * `satisfies Record<keyof User, true>` is deliberately NOT intersected with
 * `Prisma.UserSelect`. The intersection looks stricter and is in fact weaker:
 * TypeScript treats a key as known when it appears in ANY constituent, and
 * `Prisma.UserSelect` declares every column plus every relation, so
 * `clerkUpdatedAt: true` would have compiled clean. Against the bare
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
 * The onboarding dismissal is per-user UI state owned by
 * `app/onboarding/service.ts`. The Claude-key and compute-preference columns are
 * `@ignore`d in the schema since ISS-12435 removed Loops, so the client cannot
 * select them at all. Together with
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
  // ISS-5991. Per-user onboarding UI state, served as the derived
  // `checklistDismissed` boolean by GET /onboarding — the raw timestamp is not
  // part of the public `User` contract.
  "onboardingChecklistDismissedAt",
  // ISS-7132. Clerk's own `updated_at` from the last `user.*` payload mirrored
  // into this row — the replay/ordering guard's bookkeeping, not a user-facing
  // profile field. Serving it would also invite a client to read it as "when
  // this profile last changed", which it is not: it moves only when a Clerk
  // webhook writes, and `updatedAt` already answers that question.
  "clerkUpdatedAt",
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
   *       directly to clients by GET /me and GET /users/:id (ISS-5195).
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
   * @param clerkUpdatedAt ISS-7132: Clerk's stamp on the payload this profile
   *       came from, when the caller holds one. `user.created` does, so it is
   *       gated exactly as `updateByClerkId` is (review, whitlockk) — a replayed
   *       creation would otherwise revert what a newer `user.updated` already
   *       wrote. The other callers hold no user-level `updated_at` at all — a
   *       membership payload's `public_user_data`, a live Clerk read in
   *       `findOrCreateUser` — so their write cannot be ordered against the
   *       `user.*` stream and must not claim to be.
   *
   *       Absent a stamp the write CLEARS `clerkUpdatedAt`, and that is
   *       load-bearing: leaving a newer stamp in place while writing older
   *       columns would make the revert PERMANENT, because `updateByClerkId`
   *       would then reject the very redelivery that used to heal it. Nulling
   *       drops the ordering claim, so the next `user.updated` of any vintage
   *       is accepted, exactly as it was before the guard existed.
   */
  async upsertByClerkIdAndOrg(
    input: CreateUserInput,
    clerkUpdatedAt: Date | null = null
  ) {
    const profileFields = {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      avatarUrl: input.avatarUrl,
      phoneNumber: input.phoneNumber,
    };
    const where = {
      clerkId_organizationId: {
        clerkId: input.clerkId,
        organizationId: input.organizationId,
      },
    };
    const create = {
      clerkId: input.clerkId,
      organizationId: input.organizationId,
      ...profileFields,
      role: input.role ?? "ENGINEER",
      clerkUpdatedAt,
    };

    if (!clerkUpdatedAt) {
      const user = await withDb((db) =>
        db.user.upsert({
          where,
          create,
          update: {
            ...profileFields,
            active: true,
            clerkUpdatedAt: null,
          },
          select: USER_CONTRACT_SELECT,
        })
      );
      await refreshPeopleDisplayValuesForUser(user.id, input.organizationId);
      return user;
    }

    // Two statements because neither one alone can do this: `upsert` has no
    // conditional update arm, and `updateMany` cannot create the row.
    //
    // Ensure-then-guard, in that order, and `withDb` is not a transaction so
    // the order is what makes the pair safe. The upsert only creates a missing
    // row and reactivates an existing one — it never writes profile columns
    // over a row it did not create — so the guarded `updateMany` is always the
    // statement that decides the profile, and it decides it last. Guarding
    // first would lose the write outright when a concurrent membership delivery
    // creates the row in between: the `updateMany` would match nothing and the
    // upsert would then find a row it must not clobber.
    const user = await withDb(async (db) => {
      await db.user.upsert({
        where,
        create,
        update: { active: true },
        select: USER_CONTRACT_SELECT,
      });

      await db.user.updateMany({
        where: {
          clerkId: input.clerkId,
          organizationId: input.organizationId,
          OR: [
            { clerkUpdatedAt: null },
            { clerkUpdatedAt: { lt: clerkUpdatedAt } },
          ],
        },
        data: { ...profileFields, clerkUpdatedAt },
      });

      return db.user.findUniqueOrThrow({
        where,
        select: USER_CONTRACT_SELECT,
      });
    });
    // The profile write may have renamed this user; the cached PEOPLE sort
    // keys naming them are re-derived (ISS-8970). Unconditional and diffed on
    // purpose: a redelivery whose profile write the stamp guard refused still
    // repairs a column an earlier attempt failed to rewrite.
    await refreshPeopleDisplayValuesForUser(user.id, input.organizationId);
    return user;
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
  async update(
    id: string,
    organizationId: string,
    input: Omit<UpdateUserInput, "id">
  ) {
    const user = await withDb((db) =>
      db.user.update({
        where: { id, organizationId },
        data: input,
        select: USER_CONTRACT_SELECT,
      })
    );
    if (input.firstName !== undefined || input.lastName !== undefined) {
      await refreshPeopleDisplayValuesForUser(id, organizationId);
    }
    return user;
  },

  /**
   * Update an existing user by Clerk ID (used by webhooks), gated on the
   * payload's own timestamp.
   *
   * Uses updateMany to intentionally update ALL org records for this clerkId,
   * keeping profile data (name, avatar, email) consistent across organizations.
   * Each row is gated independently, so an org whose row a newer delivery
   * already advanced keeps that value while the rest still move forward.
   *
   * ISS-7132: `clerkUpdatedAt` is Clerk's stamp on the payload — see
   * `organizationsService.updateByClerkId` for why the comparison belongs in
   * the `where` clause and why it is `lt` rather than `lte`.
   *
   * @returns the number of rows written. 0 does NOT mean "rejected as stale"
   *          here: unlike the organization mirror there is no find-or-create
   *          ahead of this call, so it equally means the user has no mirrored
   *          row in any organization yet.
   */
  async updateByClerkId(
    clerkId: string,
    input: UpdateUserProfileFromClerkInput,
    clerkUpdatedAt: Date
  ): Promise<number> {
    const { count } = await withDb((db) =>
      db.user.updateMany({
        where: {
          clerkId,
          OR: [
            { clerkUpdatedAt: null },
            { clerkUpdatedAt: { lt: clerkUpdatedAt } },
          ],
        },
        data: { ...input, clerkUpdatedAt },
      })
    );
    // Every org row for this clerkId, not only the ones the guard advanced:
    // each org's cached PEOPLE sort keys are re-derived from that org's own
    // live row, and a redelivery after a failed refresh must still repair
    // them even though its updateMany now matches nothing (ISS-8970).
    const rows = await withDb((db) =>
      db.user.findMany({
        where: { clerkId },
        select: { id: true, organizationId: true },
      })
    );
    for (const row of rows) {
      await refreshPeopleDisplayValuesForUser(row.id, row.organizationId);
    }
    return count;
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
        select: { id: true },
      })
    );
  },

  /**
   * Deactivate all users across all organizations for a given Clerk ID (soft delete, global)
   * @returns The id of every row deactivated, one per organization; empty if no users found (does not throw)
   * @note Use for Clerk webhooks that affect all user records across orgs
   */
  deactivateAllByClerkId(clerkId: string): Promise<{ id: string }[]> {
    return withDb((db) =>
      db.user.updateManyAndReturn({
        where: { clerkId },
        data: { active: false },
        select: { id: true },
      })
    );
  },
};
