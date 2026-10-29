import type { JsonObject } from "@repo/api/src/types/common";
import type {
  CreateOrganizationInput,
  Organization,
  UpdateOrganizationInput,
} from "@repo/api/src/types/organization";
import { type Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { clerkService } from "@/lib/auth/clerk-service";
import { getPrismaErrorCode } from "@/lib/db-utils";

/**
 * Organizations service - handles database operations for organization management
 */
export const organizationsService = {
  toOrganization(
    organization: OrganizationPayloadRow | null
  ): Organization | null {
    return organization
      ? {
          ...organization,
          settings: organization.settings as JsonObject,
        }
      : null;
  },
  /**
   * Resolve an organization's identity by ID.
   *
   * Identity, not the row: this is the lookup every authenticated request makes
   * to turn a credential into an org, so it reads the two columns those callers
   * consume and leaves the credential columns and the settings blob in Postgres.
   * A caller that renders the organization wants `findDetailById`.
   */
  findById(id: string): Promise<OrganizationIdentity | null> {
    return withDb((db) =>
      db.organization.findUnique({
        where: { id },
        select: ORGANIZATION_IDENTITY_SELECT,
      })
    );
  },

  /**
   * Resolve an organization's identity by Clerk ID. Same narrowing, and the
   * same reason, as `findById`.
   */
  findByClerkId(clerkId: string): Promise<OrganizationIdentity | null> {
    return withDb((db) =>
      db.organization.findUnique({
        where: { clerkId },
        select: ORGANIZATION_IDENTITY_SELECT,
      })
    );
  },

  /**
   * Resolve an organization's identity by slug. Its one caller is the slug
   * uniqueness check, which compares ids.
   */
  findBySlug(slug: string): Promise<OrganizationIdentity | null> {
    return withDb((db) =>
      db.organization.findUnique({
        where: { slug },
        select: ORGANIZATION_IDENTITY_SELECT,
      })
    );
  },

  /**
   * Read the full organization payload by ID, for the routes that serialize an
   * organization to the caller rather than just resolving one.
   */
  findDetailById(id: string): Promise<Organization | null> {
    return withDb((db) =>
      db.organization.findUnique({
        where: { id },
        select: ORGANIZATION_PAYLOAD_SELECT,
      })
    ).then(this.toOrganization);
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
        select: ORGANIZATION_PAYLOAD_SELECT,
      })
    ).then((organization) => this.toOrganization(organization)!);
  },

  /**
   * Update an existing organization by ID
   */
  update(
    id: string,
    input: Omit<UpdateOrganizationInput, "id">
  ): Promise<Organization | null> {
    return withDb((db) =>
      db.organization.update({
        where: { id },
        data: input,
        select: ORGANIZATION_PAYLOAD_SELECT,
      })
    ).then(this.toOrganization);
  },

  /**
   * Apply a Clerk-sourced mirror write, gated on the payload's own timestamp.
   *
   * ISS-7132: Svix delivers at-least-once and unordered, so a webhook handler
   * cannot assume the payload it holds is the newest state Clerk produced. An
   * unconditional write therefore lets a retry — or a delivery that overtook a
   * newer one — revert `name`/`slug` to an older value, and `slug` is the
   * `[orgSlug]` routing key, so that changes every URL the org's users hold.
   * `clerkUpdatedAt` is Clerk's own stamp on the last payload written here, so
   * it is the only value that orders two deliveries against each other; ours
   * (`updatedAt`) records when we wrote, on a different clock.
   *
   * The comparison lives in the `where` clause rather than in a read-then-write
   * so one statement decides it: two deliveries racing cannot both read the
   * stale value and then both write. `lt`, not `lte`, so an exact replay of an
   * already-applied delivery is a no-op — that is the dedup half of the guard.
   *
   * `clerkUpdatedAt: null` means the row has never been stamped from a Clerk
   * payload — it predates this column, or `findOrCreateByClerkId` created it
   * from a membership payload that carries no organization timestamp — so the
   * first Clerk write is accepted and stamps it.
   *
   * @returns the number of rows written: 0 when the payload was a replay or
   *          arrived out of order, and equally when no row matches `clerkId`.
   *          Callers that ran `findOrCreateByClerkId` first know the row exists
   *          and can read 0 as "rejected by the guard".
   */
  updateByClerkId(
    clerkId: string,
    input: Omit<UpdateOrganizationInput, "id">,
    clerkUpdatedAt: Date
  ): Promise<number> {
    return withDb((db) =>
      db.organization.updateMany({
        where: {
          clerkId,
          OR: [
            { clerkUpdatedAt: null },
            { clerkUpdatedAt: { lt: clerkUpdatedAt } },
          ],
        },
        data: { ...input, clerkUpdatedAt },
      })
    ).then(({ count }) => count);
  },

  /**
   * Deactivate an organization by Clerk ID (soft delete)
   */
  deactivateByClerkId(clerkId: string): Promise<Organization | null> {
    return withDb((db) =>
      db.organization.update({
        where: { clerkId },
        data: { active: false },
        select: ORGANIZATION_PAYLOAD_SELECT,
      })
    ).then(this.toOrganization);
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
  ): Promise<OrganizationIdentity> {
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

      // Returned as identity, not as the created row: `create` resolves the
      // whole payload, and handing that back would make the declared return
      // type narrower than the object callers actually receive.
      return { id: organization.id, clerkId: organization.clerkId };
    } catch (error) {
      // Handle race condition: concurrent requests may both attempt to create
      // the same org. If a unique constraint violation occurs (P2002), the org
      // was created by another request — just fetch it.
      if (getPrismaErrorCode(error) === "P2002") {
        const retried = await organizationsService.findByClerkId(clerkOrgId);
        if (retried) {
          return retried;
        }
      }
      throw error;
    }
  },

  /**
   * Whether the organization exists and is active. `organization.deleted`
   * deactivates the row rather than removing it, so the row existing is not
   * the org being live.
   */
  async isActive(id: string): Promise<boolean> {
    const row = await withDb((db) =>
      db.organization.findUnique({
        where: { id },
        select: { active: true },
      })
    );
    return row?.active === true;
  },
};

/**
 * What an organization lookup on the authenticated path resolves to: the
 * internal id every org-scoped query keys on, and the Clerk id the membership
 * and admin checks key on. Nothing else — a caller needing more asks for the
 * payload read by name.
 */
export type OrganizationIdentity = Pick<Organization, "id" | "clerkId">;

/**
 * Derived from the select clause rather than restated, so the row type cannot
 * drift from the columns the query actually asks for.
 */
type OrganizationPayloadRow = Prisma.OrganizationGetPayload<{
  select: typeof ORGANIZATION_PAYLOAD_SELECT;
}>;

const ORGANIZATION_IDENTITY_SELECT = {
  id: true,
  clerkId: true,
} satisfies Record<keyof OrganizationIdentity, true>;

/**
 * The columns the `Organization` payload is made of, and only those.
 *
 * `GET`/`PUT /organizations/:id` serialize this object straight back to the
 * caller, so a column present on the row is a column present in the HTTP
 * response. The `satisfies` guard is bidirectional — a new
 * `Organization` field fails typecheck here until it is selected, and a column
 * that is not part of the payload cannot be added.
 */
const ORGANIZATION_PAYLOAD_SELECT = {
  id: true,
  clerkId: true,
  name: true,
  slug: true,
  active: true,
  settings: true,
  searchIncludeTranscripts: true,
  createdAt: true,
  updatedAt: true,
} satisfies Record<keyof Organization, true>;
